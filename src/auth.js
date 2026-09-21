const crypto = require('crypto');
const config = require('./config');
const { statements, now, audit } = require('./db');

/*
 * Users, sessions, roles and API keys.
 *
 * Roles (least -> most privilege):
 *   viewer   - dashboards, detail pages, exports
 *   operator - viewer + acknowledge alarms, add notes
 *   admin    - everything: plants/lines/gateways/meters, users, API keys, system
 *
 * Sessions live in SQLite so a restart does not log everyone out. Passwords
 * use scrypt (built into Node, no native dependency). API keys are stored as
 * SHA-256 hashes; the clear key is shown once when created.
 */
const SESSION_COOKIE = 'pc_session';
const ROLES = ['viewer', 'operator', 'admin'];
const rank = (role) => Math.max(0, ROLES.indexOf(role));

const hashPassword = (password, salt = crypto.randomBytes(16).toString('hex')) => ({
  salt,
  hash: crypto.scryptSync(String(password), salt, 64).toString('hex'),
});

const verifyPassword = (password, salt, hash) => {
  const test = crypto.scryptSync(String(password), salt, 64);
  const ref = Buffer.from(hash, 'hex');
  return test.length === ref.length && crypto.timingSafeEqual(test, ref);
};

const readCookie = (req, name) => {
  const header = req.headers.cookie || '';
  for (const part of header.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return v.join('=');
  }
  return null;
};

const sessionTtlMs = () => config.sessionHours * 3600 * 1000;

const createSession = (user, req) => {
  const id = crypto.randomBytes(24).toString('hex');
  statements.createSession.run(id, user.id, Date.now() + sessionTtlMs(), now(),
    req.ip || null, (req.get('user-agent') || '').slice(0, 200));
  return id;
};

const sessionUser = (req) => {
  const id = readCookie(req, SESSION_COOKIE);
  if (!id) return null;
  const s = statements.getSession.get(id);
  if (!s) return null;
  if (Date.now() > s.expires_at || !s.enabled) {
    statements.deleteSession.run(id);
    return null;
  }
  return { id: s.user_id, username: s.username, role: s.role, displayName: s.display_name, sessionId: id };
};

// ---- API keys ----
const hashKey = (key) => crypto.createHash('sha256').update(String(key)).digest('hex');

const createApiKey = (name, scopes, createdBy) => {
  const clear = 'pc_' + crypto.randomBytes(24).toString('hex');
  const info = statements.createApiKey.run(name, hashKey(clear), clear.slice(0, 8), scopes, createdBy, now());
  return { id: info.lastInsertRowid, key: clear };
};

const apiKeyFromRequest = (req) => {
  const raw = req.get('X-Api-Key') || (req.query.api_key ? String(req.query.api_key) : null)
    || ((req.get('authorization') || '').match(/^Bearer\s+(.+)$/i) || [])[1];
  if (!raw) return null;
  const row = statements.getApiKeyByHash.get(hashKey(raw));
  if (!row || !row.enabled) return null;
  statements.touchApiKey.run(now(), row.id);
  return { id: row.id, name: row.name, scopes: row.scopes.split(',').map((s) => s.trim()) };
};

// ---- middleware ----
// Attaches req.user (session) - redirects browsers to /login, 401 for API calls.
const requireAuth = (req, res, next) => {
  const user = sessionUser(req);
  if (user) {
    req.user = user;
    return next();
  }
  if (req.originalUrl.startsWith('/api/')) {
    return res.status(401).json({ success: false, error: 'unauthorized' });
  }
  return res.redirect('/login');
};

const requireRole = (minRole) => (req, res, next) => {
  if (!req.user || rank(req.user.role) < rank(minRole)) {
    return res.status(403).json({ success: false, error: 'forbidden: requires ' + minRole });
  }
  return next();
};

// Public API: API key with the scope, or a logged-in session (so the docs page can try calls).
const requireApiKey = (scope) => (req, res, next) => {
  const key = apiKeyFromRequest(req);
  if (key) {
    if (scope && !key.scopes.includes(scope) && !key.scopes.includes('all')) {
      return res.status(403).json({ success: false, error: `api key lacks scope "${scope}"` });
    }
    req.apiKey = key;
    return next();
  }
  const user = sessionUser(req);
  if (user) {
    if (scope === 'write' && rank(user.role) < rank('operator')) {
      return res.status(403).json({ success: false, error: 'forbidden' });
    }
    req.user = user;
    return next();
  }
  return res.status(401).json({ success: false, error: 'unauthorized: send X-Api-Key' });
};

// ---- login / logout endpoints ----
// brute-force brake: 8 failed attempts per IP+user in 10 minutes
const failures = new Map();
const FAIL_LIMIT = 8;
const FAIL_WINDOW_MS = 10 * 60 * 1000;
const failKey = (req, username) => `${req.ip}|${String(username || '').trim().toLowerCase()}`;
const tooManyFailures = (key) => {
  const f = failures.get(key);
  if (!f) return false;
  if (Date.now() - f.first > FAIL_WINDOW_MS) { failures.delete(key); return false; }
  return f.n >= FAIL_LIMIT;
};
const noteFailure = (key) => {
  const f = failures.get(key);
  if (!f || Date.now() - f.first > FAIL_WINDOW_MS) failures.set(key, { first: Date.now(), n: 1 });
  else f.n += 1;
};

const login = (req, res) => {
  const { username, password } = req.body || {};
  const key = failKey(req, username);
  if (tooManyFailures(key)) {
    return res.status(429).json({ success: false, error: 'too many attempts, try again in 10 minutes' });
  }
  const row = statements.getUserByName.get(String(username || '').trim());
  if (!row || !row.enabled || !verifyPassword(password || '', row.salt, row.password_hash)) {
    noteFailure(key);
    return res.status(401).json({ success: false, error: 'invalid credentials' });
  }
  failures.delete(key);
  const id = createSession(row, req);
  statements.touchLogin.run(now(), row.id);
  audit({ id: row.id, username: row.username }, 'login', null, req.ip);
  res.setHeader('Set-Cookie',
    `${SESSION_COOKIE}=${id}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${sessionTtlMs() / 1000}`);
  return res.json({ success: true, user: { username: row.username, role: row.role, displayName: row.display_name } });
};

const logout = (req, res) => {
  const id = readCookie(req, SESSION_COOKIE);
  if (id) statements.deleteSession.run(id);
  res.setHeader('Set-Cookie', `${SESSION_COOKIE}=; HttpOnly; Path=/; Max-Age=0`);
  return res.json({ success: true });
};

// First run: create the admin from .env when there are no users at all
const ensureAdmin = () => {
  if (statements.countUsers.get().n > 0) return false;
  const { salt, hash } = hashPassword(config.adminPass);
  statements.createUser.run(config.adminUser, hash, salt, 'admin', 'Administrator', now());
  console.log(`auth: created admin user "${config.adminUser}" (password from ADMIN_PASS)`);
  return true;
};

module.exports = {
  ROLES, rank, hashPassword, verifyPassword, sessionUser, createApiKey, apiKeyFromRequest,
  requireAuth, requireRole, requireApiKey, login, logout, ensureAdmin, SESSION_COOKIE,
};

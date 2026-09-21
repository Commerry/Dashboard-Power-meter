#!/usr/bin/env node
/*
 * User management from the command line (when nobody can log in any more).
 *
 *   npm run user:add -- <username> <password> [role]      role: viewer | operator | admin
 *   npm run user:passwd -- <username> <newpassword>
 *   node src/tools/user.js list
 */
const { statements, now } = require('../db');
const auth = require('../auth');

const [cmd, username, password, role = 'admin'] = process.argv.slice(2);

const usage = () => {
  console.log('usage: user.js add <username> <password> [viewer|operator|admin]');
  console.log('       user.js passwd <username> <newpassword>');
  console.log('       user.js list');
  process.exit(1);
};

if (cmd === 'list') {
  for (const u of statements.listUsers.all()) console.log(`${u.username.padEnd(20)} ${u.role.padEnd(9)} ${u.enabled ? 'active' : 'disabled'}  last login ${u.last_login || '-'}`);
} else if (cmd === 'add') {
  if (!username || !password || !auth.ROLES.includes(role)) usage();
  const { salt, hash } = auth.hashPassword(password);
  try {
    statements.createUser.run(username, hash, salt, role, username, now());
    console.log(`created ${role} "${username}"`);
  } catch (e) {
    console.error('failed:', /UNIQUE/.test(e.message) ? 'username already exists' : e.message);
    process.exit(1);
  }
} else if (cmd === 'passwd') {
  if (!username || !password) usage();
  const u = statements.getUserByName.get(username);
  if (!u) { console.error('no such user'); process.exit(1); }
  const { salt, hash } = auth.hashPassword(password);
  statements.setPassword.run(hash, salt, u.id);
  statements.deleteUserSessions.run(u.id);
  console.log(`password updated for "${username}" (all sessions logged out)`);
} else {
  usage();
}

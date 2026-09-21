const path = require('path');
const http = require('http');
const express = require('express');
const config = require('./config');
const auth = require('./auth');
const views = require('./views');
const { AlarmEngine } = require('./alarms');
const { Poller } = require('./poller');
const { Store } = require('./store');
const { Realtime } = require('./realtime');
const { DemandController } = require('./demand');
const { seedDemo, seedPlc } = require('./seed');
const apiRoutes = require('./routes/api');
const adminRoutes = require('./routes/admin');
const v1Routes = require('./routes/v1');

/*
 * Power Center - bootstrap.
 *
 *   /login, /api/login, /api/logout, /api/settings   public
 *   /api/v1/*                                        API key (public API + ingest)
 *   /api/*                                           session (dashboard)
 *   /api/admin/*                                     session + admin role
 *   /ws                                              websocket (session or api key)
 *   /*                                               dashboard static files (session)
 */
const app = express();
app.disable('x-powered-by');
app.set('trust proxy', true);
app.use(express.json({ limit: '2mb' }));

// first run: admin account + optional demo data
auth.ensureAdmin();
seedPlc();
if (config.seedDemo) seedDemo();

const alarms = new AlarmEngine();
const poller = new Poller({ alarms });
const store = new Store(poller, alarms);
const demand = new DemandController({ poller, alarms });
views.attach(poller, alarms);
app.locals.poller = poller;
app.locals.alarms = alarms;
app.locals.demand = demand;

// public
app.get('/login', (req, res) => res.sendFile(path.join(__dirname, 'public', 'login.html')));
app.use('/img', express.static(path.join(__dirname, 'public', 'img')));
app.use('/css', express.static(path.join(__dirname, 'public', 'css')));
app.post('/api/login', auth.login);
app.post('/api/logout', auth.logout);
app.get('/api/settings', (req, res) => res.json({
  success: true,
  settings: { siteName: config.siteName, siteSubtitle: config.siteSubtitle },
}));

// uPlot + DSEG7 (LCD digits) from node_modules so the dashboard works without internet
app.use('/vendor/uplot', express.static(path.join(__dirname, '..', 'node_modules', 'uplot', 'dist')));
app.use('/vendor/dseg', express.static(path.join(__dirname, '..', 'node_modules', 'dseg', 'fonts', 'DSEG7-Classic')));
// S7 address parser shared with the PLC settings page
app.get('/js/s7addr.js', auth.requireAuth, (req, res) => res.sendFile(path.join(__dirname, 's7addr.js')));

// public API (api key)
app.use('/api/v1', v1Routes);

// dashboard API + admin API + the dashboard itself (session)
app.use('/api/admin', auth.requireAuth, adminRoutes);
app.use('/api', auth.requireAuth, apiRoutes);
app.use('/', auth.requireAuth, express.static(path.join(__dirname, 'public')));

// API 404 as JSON, everything else falls through to the SPA
app.use('/api', (req, res) => res.status(404).json({ success: false, error: 'not found' }));
app.get('*', auth.requireAuth, (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error('unhandled:', err.message);
  if (res.headersSent) return;
  res.status(500).json({ success: false, error: err.message });
});

const server = http.createServer(app);
const realtime = new Realtime({ server, poller, alarms, demand });
app.locals.realtime = realtime;

const start = async () => {
  store.start();
  await poller.start();
  demand.start();
  server.listen(config.port, '0.0.0.0', () => {
    console.log(`${config.siteName} listening on 0.0.0.0:${config.port}`);
    console.log(`Dashboard : http://localhost:${config.port}`);
    console.log(`Public API: http://<this-pc>:${config.port}/api/v1  (X-Api-Key)`);
    console.log(`Ingest    : POST http://<this-pc>:${config.port}/api/v1/ingest`);
    console.log(`Gateways  : ${poller.workers.size} running, meters: ${poller.meterIndex.size}, demand groups: ${demand.groups.size}`);
  });
};

const shutdown = async () => {
  console.log('shutting down...');
  demand.stop();
  await poller.stop();
  store.stop();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

start().catch((e) => {
  console.error('startup failed:', e);
  process.exit(1);
});

/*
 * `npm run dev` - restart-on-change server on the development port.
 *
 * Production (`npm start` / pm2) listens on PORT (64088); this runs the same
 * server on DEV_PORT (64089) so both can run side by side on one machine.
 */
const { spawn } = require('child_process');
const path = require('path');

require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });

const port = process.env.DEV_PORT || '64089';
const child = spawn(process.execPath, ['--watch', path.join(__dirname, '..', 'server.js')], {
  stdio: 'inherit',
  env: { ...process.env, PORT: port },
});
child.on('exit', (code) => process.exit(code ?? 0));

require('dotenv').config();

/*
 * All runtime configuration in one place. Everything comes from .env with a
 * sane default, so the server starts on a bare checkout.
 */
const int = (key, def) => {
  const v = parseInt(process.env[key], 10);
  return Number.isFinite(v) ? v : def;
};
const str = (key, def = '') => (process.env[key] === undefined ? def : String(process.env[key]));
const bool = (key, def) => {
  const v = (process.env[key] || '').trim().toLowerCase();
  if (!v) return def;
  return v === '1' || v === 'true' || v === 'yes' || v === 'on';
};

module.exports = {
  port: int('PORT', 64088),
  devPort: int('DEV_PORT', 64089),
  siteName: str('SITE_NAME', 'POWER CENTER'),
  siteSubtitle: str('SITE_SUBTITLE', 'PSE Energy Monitor'),
  adminUser: str('ADMIN_USER', 'admin'),
  adminPass: str('ADMIN_PASS', 'admin'),
  seedDemo: bool('SEED_DEMO', false),
  seedPlcIps: str('SEED_PLC_IPS', '10.22.181.12,10.22.181.19,10.22.181.26'),
  sessionHours: int('SESSION_HOURS', 12),
  tz: str('REPORT_TZ', 'Asia/Bangkok'),

  defaultPollMs: int('DEFAULT_POLL_MS', 2000),
  storeIntervalSec: int('STORE_INTERVAL_SEC', 30),
  offlineAfterSec: int('OFFLINE_AFTER_SEC', 30),
  gatewayStatsSec: int('GATEWAY_STATS_SEC', 60),

  keep: {
    samplesDays: int('SAMPLES_KEEP_DAYS', 90),
    hourlyDays: int('HOURLY_KEEP_DAYS', 730),
    eventsDays: int('EVENTS_KEEP_DAYS', 365),
    gatewayStatsDays: int('GATEWAY_STATS_KEEP_DAYS', 30),
    auditDays: int('AUDIT_KEEP_DAYS', 365),
  },

  mqttPublish: {
    url: str('MQTT_PUBLISH_URL', ''),
    prefix: str('MQTT_PUBLISH_PREFIX', 'powercenter'),
    username: str('MQTT_USERNAME', ''),
    password: str('MQTT_PASSWORD', ''),
  },
  alarmWebhookUrl: str('ALARM_WEBHOOK_URL', ''),
};

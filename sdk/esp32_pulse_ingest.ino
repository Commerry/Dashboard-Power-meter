/*
 * ESP32 kWh pulse counter -> Power Center ingest
 *
 * Counts S0 / LED pulses from an energy meter (e.g. 1000 imp/kWh) and POSTs
 * cumulative kWh + instantaneous kW to /api/v1/ingest every REPORT_SEC.
 *
 * Power Center side:
 *   1. Settings > Gateways: add a gateway of type "push" (optional, for traffic stats)
 *   2. Settings > Meters: add meter, template "pulse-counter", code = METER_CODE, gateway = push gateway
 *   3. Settings > API keys: create a key with scope "ingest"
 *
 * Libraries: WiFi, HTTPClient (bundled with the ESP32 Arduino core)
 */
#include <WiFi.h>
#include <HTTPClient.h>

const char* WIFI_SSID   = "factory-wifi";
const char* WIFI_PASS   = "password";
const char* SERVER_URL  = "http://10.10.0.5:8095/api/v1/ingest";
const char* API_KEY     = "pc_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx";
const char* METER_CODE  = "PULSE-01";

const int   PULSE_PIN    = 27;      // S0 input (use optocoupler / pull-up as required)
const float IMP_PER_KWH  = 1000.0;  // from the meter label
const int   REPORT_SEC   = 10;

volatile unsigned long pulseCount = 0;
volatile unsigned long lastPulseUs = 0;
volatile unsigned long lastIntervalUs = 0;

void IRAM_ATTR onPulse() {
  unsigned long now = micros();
  if (now - lastPulseUs < 20000) return;      // 20 ms debounce
  lastIntervalUs = now - lastPulseUs;
  lastPulseUs = now;
  pulseCount++;
}

void setup() {
  Serial.begin(115200);
  pinMode(PULSE_PIN, INPUT_PULLUP);
  attachInterrupt(digitalPinToInterrupt(PULSE_PIN), onPulse, FALLING);
  WiFi.begin(WIFI_SSID, WIFI_PASS);
  while (WiFi.status() != WL_CONNECTED) { delay(500); Serial.print("."); }
  Serial.println("\nWiFi connected: " + WiFi.localIP().toString());
}

void loop() {
  static unsigned long lastReport = 0;
  if (millis() - lastReport < (unsigned long)REPORT_SEC * 1000) { delay(50); return; }
  lastReport = millis();

  noInterrupts();
  unsigned long pulses = pulseCount;
  unsigned long intervalUs = lastIntervalUs;
  unsigned long sinceLastUs = micros() - lastPulseUs;
  interrupts();

  float kwh = pulses / IMP_PER_KWH;
  // instantaneous kW from the last pulse interval; zero when no pulse for 60 s
  float kw = 0;
  if (intervalUs > 0 && sinceLastUs < 60000000UL) kw = 3600.0f / ((intervalUs / 1000000.0f) * IMP_PER_KWH);

  if (WiFi.status() != WL_CONNECTED) { WiFi.reconnect(); return; }
  HTTPClient http;
  http.begin(SERVER_URL);
  http.addHeader("Content-Type", "application/json");
  http.addHeader("X-Api-Key", API_KEY);
  String body = String("{\"meter\":\"") + METER_CODE + "\",\"values\":{\"kwh_import\":" + String(kwh, 3) + ",\"p_total\":" + String(kw, 3) + "}}";
  int code = http.POST(body);
  Serial.printf("POST %d  kwh=%.3f kw=%.3f  %s\n", code, kwh, kw, code == 200 ? "" : http.getString().c_str());
  http.end();
}

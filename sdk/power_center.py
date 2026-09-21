"""
Power Center client for Python 3.8+ (standard library only).

    from power_center import PowerCenter
    pc = PowerCenter("http://server:8095", "pc_xxxx")
    print(pc.latest("L1-PM01")["values"]["p_total"])
    rows = pc.history("L1-PM01", from_ms=..., to_ms=..., interval=900, keys=["p_total", "v_ln_avg"])
    pc.ingest("PULSE-01", {"kwh_import": 1200.5, "p_total": 3.1})

Export to pandas:
    import pandas as pd
    df = pd.DataFrame(pc.history(1, interval=900)["rows"])
    df["at"] = pd.to_datetime(df["at"], unit="ms", utc=True).dt.tz_convert("Asia/Bangkok")
"""
import json
import time
import urllib.parse
import urllib.request
import urllib.error


class PowerCenterError(Exception):
    def __init__(self, status, message, body=None):
        super().__init__(f"{status}: {message}")
        self.status = status
        self.body = body


class PowerCenter:
    def __init__(self, base_url, api_key, timeout=10):
        self.base = base_url.rstrip("/") + "/api/v1"
        self.key = api_key
        self.timeout = timeout

    def _request(self, path, method="GET", body=None, query=None):
        url = self.base + path
        if query:
            q = {k: (",".join(map(str, v)) if isinstance(v, (list, tuple)) else v) for k, v in query.items() if v is not None}
            if q:
                url += "?" + urllib.parse.urlencode(q)
        data = json.dumps(body).encode("utf-8") if body is not None else None
        req = urllib.request.Request(url, data=data, method=method)
        req.add_header("X-Api-Key", self.key)
        if data is not None:
            req.add_header("Content-Type", "application/json")
        try:
            with urllib.request.urlopen(req, timeout=self.timeout) as res:
                payload = json.loads(res.read().decode("utf-8"))
        except urllib.error.HTTPError as e:
            try:
                payload = json.loads(e.read().decode("utf-8"))
            except Exception:
                payload = {}
            raise PowerCenterError(e.code, payload.get("error", str(e)), payload)
        if payload.get("success") is False:
            raise PowerCenterError(200, payload.get("error", "request failed"), payload)
        return payload

    # ---- read ----
    def ping(self):
        return self._request("/ping")

    def metrics(self):
        return self._request("/metrics")["metrics"]

    def plants(self):
        return self._request("/plants")

    def gateways(self):
        return self._request("/gateways")["gateways"]

    def meters(self, plant_id=None, line_id=None, values=True):
        return self._request("/meters", query={"plantId": plant_id, "lineId": line_id, "values": None if values else 0})["meters"]

    def meter(self, id_or_code):
        return self._request(f"/meters/{urllib.parse.quote(str(id_or_code))}")["meter"]

    def latest(self, id_or_code):
        return self._request(f"/meters/{urllib.parse.quote(str(id_or_code))}/latest")

    def history(self, id_or_code, from_ms=None, to_ms=None, interval="raw", keys=None, limit=None):
        return self._request(f"/meters/{urllib.parse.quote(str(id_or_code))}/history",
                             query={"from": from_ms, "to": to_ms, "interval": interval, "keys": keys, "limit": limit})

    def summary(self, id_or_code, from_ms=None, to_ms=None):
        return self._request(f"/meters/{urllib.parse.quote(str(id_or_code))}/summary", query={"from": from_ms, "to": to_ms})

    def hourly(self, id_or_code, from_ms=None, to_ms=None):
        return self._request(f"/meters/{urllib.parse.quote(str(id_or_code))}/hourly", query={"from": from_ms, "to": to_ms})["rows"]

    def events(self, **query):
        return self._request("/events", query=query)["events"]

    def active_events(self):
        return self._request("/events/active")["events"]

    # ---- peak demand ----
    def demand(self):
        return self._request("/demand")

    def demand_group(self, group_id, from_ms=None, to_ms=None):
        return self._request(f"/demand/{group_id}", query={"from": from_ms, "to": to_ms})

    def demand_auto(self, group_id, auto):
        return self._request(f"/demand/{group_id}/auto", method="POST", body={"auto": bool(auto)})

    def demand_stage(self, group_id, stage_id, action):
        return self._request(f"/demand/{group_id}/stages/{stage_id}/{action}", method="POST", body={})

    # ---- write ----
    def ack(self, event_id, note=""):
        return self._request(f"/events/{event_id}/ack", method="POST", body={"note": note})

    # ---- ingest ----
    def ingest(self, meter, values, at_ms=None):
        return self._request("/ingest", method="POST", body={"meter": meter, "values": values, "at": at_ms})

    def ingest_raw(self, meter, data, at_ms=None):
        return self._request("/ingest", method="POST", body={"meter": meter, "data": data, "at": at_ms})

    def ingest_batch(self, readings):
        return self._request("/ingest", method="POST", body={"readings": readings})


if __name__ == "__main__":
    import sys
    if len(sys.argv) < 3:
        print("usage: python power_center.py <base_url> <api_key> [meter]")
        sys.exit(1)
    pc = PowerCenter(sys.argv[1], sys.argv[2])
    print(pc.ping())
    if len(sys.argv) > 3:
        print(json.dumps(pc.latest(sys.argv[3]), indent=2, ensure_ascii=False))
    else:
        for m in pc.meters(values=False):
            print(f'{m["id"]:4} {m["name"]:20} {m["status"]:8} {m.get("plantName") or "-"} / {m.get("lineName") or "-"}')

"""Summarise the latest phone capture: telemetry lines (.capture-live.jsonl) + the screenshot nearest each event."""
import json, os, sys, datetime, glob
LIVE = "/Users/anand/Downloads/rea/nazariya/.capture-live.jsonl"
SHOTS = os.path.join(os.path.dirname(__file__), "live")
n = int(sys.argv[1]) if len(sys.argv) > 1 else 40
rows = [json.loads(l) for l in open(LIVE)] if os.path.exists(LIVE) else []
shots = sorted(glob.glob(os.path.join(SHOTS, "*.jpg")))
def nearest(ts):
    t = ts.astimezone().strftime("%H%M%S")
    best = min(shots, key=lambda p: abs(int(os.path.basename(p)[:6]) - int(t)), default=None)
    return os.path.basename(best) if best else "-"
for r in rows[-n:]:
    ts = datetime.datetime.fromisoformat(r["server"].replace("Z", "+00:00"))
    keys = ["mode","event","shots","nextTarget","ring","aimDeg","rollDeg","wanderDeg","offSpotCm","blocked","busyMs","failures","lastFailure","recentred","gateAgeMs","frameCalls","earlyReturn","latencyMs","sensorHz","error"]
    print(ts.astimezone().strftime("%H:%M:%S"), nearest(ts), " ".join(f"{k}={r[k]}" for k in keys if k in r and r[k] not in (None, "", 0, {})), "xr="+str(r.get("xr")) if r.get("xr") else "")

#!/usr/bin/env bash
# Grab the phone screen once a second over Wi-Fi adb while the Nazariya capture runs; keep a small JPEG
# per second (timestamped, IST) so the frames can be lined up with the phone's diagnostics.
S="$(dirname "$0")"; DEV=192.168.1.3:5555; mkdir -p "$S/live"
while true; do
  ts=$(date +%H%M%S)
  # Only while Chrome is the app on screen (never the lock screen, notifications or other apps).
  if ! adb -s $DEV shell dumpsys window 2>/dev/null | grep -m1 -E "mCurrentFocus|mFocusedApp" | grep -q "com.android.chrome"; then sleep 1; continue; fi
  if adb -s $DEV exec-out screencap -p > "$S/live/raw.png" 2>/dev/null && [ -s "$S/live/raw.png" ]; then
    sips -s format jpeg -s formatOptions 55 -Z 800 "$S/live/raw.png" --out "$S/live/$ts.jpg" >/dev/null 2>&1
  fi
  ls -1t "$S/live"/*.jpg 2>/dev/null | tail -n +901 | xargs rm -f 2>/dev/null   # keep the last 15 minutes
  sleep 1
done

# Reconstruction evaluation tools

Scripts used to test the 3D pipeline (Oct 2026). Rebuilt from the session that wrote them after their temporary folder was wiped.

**Scoring a splat against real photos**
- `render.mjs` + `index.html`: render a splat PLY from COLMAP camera poses in headless Chrome (Spark) and compare each render with the real frame (PSNR).
  - Usage: `node render.mjs <scene.ply> <colmap_txt_dir> <images_dir> <out.jpg>`
  - Env options:
    - `EVAL_LIST=<names.txt>`: score only these, usually held-out frames;
    - `SHEET=<n>`: tiles in the contact sheet (0 = scores only);
    - `PSNR_OUT=<file.json>`: per-image scores;
    - `NOVEL_POSES=<poses.json>`: render new viewpoints instead.
  - Needs a free local port (8765) and Chrome. Inside the Claude Code sandbox, run it with the sandbox off.
- `analyze_splat.py <scene.ply> <images.txt>`: splat count, opacity and size, floaters outside the walked area, scene extent. Needs numpy.

**360° camera A/B test** (all 12 directions vs forward-only, same poses, held-out 1 frame in 8)
- `ab_test.sh <colmap_workspace>`: workspace with `images/` and `sparse/0`.
- `run_indoor.sh <workspace>`: full pipeline from `eq/` equirect frames. It runs these steps: `../pano_rig.py` views, COLMAP rig, then train A and B with Brush, then score both.
  - Uses the faster COLMAP settings: overlap 4, 4096 features.
- `remotezip.py <zip_url> list | extract <prefix> <outdir>`: fetch only part of a large public dataset ZIP.

**Live phone diagnosis** (Nothing Phone over Wi-Fi adb, 192.168.1.3:5555)
- `cdp-proxy.mjs`: exposes phone Chrome DevTools (adb-forwarded to 9333) on 9334 in the form REA accepts.
- `live-screens.sh`: one screenshot per second, only while Chrome is on screen, saved to `live/` (git-ignored).
- `live-report.py [n]`: joins `../../.capture-live.jsonl` telemetry with the nearest screenshot.

# True 3D walkthroughs (GPU worker)

Nazariya turns a recorded walk through a home into a real 3D scene (Gaussian splats) on a GPU machine.
The web server never needs a GPU: it calls `NAZARIYA_RECON_CMD <inputDir> <outDir>` from the worker and
imports `<outDir>/scene.ply|spz` like any uploaded scan.

| Input | Where it comes from | What the GPU worker does |
|---|---|---|
| `images/` + `transforms.json` | Depth mode on Android (AR camera poses, metres, y up) | Trains directly (poses known, real scale) |
| `*.jpg` frames | A walkthrough **video** upload | COLMAP recovers poses first, then trains |

## RunPod (production route)

`NAZARIYA_RECON_CMD=/path/to/recon/runpod.sh` with `RUNPOD_API_KEY` set. Each job creates an on-demand pod
from the pinned nerfstudio image (CUDA COLMAP + splatfacto; RTX 4090 / L4 / A40 / A4500 / A5000), copies the
frames and `gpu.sh` up over SSH with a throwaway key, runs, copies `scene.ply` + `transform.json` back and deletes
the pod. The pod also deletes itself after `RUNPOD_MAX_MINUTES` (default 240) if this machine goes away.

## Kaggle (free, testing only)

`NAZARIYA_RECON_CMD=/path/to/recon/kaggle.sh` with `KAGGLE_API_TOKEN` + `KAGGLE_USERNAME` and the Kaggle CLI ≥ 2
(`tools/kaggle-venv`). COLMAP runs on this Mac; the frames + poses go up as a **private** dataset and
`kaggle_train.py` trains them with gsplat on a T4, then the dataset and kernel are deleted (`RECON_KEEP_KAGGLE=1`
keeps them for debugging). `stats.json` holds held-out PSNR/SSIM/LPIPS (every 8th frame); `compare.jpg` and
`renders/` show those held-out frames, real | 3D render. Training uses gsplat's MCMC strategy (1M splats), which
beat the default strategy on held-out quality with fewer floaters. Not for customer data. A 2-minute walkthrough takes about
40 min end to end (COLMAP on an M1 ~13 min, Kaggle ~25 min).

`clean_splats.py` is a measuring tool: `evaluate()` scores a scene on the held-out frames, and the floater rules
(near the walk, free-space carving) report what they would remove. Not in the pipeline: on the Oct 2026 test every
setting lowered held-out quality and carving cut holes in real walls.

## Run it on a rented GPU (any provider, Docker)

1. Rent a machine with an NVIDIA GPU (24 GB is comfortable; e.g. RTX 4090 / A10 / A100) with Docker and the
   NVIDIA Container Toolkit. Any provider works (RunPod, Lambda, Vast.ai, E2E Networks, AWS g5/g6).
2. On it: `git clone` this repo (or copy `recon/`), then `docker build -t nazariya-recon recon/`.
3. On the Nazariya worker server:
   ```bash
   export RECON_HOST=user@your-gpu-box        # SSH key access
   export NAZARIYA_RECON_CMD=/srv/nazariya/recon/remote.sh
   npm run worker
   ```
4. Capture in depth mode with "Record the walk for true 3D" switched on, then tap "Finish house capture".
   The space gets a **3D walkthrough** room. It shows photos at once and the real 3D once the GPU job finishes.

Running the worker directly on a GPU machine: `NAZARIYA_RECON_CMD=/path/to/recon/run.sh` (nerfstudio installed).

No GPU? On an Apple-silicon Mac, `NAZARIYA_RECON_CMD=/path/to/recon/local-mac.sh` uses COLMAP (CPU) for camera
poses and Brush (Apache-2.0, Metal GPU) for training. Setup: `brew install colmap`, download the Brush release
for `aarch64-apple-darwin`, set `BRUSH_BIN`. Slower (tens of minutes per room) but free.

## Notes
- Typical cost: 10–25 GPU-minutes per 2BHK. Hourly prices vary by provider. Measure with your own captures before quoting.
- Quality depends on the capture: walk slowly, keep lights on, avoid mirrors and moving people.
- Depth-mode scenes keep real-world scale (metres) because the poses come from AR tracking. Video-only scenes
  have arbitrary scale.
- `transform.json` also lists the walked path (every camera centre); the 3D viewer keeps visitors within 0.5 m of
  it, because a splat scene is only sharp near where the phone was.
- Not tested on a GPU in this repository's CI (no GPU here). The contract (dataset in, scene out) is covered
  by tests with a fake worker.

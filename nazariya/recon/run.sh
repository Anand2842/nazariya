#!/usr/bin/env bash
# Nazariya reconstruction worker: <inputDir> <outDir>  →  <outDir>/scene.ply
#
# Runs on a machine with an NVIDIA GPU and nerfstudio (use the Dockerfile here, or `pip install nerfstudio`).
#  • Depth-mode walkthroughs arrive as a nerfstudio dataset (images/ + transforms.json with AR camera poses,
#    metres, y up). Poses are known, so structure-from-motion is skipped and the scene keeps real-world scale.
#  • Plain walkthrough videos arrive as frames (*.jpg). COLMAP (via ns-process-data) recovers the poses first.
# Training: nerfstudio "splatfacto" (Gaussian splatting, gsplat backend). Typical: 10–25 min for a 2BHK on one
# RTX 4090 / A100.
set -euo pipefail
IN="$1"
OUT="$2"
ITERS="${RECON_ITERS:-15000}"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

if [ -f "$IN/transforms.json" ]; then
  DATA="$IN"
  # Keep the AR frame: no re-orientation, re-centring or re-scaling.
  PARSER=(nerfstudio-data --orientation-method none --center-method none --auto-scale-poses False)
else
  ns-process-data images --data "$IN" --output-dir "$WORK/data" --matching-method sequential
  DATA="$WORK/data"
  PARSER=(nerfstudio-data)
fi

ns-train splatfacto \
  --data "$DATA" \
  --output-dir "$WORK/runs" \
  --max-num-iterations "$ITERS" \
  --viewer.quit-on-train-completion True \
  --pipeline.model.cull-alpha-thresh 0.005 \
  "${PARSER[@]}"

CONFIG="$(find "$WORK/runs" -name config.yml | head -1)"
ns-export gaussian-splat --load-config "$CONFIG" --output-dir "$WORK/export"
cp "$WORK/export/splat.ply" "$OUT/scene.ply"
echo "scene written to $OUT/scene.ply"

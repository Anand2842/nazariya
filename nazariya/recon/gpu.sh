#!/usr/bin/env bash
# Nazariya reconstruction on an NVIDIA GPU box: <inputDir> <outDir> → <outDir>/scene.ply (+ transform.json)
#
# The CUDA twin of local-mac.sh, made for the nerfstudio image (CUDA 11.8, COLMAP 3.x built with CUDA,
# nerfstudio splatfacto on gsplat). runpod.sh copies this script and align_colmap.py next to each other on the pod.
#  • Walkthrough frames (*.jpg): COLMAP (GPU SIFT, sequential matching) → drop weakly placed frames →
#    upright/real-size transform → splatfacto.
#  • Depth-mode datasets (images/ + transforms.json with AR poses) train directly in the AR frame.
set -euo pipefail
IN="$1"
OUT="$2"
ITERS="${RECON_ITERS:-15000}"
MIN_POINTS="${RECON_MIN_FRAME_POINTS:-100}"
HERE="$(cd "$(dirname "$0")" && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
mkdir -p "$OUT"

if [ -f "$IN/transforms.json" ]; then
  DATA="$IN"
  PARSER=(nerfstudio-data --orientation-method none --center-method none --auto-scale-poses False)
else
  mkdir -p "$WORK/images" "$WORK/sparse"
  cp "$IN"/*.jpg "$WORK/images/"
  colmap feature_extractor --database_path "$WORK/db.db" --image_path "$WORK/images" \
    --ImageReader.single_camera 1 --ImageReader.camera_model OPENCV \
    --SiftExtraction.max_image_size 1600 --SiftExtraction.use_gpu 1
  colmap sequential_matcher --database_path "$WORK/db.db" --SiftMatching.use_gpu 1 --SequentialMatching.overlap 12
  colmap mapper --database_path "$WORK/db.db" --image_path "$WORK/images" --output_path "$WORK/sparse"
  # The model with the most registered frames, not just the first one COLMAP wrote.
  MODEL=""; BEST=0
  for m in "$WORK"/sparse/*/; do
    n=$(colmap model_analyzer --path "$m" 2>&1 | awk '/Registered images/ {print $NF}')
    if [ "${n:-0}" -gt "$BEST" ]; then BEST=$n; MODEL=$m; fi
  done
  [ -n "$MODEL" ] || { echo "COLMAP placed no frames" >&2; exit 1; }
  echo "COLMAP registered $BEST of $(ls "$WORK/images" | wc -l | tr -d ' ') frames"
  colmap image_undistorter --image_path "$WORK/images" --input_path "$MODEL" --output_path "$WORK/undist" --output_type COLMAP
  mkdir -p "$WORK/undist/sparse/0" && mv "$WORK"/undist/sparse/*.bin "$WORK/undist/sparse/0/" 2>/dev/null || true
  # Frames that see few 3D points are often placed wrongly and add ghost copies of the room: drop them.
  mkdir -p "$WORK/txt" && colmap model_converter --input_path "$WORK/undist/sparse/0" --output_path "$WORK/txt" --output_type TXT
  awk -v min="$MIN_POINTS" '!/^#/ { if (n % 2 == 0) { name = $NF } else { c = 0; for (i = 3; i <= NF; i += 3) if ($i != -1) c++; if (c < min) print name } n++ }' "$WORK/txt/images.txt" > "$WORK/weak.txt"
  echo "dropping $(wc -l < "$WORK/weak.txt" | tr -d ' ') weakly placed frames"
  mkdir -p "$WORK/clean/colmap/sparse/0"
  colmap image_deleter --input_path "$WORK/undist/sparse/0" --output_path "$WORK/clean/colmap/sparse/0" --image_names_path "$WORK/weak.txt"
  ln -s "$WORK/undist/images" "$WORK/clean/images"
  mkdir -p "$WORK/clean_txt" && colmap model_converter --input_path "$WORK/clean/colmap/sparse/0" --output_path "$WORK/clean_txt" --output_type TXT
  python3 "$HERE/align_colmap.py" "$WORK/clean_txt" "$OUT/transform.json" || true
  DATA="$WORK/clean"
  # Train in COLMAP's own frame so transform.json (computed in that frame) still applies to the exported splats.
  PARSER=(colmap --orientation-method none --center-method none --auto-scale-poses False)
  # Newer nerfstudio also swaps COLMAP's axes by default; keep them as they are.
  if ns-train splatfacto colmap --help 2>/dev/null | grep -q assume-colmap-world-coordinate-convention; then
    PARSER+=(--assume-colmap-world-coordinate-convention False)
  fi
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

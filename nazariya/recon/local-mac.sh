#!/usr/bin/env bash
# Nazariya reconstruction worker for an Apple-silicon Mac (no NVIDIA GPU): <inputDir> <outDir> → <outDir>/scene.ply
#
# Same contract as run.sh (plus an optional <outDir>/transform.json), different tools:
#  • COLMAP (CPU) recovers camera poses from plain walkthrough frames (*.jpg).
#  • Brush (Apache-2.0, trains Gaussian splats on the Mac GPU through Metal) trains the scene.
# Depth-mode datasets (images/ + transforms.json with AR poses) go straight to Brush.
# Slower than a rented GPU (expect 20–60 min for one room), but free and private.
#
# Setup: brew install colmap (4.x); download the Brush release for aarch64-apple-darwin and set BRUSH_BIN.
set -euo pipefail
IN="$1"
OUT="$2"
BRUSH="${BRUSH_BIN:-$HOME/Downloads/rea/tools/brush/brush-app-aarch64-apple-darwin/brush_app}"
STEPS="${RECON_ITERS:-6000}"
MIN_POINTS="${RECON_MIN_FRAME_POINTS:-100}"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/nz-recon.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT

if [ -f "$IN/transforms.json" ]; then
  DATA="$IN"
else
  mkdir -p "$WORK/images" "$WORK/sparse"
  # A glob, not `ls | head`: with pipefail, head closing the pipe early kills the script (SIGPIPE).
  FRAMES=("$IN"/*.jpg)
  FIRST="${FRAMES[0]}"
  IFS=, read -r FW FH < <(ffprobe -v error -select_streams v:0 -show_entries stream=width,height -of csv=p=0 "$FIRST")
  if [ "$FW" -eq $((FH * 2)) ]; then
    # 360° camera (equirectangular frames): cut every frame into 12 fixed views and treat them as one camera rig
    # whose relative rotations are exact, so COLMAP solves one pose per moment and every wall is seen each time.
    SIZE=960
    python3 "$(dirname "$0")/pano_rig.py" "$IN" "$WORK/images" "$WORK/rig.json" "$SIZE"
    F=$((SIZE / 2))
    colmap feature_extractor --database_path "$WORK/db.db" --image_path "$WORK/images" \
      --ImageReader.single_camera_per_folder 1 --ImageReader.camera_model PINHOLE --ImageReader.camera_params "$F,$F,$F,$F" \
      --FeatureExtraction.use_gpu 0
    colmap rig_configurator --database_path "$WORK/db.db" --rig_config_path "$WORK/rig.json"
    colmap sequential_matcher --database_path "$WORK/db.db" --FeatureMatching.use_gpu 0 --SequentialMatching.overlap 6
    colmap global_mapper --database_path "$WORK/db.db" --image_path "$WORK/images" --output_path "$WORK/sparse" --GlobalMapper.refine_sensor_from_rig 0 \
      || colmap mapper --database_path "$WORK/db.db" --image_path "$WORK/images" --output_path "$WORK/sparse" --Mapper.ba_refine_sensor_from_rig 0
  else
    cp "$IN"/*.jpg "$WORK/images/"
    # One phone camera for every frame; each video frame is matched with its neighbours (sequential matching).
    colmap feature_extractor --database_path "$WORK/db.db" --image_path "$WORK/images" \
      --ImageReader.single_camera 1 --ImageReader.camera_model OPENCV \
      --FeatureExtraction.max_image_size 1600 --FeatureExtraction.use_gpu 0
    colmap sequential_matcher --database_path "$WORK/db.db" --FeatureMatching.use_gpu 0 --SequentialMatching.overlap 12
    # COLMAP 4's global mapper (GLOMAP) is much faster; the incremental mapper is the fallback.
    colmap global_mapper --database_path "$WORK/db.db" --image_path "$WORK/images" --output_path "$WORK/sparse" \
      || colmap mapper --database_path "$WORK/db.db" --image_path "$WORK/images" --output_path "$WORK/sparse"
  fi
  # Largest reconstruction → pinhole images that any splat trainer reads.
  # The mapper can split a walk into several models, and the largest is not always listed first.
  MODEL="" BEST=0
  for M in "$WORK"/sparse/*/; do
    N=$(colmap model_analyzer --path "$M" 2>&1 | awk '/Registered images/ {print $NF}')
    if [ "${N:-0}" -gt "$BEST" ]; then MODEL="$M" BEST="$N"; fi
  done
  colmap image_undistorter --image_path "$WORK/images" --input_path "$MODEL" --output_path "$WORK/undist" --output_type COLMAP
  mkdir -p "$WORK/undist/sparse/0" && mv "$WORK"/undist/sparse/*.bin "$WORK/undist/sparse/0/" 2>/dev/null || true
  REGISTERED=$(colmap model_analyzer --path "$WORK/undist/sparse/0" 2>&1 | awk '/Registered images/ {print $NF}')
  echo "COLMAP registered ${REGISTERED:-?} of $(ls "$WORK/images" | wc -l | tr -d ' ') frames"
  # Frames that see few 3D points (plain ceilings/walls, blur) are often placed wrongly and add ghost copies of
  # the room to the splats: drop them before training.
  mkdir -p "$WORK/txt" && colmap model_converter --input_path "$WORK/undist/sparse/0" --output_path "$WORK/txt" --output_type TXT
  awk -v min="$MIN_POINTS" '!/^#/ { if (n % 2 == 0) { name = $NF } else { c = 0; for (i = 3; i <= NF; i += 3) if ($i != -1) c++; if (c < min) print name } n++ }' "$WORK/txt/images.txt" > "$WORK/weak.txt"
  echo "dropping $(wc -l < "$WORK/weak.txt" | tr -d ' ') weakly placed frames"
  mkdir -p "$WORK/clean/sparse/0"
  colmap image_deleter --input_path "$WORK/undist/sparse/0" --output_path "$WORK/clean/sparse/0" --image_names_path "$WORK/weak.txt"
  ln -s "$WORK/undist/images" "$WORK/clean/images"
  # Upright, real size, starting where the walk was: <outDir>/transform.json for the importer.
  mkdir -p "$WORK/clean_txt" && colmap model_converter --input_path "$WORK/clean/sparse/0" --output_path "$WORK/clean_txt" --output_type TXT
  python3 "$(dirname "$0")/align_colmap.py" "$WORK/clean_txt" "$OUT/transform.json" || true
  DATA="$WORK/clean"
  # Poses only (kaggle.sh trains elsewhere): hand over images/ + sparse/0 and stop before training.
  if [ -n "${RECON_POSES_ONLY:-}" ]; then
    mkdir -p "$RECON_POSES_ONLY/sparse"
    cp -RL "$DATA/images" "$RECON_POSES_ONLY/images"
    cp -R "$DATA/sparse/0" "$RECON_POSES_ONLY/sparse/0"
    echo "poses written to $RECON_POSES_ONLY"
    exit 0
  fi
fi

# 960 px and ≤1.5M splats: trains in reasonable time on a Mac and streams well in the web viewer.
"$BRUSH" "$DATA" --total-steps "$STEPS" --max-resolution 960 --max-splats 1500000 --export-every "$STEPS" --export-path "$WORK/export" --export-name "scene.ply"
SCENE="$(find "$WORK/export" -name '*.ply' | sort | tail -1)"
cp "$SCENE" "$OUT/scene.ply"
echo "scene written to $OUT/scene.ply"

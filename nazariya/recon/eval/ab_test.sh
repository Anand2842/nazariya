#!/usr/bin/env bash
# A/B on the same 360° footage and the same camera poses:
#   A = 360° camera (all 12 directions of every training moment)
#   B = phone-like (only the forward view of every training moment)
# Both are scored on held-out moments (1 in 8, never trained on) in all 12 directions.
set -euo pipefail
W="$1"            # COLMAP workspace with images/ and sparse/0
BRUSH="$HOME/Downloads/rea/tools/brush/brush-app-aarch64-apple-darwin/brush_app"
STEPS="${STEPS:-6000}"
cd "$W"
MODEL="$(ls -d sparse/*/ | head -1)"
colmap model_analyzer --path "$MODEL" 2>&1 | grep -E "Registered frames|Registered images|Points:|Mean reprojection" || true
mkdir -p txt && colmap model_converter --input_path "$MODEL" --output_path txt --output_type TXT
# Image names: camNN/frameXXXX.jpg. Held-out moments: frame number % 8 == 4.
awk '!/^#/ { if (n % 2 == 0) print $NF; n++ }' txt/images.txt | sort > all.txt
awk -F'frame' '{ split($2, a, "."); if ((a[1] + 0) % 8 == 4) print }' all.txt > heldout.txt
grep -v -F -f heldout.txt all.txt > train_all.txt
grep '^cam00/' train_all.txt > train_fwd.txt
grep -v -F -x -f train_all.txt all.txt > del_A.txt          # = held-out
grep -v -F -x -f train_fwd.txt all.txt > del_B.txt          # = held-out + every non-forward view
echo "images: all $(wc -l < all.txt), held-out $(wc -l < heldout.txt), train A $(wc -l < train_all.txt), train B $(wc -l < train_fwd.txt)"
for X in A B; do
  rm -rf "data_$X" && mkdir -p "data_$X/sparse/0" && ln -s "$W/images" "data_$X/images"
  colmap image_deleter --input_path "$MODEL" --output_path "data_$X/sparse/0" --image_names_path "del_$X.txt" > /dev/null 2>&1
  colmap model_analyzer --path "data_$X/sparse/0" 2>&1 | grep -E "Registered images" | sed "s/^/  $X: /"
  mkdir -p "out_$X"
  /usr/bin/time -p "$BRUSH" "data_$X" --total-steps "$STEPS" --max-resolution 960 --max-splats 1500000 --export-every "$STEPS" --export-path "out_$X" --export-name "scene.ply" > "brush_$X.log" 2>&1
  echo "  $X trained: $(grep '^real' "brush_$X.log")"
done
echo "done"

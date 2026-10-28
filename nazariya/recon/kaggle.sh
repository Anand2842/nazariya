#!/usr/bin/env bash
# Nazariya reconstruction using a free Kaggle GPU for training. TESTING ONLY: customer data must not go to Kaggle,
# production uses runpod.sh. Same contract as local-mac.sh: <inputDir> <outDir> → <outDir>/scene.ply + transform.json
#
#  1. COLMAP on this Mac (local-mac.sh with RECON_POSES_ONLY) → images/ + sparse/0 + transform.json
#  2. Upload them as a PRIVATE Kaggle dataset, push kaggle_train.py as a private GPU (T4) script kernel
#  3. Wait, download scene.ply + stats.json, delete the dataset and kernel
#
# Needs KAGGLE_API_TOKEN and KAGGLE_USERNAME (in .env.local) and the Kaggle CLI ≥ 2 (KAGGLE_BIN).
set -euo pipefail
IN="$1"
OUT="$2"
HERE="$(cd "$(dirname "$0")" && pwd)"
KAGGLE="${KAGGLE_BIN:-$HERE/../../tools/kaggle-venv/bin/kaggle}"
: "${KAGGLE_API_TOKEN:?set KAGGLE_API_TOKEN}"
: "${KAGGLE_USERNAME:?set KAGGLE_USERNAME}"
export KAGGLE_API_TOKEN
JOB="nz-recon-$(date +%Y%m%d-%H%M%S)"
# Kernel and dataset slugs must differ (same slug → 409 Conflict on push).
KERNEL="$JOB-train"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/nz-recon.XXXXXX")"
KEEP="${RECON_KEEP_KAGGLE:-0}"
cleanup() {
  if [ "$KEEP" != 1 ]; then
    "$KAGGLE" kernels delete -y "$KAGGLE_USERNAME/$KERNEL" >/dev/null 2>&1 || true
    "$KAGGLE" datasets delete -y "$KAGGLE_USERNAME/$JOB" >/dev/null 2>&1 || true
  fi
  rm -rf "$WORK"
}
trap cleanup EXIT
mkdir -p "$OUT"

# 1. Camera poses on the Mac.
RECON_POSES_ONLY="$WORK/ds/data" bash "$HERE/local-mac.sh" "$IN" "$OUT"
# Keep the camera poses next to the scene (scoring renders and room splitting need them).
mkdir -p "$OUT/sparse" && cp -R "$WORK/ds/data/sparse/0" "$OUT/sparse/0"

# 2. Private dataset + private GPU kernel.
cat > "$WORK/ds/dataset-metadata.json" <<EOF
{"title": "$JOB", "id": "$KAGGLE_USERNAME/$JOB", "licenses": [{"name": "other"}]}
EOF
"$KAGGLE" datasets create -p "$WORK/ds" -r tar -q
for _ in $(seq 1 60); do
  [ "$("$KAGGLE" datasets status "$KAGGLE_USERNAME/$JOB" 2>/dev/null | tr -d '[:space:]')" = ready ] && break
  sleep 10
done
mkdir -p "$WORK/k"
cp "$HERE/kaggle_train.py" "$WORK/k/train.py"
# A gsplat wheel built on Kaggle earlier (kaggle_train.py saves one after a source build) saves ~6 min per job.
SOURCES="\"$KAGGLE_USERNAME/$JOB\""
WHEEL_DS="${KAGGLE_GSPLAT_WHEEL_DATASET:-$KAGGLE_USERNAME/nz-gsplat-wheel}"
if [ "$("$KAGGLE" datasets status "$WHEEL_DS" 2>/dev/null | tr -d '[:space:]')" = ready ]; then SOURCES="$SOURCES, \"$WHEEL_DS\""; fi
cat > "$WORK/k/kernel-metadata.json" <<EOF
{"id": "$KAGGLE_USERNAME/$KERNEL", "title": "$KERNEL", "code_file": "train.py", "language": "python", "kernel_type": "script",
 "is_private": true, "enable_gpu": true, "enable_internet": true, "dataset_sources": [$SOURCES]}
EOF
"$KAGGLE" kernels push -p "$WORK/k" --accelerator "${KAGGLE_ACCELERATOR:-NvidiaTeslaT4}" -t "${KAGGLE_TIMEOUT_S:-10800}"
echo "kaggle job $KAGGLE_USERNAME/$KERNEL started"

# 3. Wait for it (status: queued → running → complete | error | cancel*).
STATUS=""
for _ in $(seq 1 400); do
  sleep 30
  STATUS="$("$KAGGLE" kernels status "$KAGGLE_USERNAME/$KERNEL" 2>/dev/null | tr '[:upper:]' '[:lower:]')"
  case "$STATUS" in *complete*|*error*|*cancel*) break ;; esac
done
"$KAGGLE" kernels output "$KAGGLE_USERNAME/$KERNEL" -p "$WORK/result" -o -q || true
LOG="$(ls "$WORK"/result/*.log 2>/dev/null | head -1 || true)"
[ -n "$LOG" ] && cp "$LOG" "$OUT/kaggle.log"
case "$STATUS" in *complete*) ;; *) echo "kaggle job ended: $STATUS (log: $OUT/kaggle.log)" >&2; exit 1 ;; esac
[ -f "$WORK/result/scene.ply" ] || { echo "kaggle job produced no scene.ply" >&2; exit 1; }
cp "$WORK/result/scene.ply" "$OUT/scene.ply"
cp "$WORK/result/stats.json" "$OUT/stats.json" 2>/dev/null || true
# Held-out frames, real | 3D render side by side (compare.jpg is a contact sheet of nine).
cp "$WORK/result/compare.jpg" "$OUT/compare.jpg" 2>/dev/null || true
[ -d "$WORK/result/renders" ] && cp -R "$WORK/result/renders" "$OUT/renders"
echo "scene written to $OUT/scene.ply"

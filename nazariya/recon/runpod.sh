#!/usr/bin/env bash
# Nazariya reconstruction on a RunPod GPU pod: <inputDir> <outDir> → <outDir>/scene.ply (+ transform.json)
# Set NAZARIYA_RECON_CMD=/path/to/recon/runpod.sh and RUNPOD_API_KEY (in .env.local).
#
# Per job: create an on-demand pod from the nerfstudio image (CUDA COLMAP + splatfacto), copy the frames and gpu.sh
# up over SSH, run, copy the result back, delete the pod. The pod is deleted on every exit path, and also deletes
# itself after RUNPOD_MAX_MINUTES in case this machine disappears mid-job.
set -euo pipefail
IN="$1"
OUT="$2"
: "${RUNPOD_API_KEY:?set RUNPOD_API_KEY}"
HERE="$(cd "$(dirname "$0")" && pwd)"
API=https://rest.runpod.io/v1
# nerfstudio image pinned by digest (CUDA 11.8: Ampere/Ada/Hopper GPUs, not Blackwell).
IMAGE="${RUNPOD_IMAGE:-ghcr.io/nerfstudio-project/nerfstudio@sha256:b59b8e1012d7a43679d3234b3de9c8416a4b8435fcbf21b9d8c4494b8563f19e}"
GPUS="${RUNPOD_GPUS:-NVIDIA GeForce RTX 4090,NVIDIA L4,NVIDIA A40,NVIDIA RTX A4500,NVIDIA RTX A5000}"
MAX_MIN="${RUNPOD_MAX_MINUTES:-240}"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/nz-recon.XXXXXX")"
POD=""
api() { curl -sS -f -H "Authorization: Bearer $RUNPOD_API_KEY" -H 'content-type: application/json' "$@"; }
cleanup() {
  [ -n "$POD" ] && api -X DELETE "$API/pods/$POD" >/dev/null 2>&1 && echo "pod $POD deleted"
  rm -rf "$WORK"
}
trap cleanup EXIT
mkdir -p "$OUT"

ssh-keygen -q -t ed25519 -N '' -C nazariya-recon -f "$WORK/key"
# The image has no SSH server: install one at start. The watchdog deletes the pod after MAX_MIN minutes.
START='apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq openssh-server rsync >/dev/null
mkdir -p /root/.ssh /run/sshd && echo "$PUBLIC_KEY" > /root/.ssh/authorized_keys && chmod 600 /root/.ssh/authorized_keys
(sleep $((NZ_MAX_MIN * 60)); curl -s -X DELETE -H "Authorization: Bearer $NZ_KEY" https://rest.runpod.io/v1/pods/$RUNPOD_POD_ID) &
/usr/sbin/sshd -D'
BODY="$(python3 -c '
import json, sys
image, gpus, start, pub, key, maxmin = sys.argv[1:]
print(json.dumps({
  "name": "nazariya-recon", "imageName": image, "computeType": "GPU", "cloudType": "SECURE",
  "gpuTypeIds": gpus.split(","), "gpuTypePriority": "custom", "gpuCount": 1,
  "containerDiskInGb": 60, "volumeInGb": 0, "ports": ["22/tcp"],
  "dockerEntrypoint": [], "dockerStartCmd": ["bash", "-c", start],
  "env": {"PUBLIC_KEY": pub, "NZ_KEY": key, "NZ_MAX_MIN": maxmin},
}))' "$IMAGE" "$GPUS" "$START" "$(cat "$WORK/key.pub")" "$RUNPOD_API_KEY" "$MAX_MIN")"
POD="$(api -X POST "$API/pods" -d "$BODY" | python3 -c 'import json,sys; print(json.load(sys.stdin)["id"])')"
echo "pod $POD created"

# Wait for a public IP + SSH port, then for sshd (the image pull alone takes a few minutes).
HOST=""; PORT=""
for _ in $(seq 1 120); do
  read -r HOST PORT < <(api "$API/pods/$POD" | python3 -c 'import json,sys; p=json.load(sys.stdin); print(p.get("publicIp") or "-", (p.get("portMappings") or {}).get("22", "-"))')
  [ "$HOST" != - ] && [ "$PORT" != - ] && break
  sleep 10
done
[ "$HOST" != - ] && [ "$PORT" != - ] || { echo "pod never got a public SSH port" >&2; exit 1; }
SSH=(ssh -i "$WORK/key" -p "$PORT" -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR -o ConnectTimeout=10 "root@$HOST")
for _ in $(seq 1 60); do "${SSH[@]}" true 2>/dev/null && break; sleep 10; done
"${SSH[@]}" true

RSH="ssh -i $WORK/key -p $PORT -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR"
"${SSH[@]}" "mkdir -p /job/in /job/out /job/bin"
rsync -az -e "$RSH" "$IN/" "root@$HOST:/job/in/"
rsync -az -e "$RSH" "$HERE/gpu.sh" "$HERE/align_colmap.py" "root@$HOST:/job/bin/"
"${SSH[@]}" "RECON_ITERS=${RECON_ITERS:-15000} bash /job/bin/gpu.sh /job/in /job/out"
rsync -az -e "$RSH" "root@$HOST:/job/out/" "$OUT/"
echo "scene written to $OUT/scene.ply"

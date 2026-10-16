#!/usr/bin/env bash
# Use a rented GPU from the Nazariya server: set NAZARIYA_RECON_CMD=/path/to/recon/remote.sh and
#   RECON_HOST=user@gpu-box   (SSH key access; the box has Docker + NVIDIA Container Toolkit)
#   RECON_IMAGE=nazariya-recon (built from recon/Dockerfile on that box)
# The input is copied up, reconstructed in the container, and scene.ply copied back.
set -euo pipefail
IN="$1"
OUT="$2"
: "${RECON_HOST:?set RECON_HOST=user@gpu-host}"
IMAGE="${RECON_IMAGE:-nazariya-recon}"
JOB="nz-$(date +%s)-$$"
ssh "$RECON_HOST" "mkdir -p /tmp/$JOB/in /tmp/$JOB/out"
rsync -az "$IN/" "$RECON_HOST:/tmp/$JOB/in/"
ssh "$RECON_HOST" "docker run --rm --gpus all -v /tmp/$JOB:/job $IMAGE /job/in /job/out"
rsync -az "$RECON_HOST:/tmp/$JOB/out/" "$OUT/"
ssh "$RECON_HOST" "rm -rf /tmp/$JOB"

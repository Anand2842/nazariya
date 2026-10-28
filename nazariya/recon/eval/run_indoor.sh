#!/usr/bin/env bash
# Full indoor A/B on the train-walk 360 footage: rig COLMAP, train A (all views) and B (forward only), score held-out.
set -uo pipefail
E="$(cd "$(dirname "$0")" && pwd)"; W="$(cd "${1:?usage: run_indoor.sh <workspace with eq/ or images/>}" && pwd)"; R="$E"; NZ="$E/../.."
BRUSH="$HOME/Downloads/rea/tools/brush/brush-app-aarch64-apple-darwin/brush_app"
cd "$W"
echo "$(date +%T) views (already cut)"; [ -d images/cam11 ] || PANO_VIEWS=upper python3 $NZ/recon/pano_rig.py eq images rig.json 960 || exit 1
echo "$(date +%T) features"; colmap feature_extractor --database_path db.db --image_path images --ImageReader.single_camera_per_folder 1 --ImageReader.camera_model PINHOLE --ImageReader.camera_params "480,480,480,480" --FeatureExtraction.use_gpu 0 --SiftExtraction.max_num_features 4096 > log_extract.txt 2>&1 || { echo extract failed; exit 1; }
colmap rig_configurator --database_path db.db --rig_config_path rig.json > log_rig.txt 2>&1 || { echo rig failed; exit 1; }
echo "$(date +%T) matching"; colmap sequential_matcher --database_path db.db --FeatureMatching.use_gpu 0 --SequentialMatching.overlap 4 > log_match.txt 2>&1 || { echo match failed; exit 1; }
echo "$(date +%T) mapping"; mkdir -p sparse; colmap global_mapper --database_path db.db --image_path images --output_path sparse --GlobalMapper.refine_sensor_from_rig 0 > log_map.txt 2>&1 || { echo map failed; exit 1; }
colmap model_analyzer --path sparse/0 2>&1 | grep -E "Registered frames|Registered images|Points:|Mean track|Mean reprojection" | sed 's/.*\] //'
mkdir -p txt && colmap model_converter --input_path sparse/0 --output_path txt --output_type TXT > /dev/null 2>&1
awk '!/^#/ { if (n % 2 == 0) print $NF; n++ }' txt/images.txt | sort > all.txt
awk -F'frame' '{ split($2, a, "."); if ((a[1] + 0) % 8 == 4) print }' all.txt > heldout.txt
grep -v -F -f heldout.txt all.txt > train_all.txt; grep '^cam00/' train_all.txt > train_fwd.txt
echo "held-out $(wc -l < heldout.txt), train A $(wc -l < train_all.txt), train B $(wc -l < train_fwd.txt)"
# A: delete held-out frames (whole rig frames). B: forward views only, its own points.
rm -rf data_A data_B; mkdir -p data_A/sparse/0 data_B/sparse/0; ln -s "$W/images" data_A/images; ln -s "$W/images" data_B/images
colmap image_deleter --input_path sparse/0 --output_path data_A/sparse/0 --image_names_path heldout.txt > /dev/null 2>&1
python3 - "$W" <<'PY'
import sys, os
W=sys.argv[1]; T=W+"/txt"; O=W+"/b_txt"; os.makedirs(O, exist_ok=True)
train=set(open(W+"/train_fwd.txt").read().split())
L=[l for l in open(T+"/images.txt") if not l.startswith("#")]
keep={}
for i in range(0,len(L)-1,2):
    p=L[i].split()
    if p[-1] in train: keep[p[0]]=(L[i],L[i+1])
cams={v[0].split()[8] for v in keep.values()}
pts=[]; kp=set()
for l in open(T+"/points3D.txt"):
    if l.startswith("#"): continue
    q=l.split(); tr=q[8:]; obs=[(tr[j],tr[j+1]) for j in range(0,len(tr),2) if tr[j] in keep]
    if len(obs)>=2: kp.add(q[0]); pts.append(" ".join(q[:8]+[x for o in obs for x in o])+"\n")
with open(O+"/images.txt","w") as f:
    for a,b in keep.values():
        b2=b.split()
        for j in range(2,len(b2),3):
            if b2[j] not in kp: b2[j]="-1"
        f.write(a if a.endswith("\n") else a+"\n"); f.write(" ".join(b2)+"\n")
with open(O+"/cameras.txt","w") as f:
    for l in open(T+"/cameras.txt"):
        if not l.startswith("#") and l.split()[0] in cams: f.write(l)
open(O+"/points3D.txt","w").writelines(pts)
print("B images",len(keep),"points",len(pts))
PY
colmap model_converter --input_path b_txt --output_path data_B/sparse/0 --output_type BIN > /dev/null 2>&1
for X in A B; do
  echo "$(date +%T) train $X"; mkdir -p out_$X
  ( "$BRUSH" data_$X --total-steps 6000 --max-resolution 960 --max-splats 1500000 --export-every 1000 --export-path out_$X --export-name "scene_{iter}.ply" > brush_$X.log 2>&1 & P=$!; for i in $(seq 1 180); do sleep 10; kill -0 $P 2>/dev/null || break; done; kill $P 2>/dev/null )
  LAST=$(ls out_$X | sort -t_ -k2 -n | tail -1); echo "  $X last snapshot: $LAST"
  ( cd "$R" && EVAL_LIST="$W/heldout.txt" SHEET=0 PSNR_OUT="$W/psnr_$X.json" node render.mjs "$W/out_$X/$LAST" "$W/txt" "$W/images" "$W/eval_$X.jpg" 2>&1 | tail -1 | sed "s/^/  $X: /" )
done
python3 - "$W" <<'PY'
import json, sys, statistics as st
W=sys.argv[1]; A=json.load(open(W+"/psnr_A.json")); B=json.load(open(W+"/psnr_B.json"))
g=lambda n: "forward" if n.startswith("cam00/") else ("up" if int(n[3:5])>=8 else "sideways/behind")
for k in ("forward","sideways/behind","up"):
    v=[(A[n],B[n]) for n in A if g(n)==k]; print(f"{k:16s} {len(v):4d}  A {st.mean(a for a,_ in v):6.2f}  B {st.mean(b for _,b in v):6.2f}")
print(f"ALL {len(A)}  A {st.mean(A.values()):.2f}  B {st.mean(B.values()):.2f}  A better on {sum(A[n]>B[n] for n in A)}/{len(A)}")
PY
echo "$(date +%T) done"

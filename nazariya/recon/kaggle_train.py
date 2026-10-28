"""Nazariya splat training on a Kaggle GPU notebook (testing only; production uses runpod.sh + gpu.sh).

kaggle.sh pushes this file as a script kernel with the job's private dataset attached. The dataset holds a
COLMAP reconstruction made on the Mac: images/ + sparse/0. Trains with gsplat's reference trainer in COLMAP's own
frame (no world normalisation), so the transform.json written on the Mac still applies, and writes
/kaggle/working/scene.ply plus /kaggle/working/stats.json (held-out PSNR/SSIM/LPIPS on every 8th frame).
"""
import glob
import json
import os
import shutil
import subprocess
import sys
import tarfile
import time
import zipfile

GSPLAT = "1.5.3"
STEPS = int(os.environ.get("RECON_ITERS", "15000"))
WORK = "/kaggle/working"
T0 = time.time()


def sh(cmd, **kw):
    print(f"[{time.time() - T0:6.0f}s] $ {cmd}", flush=True)
    subprocess.run(cmd, shell=True, check=True, **kw)


def find_dataset():
    for root, dirs, _ in os.walk("/kaggle/input"):
        if "images" in dirs and os.path.isdir(os.path.join(root, "sparse", "0")):
            return root
    # Archives that Kaggle did not unpack.
    for arc in glob.glob("/kaggle/input/**/*.zip", recursive=True) + glob.glob("/kaggle/input/**/*.tar", recursive=True):
        dest = os.path.join(WORK, "data")
        os.makedirs(dest, exist_ok=True)
        if arc.endswith(".zip"):
            zipfile.ZipFile(arc).extractall(dest)
        else:
            tarfile.open(arc).extractall(dest)
    for root, dirs, _ in os.walk(os.path.join(WORK, "data")):
        if "images" in dirs and os.path.isdir(os.path.join(root, "sparse", "0")):
            return root
    sys.exit("no images/ + sparse/0 found in /kaggle/input")


sh("nvidia-smi --query-gpu=name,memory.total --format=csv")
import torch  # noqa: E402

print("torch", torch.__version__, "cuda", torch.version.cuda, flush=True)

# gsplat, fastest first: a wheel we built earlier (attached as a dataset), the official prebuilt wheel for this
# torch/CUDA, or a source build (~6 min on Kaggle). A source build is also saved as wheels/*.whl in the output so it
# can be attached to later runs.
tv = "".join(torch.__version__.split("+")[0].split(".")[:2])
cv = (torch.version.cuda or "").replace(".", "")
cached = sorted(glob.glob(f"/kaggle/input/**/gsplat-{GSPLAT}*-cp{sys.version_info.major}{sys.version_info.minor}-*.whl", recursive=True))
if cached:
    sh(f"pip install -q {cached[-1]}")  # with deps: jaxtyping, rich, ninja
else:
    try:
        sh(f"pip install -q gsplat=={GSPLAT} --index-url https://docs.gsplat.studio/whl/pt{tv}cu{cv}")
    except subprocess.CalledProcessError:
        sh(f"pip wheel -q --no-deps --no-build-isolation -w {WORK}/wheels git+https://github.com/nerfstudio-project/gsplat.git@v{GSPLAT}")
        sh(f"pip install -q {WORK}/wheels/gsplat-*.whl")
sh(f"git clone -q --depth 1 --branch v{GSPLAT} https://github.com/nerfstudio-project/gsplat.git /tmp/gsplat")
# Kaggle ships Hugging Face `datasets`, which shadows the trainer's own examples/datasets/ (a namespace package).
open("/tmp/gsplat/examples/datasets/__init__.py", "a").close()
# With both T4s the trainer shards the Gaussians across GPUs and every rank writes its shard to the same PLY path;
# give each rank its own file so the shards can be merged below.
trainer = "/tmp/gsplat/examples/simple_trainer.py"
code = open(trainer).read()
assert code.count('f"{self.ply_dir}/point_cloud_{step}.ply"') == 1, "simple_trainer PLY path changed"
open(trainer, "w").write(code.replace('f"{self.ply_dir}/point_cloud_{step}.ply"', 'f"{self.ply_dir}/point_cloud_{step}_rank{self.world_rank}.ply"'))
# The trainer's requirements, minus the optional bilateral-grid kernels and the numpy<2 pin.
reqs = [r.strip() for r in open("/tmp/gsplat/examples/requirements.txt") if r.strip() and not r.startswith("#")]
reqs = [r for r in reqs if "bilagrid" not in r and not r.startswith("numpy")]
sh("pip install -q --no-build-isolation " + " ".join(f"'{r}'" for r in reqs))
# That pycolmap fork predates numpy 2 (np.uint64(-1) now raises); Kaggle's Python 3.13 has no numpy<2 wheels.
import importlib.util  # noqa: E402

sm = os.path.join(os.path.dirname(importlib.util.find_spec("pycolmap").origin), "scene_manager.py")
src = open(sm).read()
open(sm, "w").write(src.replace("np.uint64(-1)", "np.iinfo(np.uint64).max"))

data = find_dataset()
print("dataset", data, len(os.listdir(os.path.join(data, "images"))), "images", flush=True)
out = os.path.join(WORK, "run")
help_text = subprocess.run("cd /tmp/gsplat/examples && python simple_trainer.py default --help", shell=True, capture_output=True, text=True).stdout
no_norm = "--no-normalize-world-space" if "--no-normalize-world-space" in help_text else "--no-normalize_world_space" if "--no-normalize_world_space" in help_text else "--normalize_world_space False"
# MCMC densification (capped at 1M splats) on one T4. Same walkthrough, same held-out frames, Oct 2026: 27.3 dB
# PSNR with 1.0M splats vs 26.2 dB with 2.3M for the default strategy, same 21 min, fewer floaters in the renders.
# Not tried with two GPUs, so the second T4 stays idle.
gpus = 1
sh(
    "cd /tmp/gsplat/examples && CUDA_VISIBLE_DEVICES=0 python simple_trainer.py mcmc"
    f" --data_dir {data} --data_factor 1 --result_dir {out} {no_norm}"
    f" --max_steps {STEPS} --eval_steps {STEPS} --save_steps {STEPS} --save_ply --ply_steps {STEPS}"
    " --disable_viewer --disable_video"
)

last = int(STEPS / gpus) - 1
shards = sorted(glob.glob(os.path.join(out, "ply", f"point_cloud_{last}_rank*.ply")))
if not shards:
    sys.exit("training produced no PLY")
# Merge the per-GPU shards: same binary vertex layout, so concatenate the bodies and add up the counts.
header, total, bodies = None, 0, []
for p in shards:
    raw = open(p, "rb").read()
    end = raw.index(b"end_header\n") + len(b"end_header\n")
    h = raw[:end].decode()
    n = int(h.split("element vertex ")[1].split()[0])
    props = [line for line in h.splitlines() if line.startswith("property")]
    if header is not None and props != [line for line in header.splitlines() if line.startswith("property")]:
        sys.exit("PLY shards have different layouts")
    header, total = h, total + n
    bodies.append(raw[end:])
with open(os.path.join(WORK, "scene.ply"), "wb") as f:
    f.write(header.replace(f"element vertex {n}\n", f"element vertex {total}\n").encode())
    for b in bodies:
        f.write(b)
stats = {"seconds": round(time.time() - T0), "steps": last + 1, "gpu": torch.cuda.get_device_name(0), "gpus": gpus, "torch": torch.__version__, "splats": total, "shards": len(shards)}
for f in sorted(glob.glob(os.path.join(out, "stats", "*.json"))):
    stats[os.path.basename(f)] = json.load(open(f))
json.dump(stats, open(os.path.join(WORK, "stats.json"), "w"), indent=1)
print(json.dumps(stats, indent=1), flush=True)
# The trainer's held-out renders (real frame | 3D render, side by side): keep small JPGs plus a contact sheet.
from PIL import Image  # noqa: E402

vals = sorted(glob.glob(os.path.join(out, "renders", "val_step*.png")))
if vals:
    os.makedirs(os.path.join(WORK, "renders"), exist_ok=True)
    tiles = []
    for p in vals:
        im = Image.open(p).convert("RGB")
        im = im.resize((im.width * 480 // im.height, 480))
        im.save(os.path.join(WORK, "renders", os.path.basename(p)[:-4] + ".jpg"), quality=85)
        tiles.append(im)
    pick = [tiles[round(k * (len(tiles) - 1) / 8)] for k in range(9)] if len(tiles) >= 9 else tiles
    tw, th = pick[0].size
    sheet = Image.new("RGB", (tw * 3, th * ((len(pick) + 2) // 3)))
    for i, t in enumerate(pick):
        sheet.paste(t, ((i % 3) * tw, (i // 3) * th))
    sheet.save(os.path.join(WORK, "compare.jpg"), quality=85)
# Only scene.ply, stats.json and the JPG renders are downloaded; drop checkpoints and full-size renders.
shutil.rmtree(out, ignore_errors=True)

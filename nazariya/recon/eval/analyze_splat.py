"""Quality report for a Gaussian-splat PLY against the COLMAP camera path it was trained from.

Usage: python3 analyze_splat.py scene.ply images.txt
Reports splat count, opacity and size distributions, how much of the scene sits inside the region the camera
actually walked (vs. "floaters" far outside it), and a coarse density map.
"""
import sys, re, math
import numpy as np

ply, images_txt = sys.argv[1], sys.argv[2]
with open(ply, "rb") as f:
    header = b""
    while not header.endswith(b"end_header\n"):
        header += f.readline()
    h = header.decode()
    n = int(re.search(r"element vertex (\d+)", h).group(1))
    props = re.findall(r"property (\w+) (\w+)", h)
    types = {"float": "<f4", "double": "<f8", "uchar": "u1", "int": "<i4", "uint": "<u4", "short": "<i2", "ushort": "<u2"}
    dt = np.dtype([(name, types[t]) for t, name in props])
    v = np.frombuffer(f.read(n * dt.itemsize), dtype=dt, count=n)

xyz = np.stack([v["x"], v["y"], v["z"]], 1).astype(np.float64)
op = 1 / (1 + np.exp(-v["opacity"].astype(np.float64)))
sc = np.exp(np.stack([v[f"scale_{i}"] for i in range(3)], 1).astype(np.float64)).max(1)

cams = []
lines = [l for l in open(images_txt) if not l.startswith("#")]
for i in range(0, len(lines), 2):
    p = lines[i].split()
    if len(p) < 10:
        continue
    qw, qx, qy, qz, tx, ty, tz = map(float, p[1:8])
    R = np.array([[1 - 2 * (qy * qy + qz * qz), 2 * (qx * qy - qz * qw), 2 * (qx * qz + qy * qw)], [2 * (qx * qy + qz * qw), 1 - 2 * (qx * qx + qz * qz), 2 * (qy * qz - qx * qw)], [2 * (qx * qz - qy * qw), 2 * (qy * qz + qx * qw), 1 - 2 * (qx * qx + qy * qy)]])
    cams.append(-R.T @ np.array([tx, ty, tz]))
cams = np.array(cams)
centre = cams.mean(0)
walk = np.percentile(np.linalg.norm(cams - centre, axis=1), 95)  # how far the phone moved from the middle

d = np.linalg.norm(xyz - centre, axis=1)
visible = op > 0.1
print(f"splats {n:,}  (opacity > 0.1: {visible.sum():,} = {visible.mean():.0%})")
print(f"opacity: median {np.median(op):.2f}, share nearly transparent (<0.05): {(op < 0.05).mean():.0%}")
print(f"splat size (largest axis), relative to walk radius {walk:.2f}: median {np.median(sc) / walk:.4f}, p99 {np.percentile(sc, 99) / walk:.3f}, huge (>0.5) {(sc > 0.5 * walk).sum():,}")
for k in (1.5, 3, 6, 12):
    print(f"visible splats within {k:>4} × walk radius of the centre: {((d < k * walk) & visible).sum() / max(1, visible.sum()):.1%}")
far = visible & (d > 6 * walk)
print(f"far floaters (visible, > 6 × walk radius): {far.sum():,} ({far.sum() / max(1, visible.sum()):.2%})")
# Room size estimate along the main axes of the visible splats near the walk.
near = xyz[visible & (d < 4 * walk)]
c = near - near.mean(0)
w, V = np.linalg.eigh(np.cov(c.T))
ext = [np.percentile(c @ V[:, i], 98) - np.percentile(c @ V[:, i], 2) for i in range(3)]
print("extent of the main scene (2–98%) along its axes, in walk radii:", ", ".join(f"{e / walk:.1f}" for e in sorted(ext)))
print(f"file {n * dt.itemsize / 1e6:.0f} MB, {len(props)} properties per splat")

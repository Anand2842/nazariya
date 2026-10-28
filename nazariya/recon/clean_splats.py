"""Remove floaters from a trained splat scene, and (on a GPU) score a scene on the held-out frames.

Floaters are splats where nothing real can be: right where the phone was while recording (a fan blade or a box
that was too close to the lens becomes a big grey blob there), and far outside the walked area. Uses the COLMAP
camera centres of the training run and transform.json (metres per unit) from align_colmap.py.

  python3 clean_splats.py <scene.ply> <sparse/0> <transform.json> <out.ply>     clean (numpy only)
  python3 clean_splats.py <scene.ply> <sparse/0> <transform.json> --report      what would be removed, no output

evaluate(ply, data_dir) renders the held-out frames (every 8th, as gsplat's trainer) and needs torch + gsplat.
"""
import json
import struct
import sys

import numpy as np

# Rules, in metres. Nothing real is closer than CORE to where the phone was, and nothing in a home is further
# than FAR from every point of the walk. Free-space carving: every COLMAP observation is a line of sight from a
# camera to a surface, so the space along it (up to MARGIN before the surface) is empty; a splat in a VOXEL that at
# least MIN_RAYS lines of sight passed through is floating in front of something the camera saw.
CORE_M = 0.15
FAR_M = 8.0
MIN_OPACITY = 0.005
VOXEL_M = 0.05
MARGIN_M = 0.25
MIN_RAYS = 3


def read_ply(path):
    raw = open(path, "rb").read()
    end = raw.index(b"end_header\n") + len(b"end_header\n")
    header = raw[:end].decode()
    n = int(header.split("element vertex ")[1].split()[0])
    props = [line.split()[2] for line in header.splitlines() if line.startswith("property float")]
    if len(props) != sum(line.startswith("property") for line in header.splitlines()):
        raise ValueError("only float32 vertex properties are supported")
    data = np.frombuffer(raw, dtype=np.dtype([(p, "<f4") for p in props]), count=n, offset=end)
    return header, data


def write_ply(path, header, data):
    with open(path, "wb") as f:
        f.write(header.replace(header.split("element vertex ")[1].split()[0], str(len(data)), 1).encode())
        f.write(data.tobytes())


def read_images(sparse_dir):
    """Camera centres and the 3D point ids each camera observed, from COLMAP images.bin
    (world → camera rotation R, translation t: centre = −Rᵀt)."""
    out, seen = [], []
    with open(f"{sparse_dir}/images.bin", "rb") as f:
        (count,) = struct.unpack("<Q", f.read(8))
        for _ in range(count):
            _, qw, qx, qy, qz, tx, ty, tz, _ = struct.unpack("<i7di", f.read(64))
            while f.read(1) != b"\0":
                pass
            (npts,) = struct.unpack("<Q", f.read(8))
            obs = np.frombuffer(f.read(24 * npts), dtype=np.dtype([("x", "<f8"), ("y", "<f8"), ("id", "<i8")]))
            seen.append(obs["id"][obs["id"] >= 0])
            R = np.array([
                [1 - 2 * (qy * qy + qz * qz), 2 * (qx * qy - qz * qw), 2 * (qx * qz + qy * qw)],
                [2 * (qx * qy + qz * qw), 1 - 2 * (qx * qx + qz * qz), 2 * (qy * qz - qx * qw)],
                [2 * (qx * qz - qy * qw), 2 * (qy * qz + qx * qw), 1 - 2 * (qx * qx + qy * qy)],
            ])
            out.append(-R.T @ np.array([tx, ty, tz]))
    return np.array(out), seen


def camera_centres(sparse_dir):
    return read_images(sparse_dir)[0]


def read_points(sparse_dir):
    """COLMAP points3D.bin → {id: xyz}."""
    ids, xyz = [], []
    with open(f"{sparse_dir}/points3D.bin", "rb") as f:
        (count,) = struct.unpack("<Q", f.read(8))
        for _ in range(count):
            pid, x, y, z = struct.unpack("<Q3d", f.read(32))
            f.seek(3 + 8, 1)  # rgb, error
            (n,) = struct.unpack("<Q", f.read(8))
            f.seek(8 * n, 1)
            ids.append(pid)
            xyz.append((x, y, z))
    return np.array(ids), np.array(xyz)


def free_space(cams, seen, pid, pxyz, m_per_unit, voxel_m=VOXEL_M, margin_m=MARGIN_M):
    """Voxel grid (VOXEL_M) counting the lines of sight that pass through each voxel."""
    lookup = np.full(int(pid.max()) + 1, -1)
    lookup[pid] = np.arange(len(pid))
    vox = voxel_m / m_per_unit
    lo = pxyz.min(0) - vox
    dims = np.ceil((pxyz.max(0) + vox - lo) / vox).astype(int) + 1
    counts = np.zeros(int(np.prod(dims)), np.int32)
    for c, ids in zip(cams, seen):
        ends = pxyz[lookup[ids]]
        vec = ends - c
        length = np.linalg.norm(vec, axis=1)
        reach = length - margin_m / m_per_unit
        for k in range(0, len(ends), 2000):
            v, r, ln = vec[k : k + 2000], reach[k : k + 2000], length[k : k + 2000]
            steps = np.arange(0, max(r.max(), 0), vox / 2)
            if not len(steps):
                continue
            pts = c + v[:, None, :] * (steps[None, :, None] / ln[:, None, None])
            ok = steps[None, :] < r[:, None]
            cell = np.floor((pts[ok] - lo) / vox).astype(int)
            inside = np.all((cell >= 0) & (cell < dims), axis=1)
            flat = np.ravel_multi_index(cell[inside].T, dims)
            # One count per ray per voxel.
            ray = np.broadcast_to(np.arange(len(v))[:, None], ok.shape)[ok][inside]
            pairs = np.unique(flat.astype(np.int64) * 4096 + ray)
            np.add.at(counts, pairs // 4096, 1)
    return counts.reshape(dims), lo, vox


def nearest_distance(points, cams, chunk=200_000):
    d = np.empty(len(points), dtype=np.float32)
    for i in range(0, len(points), chunk):
        p = points[i : i + chunk]
        d[i : i + chunk] = np.sqrt(((p[:, None, :] - cams[None, :, :]) ** 2).sum(-1).min(1))
    return d


def floater_mask(data, sparse_dir, m_per_unit, core_m=CORE_M, voxel_m=VOXEL_M, margin_m=MARGIN_M, min_rays=MIN_RAYS):
    """True for splats to remove, plus counts per rule. min_rays=0 turns carving off."""
    cams, seen = read_images(sparse_dir)
    grid, lo, vox = free_space(cams, seen, *read_points(sparse_dir), m_per_unit, voxel_m, margin_m)
    xyz = np.stack([data["x"], data["y"], data["z"]], 1)
    dist = nearest_distance(xyz, cams) * m_per_unit
    cell = np.floor((xyz - lo) / vox).astype(int)
    inside = np.all((cell >= 0) & (cell < grid.shape), axis=1)
    rays = np.zeros(len(xyz), np.int32)
    rays[inside] = grid[tuple(cell[inside].T)]
    opacity = 1 / (1 + np.exp(-data["opacity"]))
    rules = {
        "core": dist < core_m,
        "free_space": (rays >= min_rays) if min_rays else np.zeros(len(xyz), bool),
        "far": dist > FAR_M,
        "transparent": opacity < MIN_OPACITY,
    }
    mask = np.zeros(len(data), bool)
    for m in rules.values():
        mask |= m
    return mask, {k: int(v.sum()) for k, v in rules.items()}


def clean(ply, sparse_dir, transform, out=None, **rules):
    header, data = read_ply(ply)
    m_per_unit = json.load(open(transform))["scale"]
    mask, counts = floater_mask(data, sparse_dir, m_per_unit, **rules)
    report = {"splats": len(data), "removed": int(mask.sum()), **{f"removed_{k}": v for k, v in counts.items()}}
    if out:
        write_ply(out, header, data[~mask])
    return report


def evaluate(ply, data_dir, test_every=8, renders=None):
    """Mean PSNR/SSIM of the scene (a PLY path or read_ply data) on gsplat's held-out frames, same split and camera
    frame as the trainer. renders: {view index: path} to save those renders as JPG."""
    import torch
    from datasets.colmap import Dataset, Parser  # gsplat/examples on sys.path
    from fused_ssim import fused_ssim
    from gsplat.rendering import rasterization

    d = read_ply(ply)[1] if isinstance(ply, str) else ply
    dev = "cuda"
    t = lambda a: torch.tensor(np.ascontiguousarray(a), dtype=torch.float32, device=dev)  # noqa: E731
    means = t(np.stack([d["x"], d["y"], d["z"]], 1))
    quats = t(np.stack([d["rot_0"], d["rot_1"], d["rot_2"], d["rot_3"]], 1))
    scales = torch.exp(t(np.stack([d["scale_0"], d["scale_1"], d["scale_2"]], 1)))
    opac = torch.sigmoid(t(d["opacity"]))
    rest = sorted((n for n in d.dtype.names if n.startswith("f_rest_")), key=lambda n: int(n[7:]))
    sh0 = t(np.stack([d["f_dc_0"], d["f_dc_1"], d["f_dc_2"]], 1))[:, None, :]
    if rest:
        shn = t(np.stack([d[n] for n in rest], 1)).reshape(len(d), 3, -1).transpose(1, 2)  # PLY stores channel-major
        colors = torch.cat([sh0, shn], 1)
    else:
        colors = sh0
    degree = int(round(np.sqrt(colors.shape[1]))) - 1
    val = Dataset(Parser(data_dir=data_dir, factor=1, normalize=False, test_every=test_every), split="val")
    psnrs, ssims = [], []
    with torch.no_grad():
        for i in range(len(val)):
            item = val[i]
            gt = item["image"].to(dev) / 255.0
            h, w = gt.shape[:2]
            img, _, _ = rasterization(means, quats, scales, opac, colors, torch.linalg.inv(item["camtoworld"].to(dev))[None], item["K"].to(dev)[None], w, h, sh_degree=degree)
            img = img[0].clamp(0, 1)
            psnrs.append(float(-10 * torch.log10(((img - gt) ** 2).mean())))
            if renders and i in renders:
                import imageio.v2 as imageio

                imageio.imwrite(renders[i], (img.cpu().numpy() * 255).astype(np.uint8), quality=85)
            ssims.append(float(fused_ssim(img.permute(2, 0, 1)[None], gt.permute(2, 0, 1)[None], padding="valid")))
    return {"psnr": float(np.mean(psnrs)), "ssim": float(np.mean(ssims)), "views": len(psnrs), "splats": len(d)}


if __name__ == "__main__":
    ply, sparse, tf = sys.argv[1:4]
    target = sys.argv[4] if len(sys.argv) > 4 else None
    print(json.dumps(clean(ply, sparse, tf, None if target in (None, "--report") else target)))

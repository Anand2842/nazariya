"""Upright, real-size placement for a COLMAP reconstruction of a phone walkthrough (no numpy needed).

COLMAP's world has no "up" and no units. A person filming a room holds the phone roughly upright at eye height,
so: up = mean of the cameras' up directions; the floor = the lowest dense layer of 3D points; the scale makes the
camera height above the floor ≈ EYE_HEIGHT_M. The viewer starts where the phone actually was in the best-covered
frame (the scene is sharpest from real camera positions), facing the same way. Writes the Nazariya scene
transform {align: quaternion, scale, offset} and startYaw, plus path: every camera centre in walk order (the
viewer keeps visitors near it, where the scene was actually seen).

Usage: python3 align_colmap.py <colmap_txt_dir> <transform.json>
"""
import json
import math
import sys

EYE_HEIGHT_M = 1.45


def quat_to_rot(qw, qx, qy, qz):
    return [[1 - 2 * (qy * qy + qz * qz), 2 * (qx * qy - qz * qw), 2 * (qx * qz + qy * qw)], [2 * (qx * qy + qz * qw), 1 - 2 * (qx * qx + qz * qz), 2 * (qy * qz - qx * qw)], [2 * (qx * qz - qy * qw), 2 * (qy * qz + qx * qw), 1 - 2 * (qx * qx + qy * qy)]]


def norm(v):
    n = math.sqrt(sum(x * x for x in v)) or 1.0
    return [x / n for x in v]


def dot(a, b):
    return sum(x * y for x, y in zip(a, b))


def cross(a, b):
    return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]


def pct(vals, p):
    s = sorted(vals)
    return s[min(len(s) - 1, max(0, int(p * len(s))))]


def main(txt_dir, out):
    centres, ups, fwds, support = [], [], [], {}
    lines = [l for l in open(f"{txt_dir}/images.txt") if not l.startswith("#")]
    for i in range(0, len(lines), 2):
        p = lines[i].split()
        if len(p) < 10:
            continue
        name = p[-1]
        support[name] = sum(1 for x in lines[i + 1].split()[2::3] if x != "-1")
        qw, qx, qy, qz, tx, ty, tz = map(float, p[1:8])
        R = quat_to_rot(qw, qx, qy, qz)  # world → camera
        # Camera axes in world coordinates are the rows of R (COLMAP camera: x right, y down, z forward).
        centres.append((name, [-(R[0][j] * tx + R[1][j] * ty + R[2][j] * tz) for j in range(3)]))
        ups.append([-R[1][j] for j in range(3)])
        fwds.append((name, [R[2][j] for j in range(3)]))
    # 360° rigs: only the level reference view (cam00) says which way is up and where the walk faced.
    if any(n.startswith("cam00/") for n, _ in centres):
        keep = [i for i, (n, _) in enumerate(centres) if n.startswith("cam00/")]
        centres, ups = [centres[i] for i in keep], [ups[i] for i in keep]
        fwds = [f for f in fwds if f[0].startswith("cam00/")]
        support = {k: v for k, v in support.items() if k.startswith("cam00/")}
    up = norm([sum(u[k] for u in ups) for k in range(3)])
    centres.sort()
    fwds.sort()
    cam = [c for _, c in centres]
    mid = [sum(c[k] for c in cam) / len(cam) for k in range(3)]
    # Facing direction at the start of the walk, made horizontal.
    f0 = fwds[0][1]
    f0 = norm([f0[k] - dot(f0, up) * up[k] for k in range(3)])
    right = norm(cross(f0, up))  # viewer x
    back = norm(cross(right, up))  # viewer z (the viewer looks down −z)
    # Rotation matrix world → viewer: rows are the viewer axes expressed in world coordinates.
    M = [right, up, back]
    # Floor: heights of 3D points relative to the mean camera height.
    pts = [list(map(float, l.split()[1:4])) for l in open(f"{txt_dir}/points3D.txt") if not l.startswith("#") and l.strip()]
    cam_h = sum(dot(c, up) for c in cam) / len(cam)
    rel = [dot(p, up) - cam_h for p in pts]
    floor = pct(rel, 0.03)
    eye = -floor  # camera height above the floor, in COLMAP units
    scale = EYE_HEIGHT_M / eye if eye > 1e-6 else 1.0
    # Matrix → quaternion (x, y, z, w).
    m00, m01, m02 = M[0]
    m10, m11, m12 = M[1]
    m20, m21, m22 = M[2]
    tr = m00 + m11 + m22
    if tr > 0:
        s = math.sqrt(tr + 1.0) * 2
        q = [(m21 - m12) / s, (m02 - m20) / s, (m10 - m01) / s, 0.25 * s]
    elif m00 > m11 and m00 > m22:
        s = math.sqrt(1.0 + m00 - m11 - m22) * 2
        q = [0.25 * s, (m01 + m10) / s, (m02 + m20) / s, (m21 - m12) / s]
    elif m11 > m22:
        s = math.sqrt(1.0 + m11 - m00 - m22) * 2
        q = [(m01 + m10) / s, 0.25 * s, (m12 + m21) / s, (m02 - m20) / s]
    else:
        s = math.sqrt(1.0 + m22 - m00 - m11) * 2
        q = [(m02 + m20) / s, (m12 + m21) / s, 0.25 * s, (m10 - m01) / s]
    ceiling = pct(rel, 0.97)
    room_h = (ceiling - floor) * scale
    up_agree = sum(1 for u in ups if dot(u, up) > math.cos(math.radians(30))) / len(ups)
    # Start at the frame that sees the most 3D points, facing its (horizontal) direction.
    best = max(support, key=support.get)
    start = dict(centres)[best]
    fb = dict(fwds)[best]
    fv = [dot(M[r], fb) for r in range(3)]  # in viewer axes
    start_yaw = math.atan2(fv[0], -fv[2])  # viewer yaw (SplatView: camera rotation −yaw): forward = (sin y, 0, −cos y)
    result = {"align": [round(x, 6) for x in q], "scale": round(scale, 6), "offset": [round(x, 6) for x in start], "startYaw": round(start_yaw, 4), "walkCentre": [round(x, 6) for x in mid], "startFrame": best, "path": [[round(x, 4) for x in c] for c in cam]}
    json.dump(result, open(out, "w"))
    print(f"aligned: {len(cam)} cameras, {up_agree:.0%} held within 30° of upright; eye height {eye:.3f} units → scale {scale:.3f} m/unit; estimated room height {room_h:.2f} m")


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])

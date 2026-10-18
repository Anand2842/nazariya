"""360° video frames → a virtual multi-camera rig for COLMAP (no numpy needed).

Each equirectangular frame is cut into pinhole views looking in fixed directions (like a rig of real cameras
on one pole: the idea behind multi-camera scanners). Every view sees the room from the same point at the same
time, so the walls behind the camera are always captured too: that is what a phone video lacks.

Usage: python3 pano_rig.py <frames_dir> <out_images_dir> <rig_config.json> [size]
Writes <out_images_dir>/camNN/<frame>.jpg and the COLMAP rig configuration (exact relative rotations).
"""
import json
import math
import os
import subprocess
import sys

# (yaw°, pitch°): 8 around the horizon + 4 looking up. No downward views: the person holding the camera is there.
VIEWS = [(y, 0) for y in range(0, 360, 45)] + [(y, 40) for y in (0, 90, 180, 270)]
# Footage whose lower part is blank (some cameras/exports keep only the upper sphere): look a little higher.
if os.environ.get("PANO_VIEWS") == "upper":
    VIEWS = [(y, 15) for y in range(0, 360, 45)] + [(y, 60) for y in (0, 90, 180, 270)]
FOV = 90


def rot_quat(yaw, pitch):
    """cam_from_rig rotation (w, x, y, z) for a view turned right by yaw and up by pitch (COLMAP axes)."""
    a, b = math.radians(yaw), math.radians(pitch)
    f = [math.sin(a) * math.cos(b), -math.sin(b), math.cos(a) * math.cos(b)]
    r = [math.cos(a), 0.0, -math.sin(a)]
    d = [f[1] * r[2] - f[2] * r[1], f[2] * r[0] - f[0] * r[2], f[0] * r[1] - f[1] * r[0]]
    m = [r, d, f]  # rows: camera axes in rig coordinates → maps rig vectors into the camera frame
    tr = m[0][0] + m[1][1] + m[2][2]
    if tr > 0:
        s = math.sqrt(tr + 1.0) * 2
        q = [0.25 * s, (m[2][1] - m[1][2]) / s, (m[0][2] - m[2][0]) / s, (m[1][0] - m[0][1]) / s]
    elif m[0][0] > m[1][1] and m[0][0] > m[2][2]:
        s = math.sqrt(1.0 + m[0][0] - m[1][1] - m[2][2]) * 2
        q = [(m[2][1] - m[1][2]) / s, 0.25 * s, (m[0][1] + m[1][0]) / s, (m[0][2] + m[2][0]) / s]
    elif m[1][1] > m[2][2]:
        s = math.sqrt(1.0 + m[1][1] - m[0][0] - m[2][2]) * 2
        q = [(m[0][2] - m[2][0]) / s, (m[0][1] + m[1][0]) / s, 0.25 * s, (m[1][2] + m[2][1]) / s]
    else:
        s = math.sqrt(1.0 + m[2][2] - m[0][0] - m[1][1]) * 2
        q = [(m[1][0] - m[0][1]) / s, (m[0][2] + m[2][0]) / s, (m[1][2] + m[2][1]) / s, 0.25 * s]
    return [round(x, 8) for x in q]


def main(frames_dir, out_dir, rig_path, size=960):
    frames = sorted(f for f in os.listdir(frames_dir) if f.lower().endswith(".jpg"))
    cams = []
    for k, (yaw, pitch) in enumerate(VIEWS):
        sub = os.path.join(out_dir, f"cam{k:02d}")
        os.makedirs(sub, exist_ok=True)
        # ffmpeg v360: yaw > 0 turns right, pitch > 0 looks up (verified against a synthetic panorama).
        # Full-range JPEG (yuvj420p): video sources are limited-range, and Brush cannot read limited-range JPEGs.
        vf = f"v360=e:flat:yaw={yaw if yaw <= 180 else yaw - 360}:pitch={pitch}:h_fov={FOV}:v_fov={FOV}:w={size}:h={size}"  # yaw in [-180, 180]
        subprocess.run(["ffmpeg", "-v", "error", "-y", "-pattern_type", "glob", "-i", os.path.join(frames_dir, "*.jpg"), "-vf", vf, "-pix_fmt", "yuvj420p", "-q:v", "3", "-start_number", "1", os.path.join(sub, "frame%04d.jpg")], check=True)
        cam = {"image_prefix": f"cam{k:02d}/"}
        if k == 0:
            cam["ref_sensor"] = True
        else:
            cam["cam_from_rig_rotation"] = rot_quat(yaw, pitch)
            cam["cam_from_rig_translation"] = [0, 0, 0]
        cams.append(cam)
    json.dump([{"cameras": cams}], open(rig_path, "w"), indent=1)
    focal = size / 2 / math.tan(math.radians(FOV / 2))
    print(f"{len(frames)} frames × {len(VIEWS)} views; PINHOLE focal {focal:.1f}px")
    return focal


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2], sys.argv[3], int(sys.argv[4]) if len(sys.argv) > 4 else 960)

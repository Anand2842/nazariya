# Nazariya Studio

**Turn property images into interactive 3D/360° room tours, then embed them in any website or app.**
B2B SaaS for real-estate developers, brokers, PG operators and hotels. Nazariya does not list or sell
properties: customers create tours here and show them on *their* sites and apps.

## What it does

| Input (per room) | What the customer gets |
|---|---|
| **360° image** (2:1 equirectangular from any 360° camera or phone 360° mode) | 360° room **plus an automatic 3D walkthrough** (Gaussian splat), poster and thumbnails |
| **Photos** | Optimised photo gallery for the room (EXIF/GPS stripped) |
| **Walkthrough video** | Sharp stills extracted as photos; 3D via the GPU reconstruction worker (see below) |
| **3D scan** (`.ply`, `.spz`, `.splat`, e.g. exports from Polycam, Scaniverse, Luma, KIRI or XGRIDS) | Imported, compacted to SPZ, desktop and mobile variants |

**Capture straight from the device (no 360° camera needed).** Every room has **📷 Capture with camera**, and
**📱 Capture on phone** shows a QR code with a 2-hour, single-space link that needs no login:
- **Guided 360°**: 30 targets around the user (middle row, upper row, lower row, ceiling, floor), shown **one at a
  time, clockwise**. The user puts the ring on the orange dot, holds still, and the photo is taken automatically.
  The overlay is drawn for the orientation at the moment the on-screen camera frame was captured
  (`requestVideoFrameCallback` capture time + a 2 s sensor buffer), so the dot stays fixed on the wall instead of running
  ahead of the delayed camera picture. Each photo is tagged with the sensor reading closest to its frame time and only taken when
  the phone wandered ≤ 0.6° over 300 ms. The first photo is automatic once the phone is level.
  The server stitches a 4096×2048 equirectangular image:
  - camera FOV is estimated from overlaps;
  - **heading** (the drifting part of phone orientation) is solved globally from pairwise photo matches by least squares,
    while tilt is trusted to gravity;
  - each photo gets a brightness field (exposure, gradient, vignetting);
  - photos are joined with two-band blending (sharp detail from the best photo, smooth brightness from all) and holes are filled.

  Captures that miss parts of the room are rejected. Captures where the phone moved (overlapping photos still
  disagree by more than 4° after alignment) are accepted with a warning in the studio. A `?debug=1` on the capture page
  shows sensor rate, frame-sync mode, camera lag and steadiness.
- **Guided photos**: a shot list per room type ("whole room from a corner", "windows & light", and so on), live
  light/steadiness/level checks, and a grid with a horizon line.
- **Guided walkthrough video**: recorded in the browser with timed on-screen tips; stills are extracted on the server.
- Instructions and a prep checklist come before every capture. In-app captures are marked 📷 in the media list.

**Whole-home tours (Matterport-style).**
- **Floor plan**: every space has a plan (studio → Floor plan). Drag rooms into place, rotate them, and see the measured area in m² / sq ft.
  Doors you add between placed rooms get the matching door back automatically.
- **Viewer**: a minimap with the current room and which way you're facing, tap-to-jump, and a fade when you
  change room. Walking through a door keeps your real-world heading. `?map=0` hides the plan on an embed.

**Depth mode (AR), automatic on supported phones.** When the browser supports WebXR `immersive-ar` (Android
Chrome with ARCore), the 360° capture switches to depth mode. Phones that don't support it use the standard
gyroscope capture.
- AR tracking gives the real phone position: "Phone moved 12 cm: bring it back", and no compass drift.
- Depth (from a time-of-flight sensor where the phone has one, otherwise estimated from motion) **measures the room** (width, length, height,
  camera height, wall angle). The 3D room is then built from **measured depth**, so furniture and alcoves keep their shape at real scale.
- **House walk-through**: capture a room, walk through the door, capture the next. Rooms in one session share a
  coordinate frame, so they are **placed on the floor plan and connected by doors automatically**: the doorway is
  where your walking path left the room.
- **Path 2, true 3D**: while you walk, the phone records keyframes with their AR poses. At the end, the space gets a
  "3D walkthrough" room and a nerfstudio dataset (`images/` + `transforms.json`, metres). With a GPU worker
  configured (`recon/README.md`), it is trained into a real Gaussian-splat scene with known poses (no
  structure-from-motion). Without one, the walkthrough shows photos and says what is missing.
- **iPhone**: websites cannot use the LiDAR scanner (no WebXR in Safari). iPhones use the standard capture. For
  LiDAR scans, export a `.ply` from Polycam / Scaniverse / 3d Scanner App and upload it as a 3D scan.

Then:
- **Hotspots** (feature, info, view, link, "go to room") placed by clicking in the 360° view; they also appear in 3D.
- **Publish → embed**: iframe snippet, **JavaScript SDK** (`/sdk/nazariya.js`: `goToRoom`, `setView`, events),
  share link, mobile-app WebView URL, **oEmbed** for CMSs, **REST API** with API keys.
- **Embed security**: per-tour allow-list of domains, enforced with `Content-Security-Policy: frame-ancestors`
  plus a server-side Referer check.
- **White-label**: brand colour and logo in the viewer; "Powered by Nazariya" removable on Pro.
- **Analytics**: tour opens, renders, room views, hotspot clicks, top embedding websites, device fallbacks.
- **Viewer**: poster-first (light first load), then 3D (three.js + Spark), 360° (Photo Sphere Viewer) or photos,
  chosen by device capability with automatic fallback; works on phones.

## Quick start (local)

Requirements: Node 22+, Homebrew PostgreSQL 14+ (`initdb`, `pg_ctl`), ffmpeg, Google Chrome (for e2e tests).

```bash
npm install
cp .env.example .env.local      # already present for local dev
npm run db:init                 # project-local Postgres cluster in ./.pgdata (port 54329)
npm run db:start
npm run db:reset                # apply migrations (drops dev data)
npm run assets:fetch            # downloads CC0 demo panoramas (Poly Haven) to assets/source
npm run seed                    # demo workspaces + 4 published tours (13 rooms in 3D)
npm run dev                     # http://localhost:3100
npm run worker                  # second terminal: image processing + 3D builds
```

Logins use phone OTP. In dev the code is returned on the login screen and listed at `/dev/outbox`.

| Phone | Role |
|---|---|
| 90000 00002 | Owner of **Nazariya Demo** (published demo tours, Pro plan) |
| 90000 00001 | Owner of **Skyline Homes** (trial, one draft space) |
| 90000 00009 | Platform admin (`/admin`) |

**Capturing on a real phone.** Browsers allow the camera and motion sensors only on HTTPS. On the same Wi-Fi run
`npm run dev:https`, which creates a self-signed certificate for your LAN IP and serves on `https://<LAN-IP>:3443`.
Open that address on the computer and on the phone, and accept the certificate warning once on each. Then use **Capture on phone**
in the studio. The QR code points at the same address. iPhone asks for motion-sensor permission when you tap Start.

Useful pages: `/` (landing with live demo), `/studio`, `/docs` (developer guide),
`/examples/agency-site.html?space=<public id>` (a fictional customer website using the SDK).

## Tests

```bash
npm run test          # unit + integration (resets the *test* database nazariya_test)
npm run test:e2e      # Playwright against the running app (needs seeded dev DB + worker running)
```

- **Unit**: room measurement from depth (off-centre, rotated room with a bed, a doorway and noise → within 6 cm),
  depth panorama, floor-plan geometry (plan↔room transforms, doorway from a walked path, heading continuity, auto-layout); device-orientation maths (canonical poses, yaw/pitch/roll, screen rotation, gimbal lock), frame-time sensor lookup, stillness, one-target-at-a-time order, 360° target coverage; panorama geometry, phone parsing, domain allow-list rules, upload sniffing, embed snippets, audit hashing.
- **Integration (real Postgres)**: depth-mode house capture of a synthetic 2-room flat → both rooms measured
  (±8 cm), placed at the true distance with square walls, doors both ways aimed at the real doorway, 3D from measured
  depth; manual plan with automatic return doors; walkthrough keyframes → nerfstudio dataset → (fake) GPU worker; sensor-guided stitching (≥30 dB vs ground truth with exact orientation;
  FOV recovery and ≥20% seam-error reduction with gyroscope noise); phone frames → stitched 360° → automatic 3D;
  rejection of incomplete or invalid captures; capture links (no login, hashed, space-scoped, expiring); 360° → 360° + automatic 3D; rejection of non-360/blurry/disguised files;
  metadata stripping; `.spz`/`.ply` scan import; video → photos + GPU-worker hook; publish rules and DB guard;
  draft privacy and member preview; cross-workspace isolation; hotspot validation; frame-ancestors; branding/plan
  rules; analytics; API keys (hashed, scoped, revocable); append-only audit with tamper detection; job queue safety.
- **E2E (real Chrome)**: **depth mode on a simulated AR phone** (`tests/e2e/fake-xr.ts`: WebXR with ray-cast depth and
  rendered camera images): capture two rooms, walk through the doorway, finish, and the studio floor plan shows both rooms
  measured and connected; the viewer minimap and door heading continuity; fake-camera tests: guided photos from the studio; **guided 360° on a "phone"** opened from the
  capture link with simulated gyroscope → auto-capture of all 30 targets → upload → stitched 360° + 3D in the studio;
  in-browser video recording + upload; invalid capture links refused; full studio flow (workspace → room → 360° upload → 3D → hotspot → publish → embed code →
  domains → API key → REST call); embed deep links and photo fallback; SDK controlling the tour from a host page;
  domain enforcement; oEmbed; landing; admin; draft privacy; mobile.

## Architecture

```
Next.js 15 (App Router, TypeScript)          scripts/worker.ts (Node)
 ├─ (site)  landing · studio · docs · admin    ├─ media.process: photo / 360° / video / scan import / logo
 ├─ (embed) /embed/:id · /t/:id (no chrome)    ├─ scene.build_from_pano: 360° → Gaussian splat (SPZ)
 ├─ /api/v1 (API keys) · /api/oembed            └─ notifications (dev: outbox; prod: SMS provider)
 ├─ middleware: per-tour frame-ancestors
 └─ /media/* content-addressed public files     PostgreSQL (Drizzle) — jobs queue (SKIP LOCKED), audit chain
```

- `src/server/studio.ts`: workspaces, spaces, rooms, hotspots, publishing, public tour, embed policy, API keys, analytics.
- `src/server/pipeline/*`: image processing (sharp), panorama → splat generator, video/scan handling.
- `src/lib/orientation.ts` (device orientation → camera basis), `src/server/pipeline/stitch.ts` (360° stitcher),
  `src/server/capture.ts` (capture links, 360° submission), `src/components/capture/*` (guided capture UI).
- `src/components/tour/*`: the viewer (`TourViewer`, `SplatView`, `PanoView`).
- `public/sdk/nazariya.js`: embed SDK. `drizzle/`: migrations, including DB-level rules (append-only audit, publish guard).

### Honest limitations
- **Depth mode is tested against a simulated AR phone, not yet on real Android hardware.** Real ARCore depth
  is noisier (worse on glass, mirrors, dark or plain surfaces) and phones differ. Test on 2–3 target phones
  before promising measurements. Measurements are wall-to-wall rectangle estimates (L-shaped rooms get their
  bounding box), not certified carpet area.
- WebXR AR needs Chrome on an ARCore-certified Android phone with "camera access" support. If a feature is missing,
  the app says so and uses the standard capture.
- True 3D (path 2) needs a rented GPU. The worker scripts in `recon/` follow the nerfstudio CLI but were not run
  here (no GPU). The dataset contract is tested with a fake worker.
- **3D from a 360° image** assumes an approximately box-shaped room (editable width/depth/height). It looks right
  from the capture point with natural parallax for small movements, but it is **not a measured reconstruction**,
  and scale is arbitrary. The UI says so.
- **True 3D from ordinary photos or video** needs Structure-from-Motion + Gaussian-splat training on a GPU
  (e.g. GLOMAP → gsplat or Brush, all permissive licences). The worker calls `NAZARIYA_RECON_CMD <framesDir> <outDir>`
  and imports the `scene.spz|ply` it writes. This machine has no CUDA GPU, so that worker is not bundled; until it's
  configured, rooms show photos and a clear status.
- **Phone 360° capture** is hand-held, so the stitch quality depends on the user turning around the phone rather than
  around their body. Swinging the phone ~25 cm around the body shifts nearby walls and corners by up to ~9° in a small
  room (measured on a real capture: 7.5° pair disagreement vs 1.8° for an in-place capture). No rotation-only stitcher
  can remove that, so the app coaches "lens stays put, step around it" and recommends a ₹400–800 tripod. Blank walls give the FOV estimator nothing to work with, and
  then it uses a typical 65° phone FOV. Production 360° cameras (Insta360, Ricoh Theta) still give the best result and are
  supported through upload. The 360° flow was tested with a simulated gyroscope and a fake camera, not yet on physical
  phones. **Test it on a real Android phone and an iPhone before demos.**
- Desktop/laptop webcams have no motion sensors: 360° mode tells the user to use the phone link. Photos and video work on desktop.
- Demo imagery is CC0 (Poly Haven, see `assets/CREDITS.md`). Replace it with real customer captures for sales demos.

`archive/marketplace-v0/` holds the earlier rental-marketplace prototype (listings, pricing, verification).
It is excluded from the build and kept for reference only.

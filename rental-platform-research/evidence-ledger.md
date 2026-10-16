# Evidence Ledger

Research date: 2026-10-15. Every claim the other documents make about Nucleus4D or a third-party tool traces back to a row here.

## Confidence levels

| Level | Meaning |
|---|---|
| **V — Verified** | We observed it directly: a public page, a public network response, public JavaScript, or a browser capture made with REA. |
| **R — Reported** | Stated by Nucleus4D, a press article, a vendor page, or a reseller. We did not check it independently. |
| **I — Inferred** | Our reasoning from V or R evidence. It may be wrong. |
| **U — Unknown** | We could not determine it from public sources. |

## Method

1. Fetched the public marketing pages (`/`, `/partner`).
2. Used REA `capture_browser_scenario` to drive headless Chrome (local install at `/Applications/Google Chrome.app`) through public demo tours linked from the homepage. Captures were made at 1280×800 (desktop) and 390×844 @2x (phone viewport). REA Evidence IDs:
   - `ev_896128f8…1263` (desktop, poster only, no interaction)
   - `ev_e161cb6a…cb4` (desktop, click → progressive load → loaded)
   - `ev_cf3ffcef…5ee1` (mobile viewport, AWE demo)
3. Fetched the same public JSON endpoints the viewer calls anonymously (property metadata, zone metadata, splat metadata), plus the public JavaScript chunks the viewer page loads. We searched those chunks for strings only. We executed nothing and bypassed no authentication.
4. Checked open-source licences through the GitHub API and LICENSE files.
5. Searched the web for press, pricing and regulation.

**Not done:** we did not log in to `studio.nucleus4d.com`, use any private API, replay or misuse access tokens, or download full scene files. The viewer requested a short-lived token from `/api/token`. We did not store it, and the saved evidence contains no token (we checked).

**Limitation:** headless Chrome on macOS renders WebGL in software, so the load times we observed are **not** performance benchmarks.

Saved artifacts: `evidence/screenshots/*`, `evidence/public-metadata/*`, `evidence/network-summary-listivo-tour.tsv`.

---

## A. Nucleus4D: product and company

| ID | Claim | Source | Level |
|---|---|---|---|
| E01 | Positioning: "We use AI to transform physical spaces into interactive 4D experiences, accessible on any device." | https://www.nucleus4d.com/ | V (that the claim is made) |
| E02 | One capture yields: self-guided tour, live guided tour, cinematic video, interactive hotspots (text/audio/video), measurements, floor plans and visitor insights. | nucleus4d.com | R |
| E03 | Workflow: "Scan your space" (one walkthrough with a "capture rig"), then "Upload to Nucleus", then "24 to 48 hours later" deliverables go live. | nucleus4d.com | R |
| E04 | Earlier claim: "What used to take days now takes under two hours." | https://www.auganix.org/xr-news-nucleus4d-10m-sq-ft/ (Sep 2025) | R (conflicts with E03; probably processing time only) |
| E05 | Live guided tour: "You drive the walkthrough, they see your cursor, you talk over voice or video. One host, unlimited attendees." A podcast mentions up to 10 clients. | nucleus4d.com; Prop Media podcast description | R (attendee limits conflict) |
| E06 | Tours publish into the Zillow and realtor.com 3D tour ecosystems. Nucleus4D calls itself the first 3DGS company approved for Zillow. | nucleus4d.com; https://radiancefields.com/nucleus4d-announces-1.5m-funding-round | R |
| E07 | Uses 3D Gaussian Splatting (3DGS). Scenes are "half a gigabyte" versus about 100 GB for photogrammetry. | https://gamesbeat.com/spatial-computing-startup-nucleus4d-announces-1-5-million-pre-seed-round-to-fund-its-goal-of-digitizing-the-world/ | R |
| E08 | Built "using a relatively small number of two-dimensional photos." | GamesBeat | R (vague) |
| E09 | $1.5M pre-seed (Antler, South Loop Ventures), Jan 2026. Launched Q3 2025. Founders: Navjeet Chhina, Paulin Byusa, Miran Brajsa. | Auganix, Radiance Fields, GamesBeat | R |
| E10 | Over 62,235,000 sq ft showcased (homepage). Earlier figures: 10M (Sep 2025), 25M (Jan 2026). | nucleus4d.com; Auganix | R |
| E11 | Pricing: "three cents a square foot per listing per year." | Podcast summary surfaced by web search; no official page | R (low confidence) |
| E12 | No public pricing. Calls to action are "Book a demo" and "Become a partner". Partner programme: white-labelled links, client portal, volume-tiered pricing. | nucleus4d.com, nucleus4d.com/partner | V |
| E13 | Aspiration: "anyone with an ordinary phone or camera to capture a space". A "new capture product designed to 10x our data capture capacity" is being rolled out. | https://austinrobotics.substack.com/p/austin-robotics-featured-startup-fbc (Oct 2026) | R |
| E14 | Industries listed: residential, hospitality, commercial, industrial. Rentals are mentioned only as "buyers, renters, and guests". | nucleus4d.com; Auganix | V |

## B. Nucleus4D: observed viewer and pipeline (direct observation)

| ID | Observation | Evidence | Level |
|---|---|---|---|
| E20 | Tour URL pattern `portal.nucleus4d.com/{client_id}/{property_link_id}?remoteLoading=true`, served by a Next.js app (route chunk `app/[client_id]/[property_link_id]/page-*.js`). | REA network capture | V |
| E21 | With `remoteLoading=true` the page first shows a static poster (a 4K video still, `…wide_4k.mp4_snapshot_….jpg`), a play button and the partner logo. The 3D scene loads only after a click. | Screenshot 01; a11y tree: `img`, `button`, `img "Listivo"` | V |
| E22 | Partner branding is per client: the logo comes from `point_clouds/{client}/branding/…png`, and a custom splash video plays during load. | Network summary; `property-listivo…json` | V |
| E23 | Splat data streams from **splatter.app**, a third-party 3DGS hosting/LOD service: `data.splatter.app/{splatterId}/meta`, then numbered chunks. | Network summary; `zone…json` `viewerProperties.type="splatter"` | V |
| E24 | Splat meta for the Torrey home: `size` 9,431,892 splats, `totalBytes` 117,172,900 (~117 MB), `block` 65,536, `tile` 4, LOD tree `root`. 27 chunks were fetched in ~45 s (chunk 0 = 847,448 bytes), which is far less than the full 117 MB, so loading is view-dependent and progressive. | `splatter-meta-f3b-8mm.json`; HTTP HEAD | V (bytes per view are approximate) |
| E25 | Load is progressive: a blurry coarse scene with a percentage ring ("87%"), then a sharp scene. | Screenshots 02 → 03 | V |
| E26 | Capture device on all four public demos is `"captureDevice":"xgrid"` / `"rawCaptureDevice":"xgrid"`, i.e. XGRIDS hardware. The pipeline stores `xgrids_ply/…/iteration_100/point_cloud.ply` (878 MB for the house, 1.03 GB for AWE) and an XGRIDS `.lcc` result (417 MB zip). | `zone-*.json`; embedded page data for the TwistTours and paradox demos | V (for these 4 demos; not proof of all captures) |
| E27 | The viewer code enumerates capture devices `insta360`, `xgrid`, `generic` and viewer back-ends `lcc` (XGRIDS LCC), `splatter`, `nucleus` (their own). | Public JS chunk string `XGRIDLcc="lcc",Splatter="splatter",Nucleus="nucleus"…insta360="insta360",xgrid="xgrid",generic="generic"` | V (that the enum exists); I (that Insta360/generic captures are in production use) |
| E28 | Rendering stack: **three.js r180** (MIT) plus **Spark** (`SparkRenderer`, `SparkXr`), World Labs' MIT-licensed 3DGS renderer for three.js. | JS strings `REVISION = "180"`, `SparkRenderer options are required` | V |
| E29 | Navigation model: `controlProperties.type = "fps"` (first-person walk) with separate desktop and mobile speed modifiers, keyboard support, an optional on-screen mobile joystick, and click-to-travel "fast travel" with a `halo` cursor and a "rejected" overlay when the target is unreachable. | `zone-nucleus-awe.json`; JS `FastTravelManager`, `fastTravelMode:"halo"` | V |
| E30 | Collision and walkability: a per-scene collider GLB (65 KB for the Torrey house), `meshColliders` (ground planes, cylinders), a `capsuleHeight`/`capsuleRadius` player capsule, and `segmentationBoxes` labelled `structural / wall` that also act as colliders. JS also references RANSAC-derived collisions. | `zone-nucleus-awe.json`; JS `ransacArtifacts.useRansacCollisions` | V |
| E31 | Hotspots ("POIs") are stored as zone JSON: id, icon (`info`/`pointer`), title, description, `imageGallery`, 3D `location`/`rotation`/`scale`, `closeUpDistance`, `travelToActionDistanceThreshold`, `labelWidth`. The AWE demo has 7 POIs, the Torrey house 0. | `zone-nucleus-awe.json` | V |
| E32 | A multi-zone property (the paradox hotel demo has 13 zones, each with its own splatterId) is navigated with a zone dropdown (mobile screenshot: "AWE Lobby ▾"). JS references "portals" between zones and "layouts" (alternative layouts of the same space). | Embedded page data; screenshot 05; JS `selectedLayout`, `portalCallback` | V |
| E33 | Floor-plan and minimap entities exist in the data model: `real-estate-property-floor-plan`, `…-floor-plan-minimap`, `…-minimap-asset`, `segmentation-texture-asset`. The Torrey and AWE demos set `hideFloorMapMenu: true`. | JS strings; zone JSON | V (entities exist); U (how floor plans are generated) |
| E34 | Measurement mode exists in the viewer: `onMeasurementModeClick`, `measurementBaseline`, states `start-measurement` → `measurement-point1` …, plus an "AddMeasurementButton". It is two-point, point-to-point measurement. | JS strings | V (UI exists); U (accuracy) |
| E35 | Live guided tours use the **Zoom Video SDK** (`source.zoom.us/5.1.4/lib/av`), with a `GuidedTourUsageTracker` that has session idle and cutoff timers. | JS strings | V |
| E36 | Camera "rails" (`handleRailChange`, `onRailAnimationPlayingStateChange`) and `isGuidedTourVideoVisible` exist. They are probably used for scripted paths and cinematic video. | JS strings | V (that they exist); I (their purpose) |
| E37 | WebXR modes `immersive-vr` / `immersive-ar` exist in the Spark XR helper. | JS strings | V (library capability); U (whether enabled in the product) |
| E38 | Analytics: Google Analytics plus PostHog (feature flags, surveys). The viewer emits events `view`, `property_session`, `tutorial`, `floor_plan`, `orientation`, `portal`, `property_interaction`. It classifies referrers as `listing_portal` (zillow.com, realtor.com, crmls.org, *.mls.tours), `social`, `cms` (studio.nucleus4d.com), `client_site` or `direct`. | Network summary; JS strings | V |
| E39 | Onboarding: a "Welcome to Nucleus" dialog with "Start Tutorial" / "Skip for now". Persistent bottom-right buttons for recenter (crosshair) and help (?). | Screenshots 03–05; a11y tree | V |
| E40 | Mobile (390 px): same scene, a full-screen layout, a zone selector pill at the top, two round buttons bottom-right. No listing details, price or contact UI is visible in the demos. | Screenshots 04–05 | V |
| E41 | A service worker (`/sw.js`) is registered. Assets go through `/api/viewer-asset` (proxy with bucket keys) and `files.nucleus4d.com` (tokenized), and the splash video comes from CloudFront. One CloudFront splash video returned 403 in our capture (a small broken asset). | Network summary | V |
| E42 | Zone status fields `status`, `isVirtualTourReady`, `isVideoReady`, `isDevMode`, `isSnapshotReadOnly` exist, which suggests a staged publishing workflow. | Zone JSON | V (fields); I (workflow) |
| E43 | `nucleusPointCloudPlaylist` points to `…/iteration_100/rad/master.m3u8`, an HLS-style playlist for point-cloud data, which suggests Nucleus's own streaming format (viewer type `nucleus`). | Zone JSON | V (field); I (purpose) |
| E44 | Scene orientation/scale is stored per zone (`objectRotation` = −90° about X, `globalSceneScale` = 2). This is consistent with an XGRIDS Z-up coordinate frame converted to three.js Y-up. | Zone JSON | V (values); I (interpretation) |

## C. Hardware and third-party tools

| ID | Claim | Source | Level |
|---|---|---|---|
| E50 | XGRIDS PortalCam: a handheld 3DGS capture device with 4 cameras (2 fisheye, 2 front, 4000×3000), LiDAR (~856k pts/s), 512 GB storage, ~60 min battery, output via LCC Studio. Reseller price ~US$10,850 (US). Japan launch ~¥750,000. | Heliguy, aifitlab, openelab, moguravr pages (search results) | R |
| E51 | XGRIDS opened its LCC format (Nov 2025). SuperSplat imports LCC/LCC2. | heliguy.com, radiancefields.com | R |
| E52 | splatter.app plans: Free (non-commercial, branded), Pro $29/mo (20 scenes, "coming soon"), Business $249/mo (100 scenes, three.js/R3F integration), Enterprise (bring your own cloud). LOD streaming from an edge network. Upload is `.ply`. | https://splatter.app/ (fetched 2026-10-15) | R |
| E53 | Spark (sparkjsdev/spark): **MIT**. three.js renderer reading PLY, SPZ, SPLAT, KSPLAT, SOG. Spark 2.0 (Apr 2026) adds LOD streaming. | GitHub API licence = MIT; radiancefields.com | V (licence); R (features) |
| E54 | PlayCanvas engine, SuperSplat, splat-transform: **MIT**. SOG = quantized WebP + meta, "~15–20× smaller than PLY". Streamed SOG = LOD chunks plus `lod-meta.json`. | GitHub API; developer.playcanvas.com | V (licence); R (ratios) |
| E55 | gsplat (nerfstudio): **Apache-2.0**. Brush: **Apache-2.0**. nerfstudio: Apache-2.0. | GitHub API | V |
| E56 | The original Inria `gaussian-splatting` code is **research / non-commercial only** and cannot be used in our product. | LICENSE.md in graphdeco-inria/gaussian-splatting | V |
| E57 | COLMAP: BSD-style (GitHub reports NOASSERTION; the project's own licence is new-BSD). GLOMAP: BSD-3-Clause. | GitHub API; project docs | V (GLOMAP); R (COLMAP wording, recheck before shipping) |
| E58 | Pannellum: MIT. Photo Sphere Viewer: MIT. Marzipano: Apache-2.0 (last push 2023, low maintenance). mkkellogg/GaussianSplats3D: MIT (last push Oct 2025). Niantic SPZ: MIT. three.js: MIT. | GitHub API | V |
| E59 | Phone splat apps: Scaniverse has free on-device splats, with paid tiers ($20/$50 per month) for commercial rights and 360 input. Polycam: Free / Basic $30 per month / Business $400 per year. KIRI Engine: free tier plus Pro. | Secondary sources (skyebrowse, itechguides, 3dmag) | R (prices unverified) |
| E60 | Apple RoomPlan needs a LiDAR iPhone/iPad. Forum reports give ~3 cm object error and walls "often" within 15 cm. We found no controlled study. | developer.apple.com forums | R (anecdotal) |
| E61 | Insta360 X5 India launch price ₹54,990. Listings range ₹54,990–58,990. | thetechoutlook, smartprix | R |
| E62 | Cloudflare R2: $0.015/GB-month, Class A $4.50/M, Class B $0.36/M, **zero egress**. Free tier 10 GB storage. | https://developers.cloudflare.com/r2/pricing/ | V (page fetched) |
| E63 | E2E Networks (India) NVIDIA L4: ~₹49/hr before 18% GST (tier unclear). Prices changed from 1 July 2026. Jarvislabs L4 ~$0.44/hr. | e2enetworks.com pricing (search), jarvislabs | R |

## D. India / Delhi regulatory context (for trust design; **not legal advice**)

| ID | Claim | Source | Level |
|---|---|---|---|
| E70 | Delhi RERA requires real-estate agents to register (Form G, PAN, Aadhaar, ITRs) for transactions involving RERA-registered projects. Whether rental-only brokerage falls under it is **unclear**. | birlaestates.com, housing.com (secondary) | R / U |
| E71 | DPDP Act 2023 and DPDP Rules 2025 (notified 13–14 Nov 2025). Core fiduciary duties (notice, consent, security, breach reporting within 72 h, retention, erasure) apply 18 months after notification, around **May 2027**. | AZB Partners, Storyboard18, Hogan Lovells | R |
| E72 | Delhi Police tenant verification: landlords must inform police about tenants. Online portal and app. Penalty figures in secondary sources are unverified. | kotak.bank.in, housing.com, nobroker.in (secondary) | R |
| E73 | We found no evidence that Delhi has adopted the Model Tenancy Act. | Search (negative result) | U |
| E74 | The Aadhaar Act restricts storing and displaying Aadhaar numbers. Identity checks should use consented flows (e.g. DigiLocker / offline e-KYC) through licensed providers and store only references or masked values. | General knowledge; must be confirmed with counsel | I |

---

## Open questions the ledger cannot answer
See `unknowns-and-risks.md`. The main ones are how Nucleus generates floor plans and measurements and how accurate they are, whether any Nucleus customers capture with phones or Insta360 today, Nucleus's real processing time, and the real cost per scene.

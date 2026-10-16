# Experiments and Acceptance Tests

## Part A: Experiments (Phase 0, before committing to the 3D tier)

Test set: **10 real Delhi units**: 3 PG rooms (single, double, triple sharing), 3 flats (1BHK, 2BHK, 3BHK), 2 hotel rooms, plus deliberately hard zones (2 small bathrooms with mirrors, 1 narrow kitchen, 1 dim room). The owner/occupant gives written consent. No people in the frame.

Reference devices for capture: one mid-range Android (₹15–20k class, 2025–26 model), one older Android (≤ ₹12k), one iPhone (non-Pro), one iPhone Pro (LiDAR), and one Insta360 X-series camera.
Reference devices for viewing: low-end Android (3–4 GB RAM), mid-range Android (6–8 GB RAM), iPhone 12-class, a desktop with integrated graphics. Network is throttled to "4G typical" (≈ 9 Mbps down, 80 ms RTT) and "3G-like" (≈ 1.6 Mbps, 300 ms).

| ID | Question | Method | Metrics | Success threshold |
|---|---|---|---|---|
| **EXP-01** | Is phone-video 3DGS good enough per room type? | Capture each zone with the mid-range Android (60–120 s slow loop, lights on). Pipeline: GLOMAP → gsplat (also Brush for comparison). Hold out 5% of frames. | Hold-out PSNR/SSIM/LPIPS, SfM registration %, splat count, human rating (5 renters rate "would trust to judge the room", 1–5) | ≥ 80% of bedroom/living zones register ≥ 90% of frames and score mean human rating ≥ 3.5 and PSNR ≥ 25 dB *(provisional, calibrate)* |
| **EXP-02** | Does a 360 camera beat a phone for tight spaces? | Same zones with Insta360 (video for splats; stills for T1) | Same as EXP-01, plus capture time | 360 improves bathroom/kitchen pass rate by ≥ 20 points, or the T1 360 stills tier is rated ≥ 3.5 |
| **EXP-03** | Can our target devices view the scenes? | Spark vs PlayCanvas, streamed SOG at 3 LOD budgets, on the device and network matrix | Time to first render, time to target LOD, fps (median/p10), peak memory, crash/context-loss rate, MB transferred | Mid-range Android 4G: first render ≤ 8 s, ≥ 30 fps median, 0 crashes in 20 sessions. Low-end: auto-fallback works 100%. |
| **EXP-04** | Can we put metric scale on phone splats? | Place 2 printed ArUco markers of known size per zone; compute scale; compare 5 distances per room to laser measurements | Absolute and relative error | ≤ 2% or ≤ 5 cm. If not met, measurements stay T3-only. |
| **EXP-05** | Is RoomPlan reliable enough for floor plans? | iPhone Pro RoomPlan on the 6 flat/PG rooms vs laser | Wall length error, area error | Area within ±3%, walls within ±5 cm on ≥ 90% of walls |
| **EXP-06** | What does processing really cost? | Run the pipeline on an L4 (India provider) for every zone; log stage timings | GPU minutes per zone, ₹ per zone, failure rate | Median ≤ ₹40 per zone, failure (no usable output) ≤ 15% |
| **EXP-07** | Do renters value 3D over 360/photos? | Prototype listing pages (same unit) in 3 variants, 30 target renters (students/professionals in Delhi), moderated test plus a click test | Task success ("is there an attached bath? how big is the wardrobe?"), confidence, preference, time | 3D or 360 increases confidence over photos by ≥ 1 point (5-point scale). Pick the tier with the best cost-adjusted score. |
| **EXP-08** | Can brokers capture without us? | 8 brokers, 10-minute in-app tutorial, then capture one unit alone | Completion rate, retakes, pipeline pass rate, time spent, SUS score | ≥ 6/8 produce a publishable T1 listing within 30 min. ≥ 50% produce a passing T2 zone. |
| **EXP-09** | Licensing check of phone-app imports | Read Scaniverse/Polycam/KIRI terms; test PLY/SPZ export → our viewer | Commercial-use rights, export fidelity | Written conclusion. Allowed only if commercial use is explicitly permitted for the tier we would require brokers to use. |
| **EXP-10** | Privacy pass reliability | Faces/photos/documents seeded into 50 frames | Detection recall | ≥ 98% recall for faces; any miss blocks auto-publish (human check) |

Each experiment produces a short report in `experiments/EXP-xx.md` (to be created) with raw numbers, device details and a decision.

## Part B: Acceptance tests (measurable, per MVP)

Format: **Given / When / Then**, with the metric and the measurement method.

### Capture and processing
| ID | Test | Pass criterion |
|---|---|---|
| AT-CAP-1 | Given a broker on the capture PWA with a flaky network, when the upload is interrupted 3 times, then the upload resumes without restarting. | 100% resumption, no duplicate assets |
| AT-CAP-2 | Given a blurry or dark capture, when the session completes, then the broker receives a specific re-capture reason within 10 min. | Reason codes match the injected defect in ≥ 90% of seeded cases |
| AT-CAP-3 | Given a zone that fails quality gates, when processing finishes, then the zone is published as 360/photos and the listing is still publishable. | 100%. Never a broken 3D zone in production. |
| AT-CAP-4 | Capture-to-publish time for T2 | median ≤ 6 h, p95 ≤ 24 h over 50 listings |
| AT-CAP-5 | GPU cost cap enforced | No zone exceeds its cap. Cost recorded on every job. |

### Viewer
| ID | Test | Pass criterion |
|---|---|---|
| AT-VW-1 | Listing page LCP on mid-range Android, 4G | p75 ≤ 2.5 s (lab + RUM) |
| AT-VW-2 | First interactive 3D render after tap | p75 ≤ 8 s (MVP 1), ≤ 5 s (MVP 4) |
| AT-VW-3 | Frame rate in a 3D zone | median ≥ 30 fps, p10 ≥ 24 fps on the reference mid-range Android |
| AT-VW-4 | No blank viewer | ≥ 99% of `tour_open` events are followed by a `render` of some tier within 10 s (RUM) |
| AT-VW-5 | WebGL context loss / OOM injected | Auto-fallback to 360/photos within 1 s. State (room, sheet) preserved. |
| AT-VW-6 | Price consistency | Automated test: rent/deposit/brokerage strings are identical across search card, listing page, viewer sheet, compare table and enquiry confirmation for 100 random listings |
| AT-VW-7 | Deep links | `?zone=` opens the correct room in 100% of tests |
| AT-VW-8 | Accessibility | Listing page passes axe-core with 0 serious violations. The viewer offers a non-3D alternative reachable by keyboard and screen reader. |
| AT-VW-9 | Data budget | p75 bytes per 3D session ≤ 25 MB for the first room |

### Trust and verification
| ID | Test | Pass criterion |
|---|---|---|
| AT-TR-1 | Given a listing whose broker checks are incomplete, then no "ID-checked" badge is rendered (SSR HTML and API). | 0 violations across a property-based test of 10k random check-state combinations |
| AT-TR-2 | Given a passed check that reaches `expires_at`, then the badge disappears. | Within 5 min (scheduler) and immediately at query time |
| AT-TR-3 | Given a listing without a brokerage charge row, when publishing, then publishing is blocked with a clear message. | 100% |
| AT-TR-4 | Given free text containing "verified" or a rent amount different from structured rent, then moderation blocks or flags it. | ≥ 95% on a labelled set of 200 descriptions |
| AT-TR-5 | Duplicate detection on a labelled Delhi set (≥ 300 pairs) | precision ≥ 90%, recall ≥ 80% |
| AT-TR-6 | Stolen-photo test: the same photos uploaded at a different address | A case is created in 100% of 20 seeded attempts |
| AT-TR-7 | Freshness: a PG listing not reconfirmed in 7 days | becomes `stale` (hidden from search) within 1 h of the deadline. Expired after the grace period. |
| AT-TR-8 | Two independent `not_available` reports within 72 h | Listing auto-paused. Lister notified. |
| AT-TR-9 | Audit integrity | Every trust-relevant state change has an audit event in the same transaction (DB trigger test). The hash chain verifies after 1M synthetic events. A tampered row is detected. |
| AT-TR-10 | Unauthorised listing on an exclusively authorised unit | Blocked at publish. Case created. |
| AT-TR-11 | Sensitive evidence access | Every access is logged with the actor and reason. A non-admin cannot fetch it (403). Pre-signed URL TTL ≤ 5 min. |

### Enquiry, visits, outcomes
| ID | Test | Pass criterion |
|---|---|---|
| AT-EN-1 | Enquiry delivery | 100% of enquiries reach the broker inbox. ≥ 98% of WhatsApp/SMS alerts are delivered (provider receipts). Retries on failure. |
| AT-EN-2 | Price snapshot | The enquiry record contains the exact charges shown at submit time |
| AT-EN-3 | Visit lifecycle | All transitions in the state machine are reachable, invalid transitions are rejected, and both parties are notified |
| AT-EN-4 | Phone privacy | The renter's number is not visible to the broker before an enquiry. The broker's number is relayed or masked as configured. |

### Category scenarios (MVP 3)
| ID | Scenario | Pass criterion |
|---|---|---|
| AT-PG-1 | PG with 3 double rooms: mark bed A of room 2 as "notice until 30 Nov" | The listing shows "1 bed in double sharing available from 1 Dec". Search with a move-in date of 1 Dec includes it; 15 Nov excludes it. |
| AT-PG-2 | Change the double-sharing price | A new price-plan version. Old enquiries keep their snapshot. History shows the change date. |
| AT-APT-1 | 2BHK with brokerage = 1 month, deposit = 2 months, maintenance ₹2,500 | The all-in first-month cost is computed and displayed consistently. The compare view sorts by all-in cost. |
| AT-APT-2 | Room-level zones | Every BHK room declared has either a zone or a photo set. Publishing is blocked otherwise. |
| AT-HTL-1 | Hotel with Deluxe (inventory 5): set 0 available on 24 Dec | A search for 23–25 Dec excludes it. A booking request for those dates is blocked. |
| AT-HTL-2 | Taxes | Nightly rate and taxes are shown separately. The total for N nights is computed correctly against a reference calculation. |
| AT-HTL-3 | Representative room | The zone shows the "representative room of this category" label |

### Measurements (MVP 4)
| ID | Test | Pass criterion |
|---|---|---|
| AT-MS-1 | Unvalidated scene | The measure tool is hidden. No numeric dimensions on the page. |
| AT-MS-2 | Validated room | Displayed dimensions are within ±2% / ±5 cm of laser reference values on the test set |
| AT-MS-3 | Declared area | Always labelled "as declared" |

# Cost and Infrastructure Estimates

**All figures are planning estimates**, to be replaced by measured values from EXP-06 (processing cost) and the pilot. Exchange rate assumption ₹88 = US$1. Prices exclude GST (18%) unless stated. Sources: E61–E63. Items marked *(assumption)* have no source and must be validated.

## 1. Unit assumptions

| Item | Value | Basis |
|---|---|---|
| Zones per 2BHK flat | 6 (2 bedrooms, living, kitchen, 2 bathrooms) | Room = zone design |
| Zones per PG | 6–8 (3–4 room types + kitchen/dining + washroom + common area) | |
| Zones per hotel (MVP) | 1 per room category + lobby (3–5) | |
| Raw video per zone | 0.3–1.0 GB (60–120 s, 4K or 1080p60) | Typical phone bitrates *(assumption)* |
| Frames used per zone | 200–400 | Pipeline design |
| Published splat per zone | 8–25 MB (streamed SOG, all LODs) | SOG is ~15–20× smaller than PLY (E54). A 1–1.5M-splat room. *To be measured.* |
| Data per tour session | 15–30 MB (first room plus 1–2 more rooms) | View-dependent LOD. Nucleus fetched ~27 × ~0.85 MB chunks for the first view of a whole house (E24). |
| GPU | NVIDIA L4 at ~₹49/hr (~₹58 with GST) | E63 |

## 2. Per-property processing cost (T2, 3D splat)

| Stage | Compute | Time per zone (estimate) | Cost per zone |
|---|---|---|---|
| Ingest QC, frame extraction, privacy blur | CPU (+ small GPU for detection) | 2–5 min | ₹1–3 |
| SfM (GLOMAP/COLMAP) | CPU / GPU | 5–15 min | ₹3–12 |
| 3DGS training (gsplat/Brush, 7k–30k iterations) | L4 | 10–35 min | ₹10–34 |
| Clean-up, QA render, compress (splat-transform), poster | CPU/GPU | 3–8 min | ₹2–6 |
| **Total per zone** | | **20–60 min** | **₹16–55** |
| **2BHK (6 zones) + 30% retries/overhead** | | | **₹125–430** |

To verify in EXP-06: the time to reach the quality threshold per room type on an L4. Using fewer iterations for small rooms could halve the cost.

T1 (360 panoramas): processing ≈ image resize and tiling only: **< ₹2 per property**.

## 3. Capture cost

| Model | Cost per property | Notes |
|---|---|---|
| Broker self-capture with phone (T0/T1, later T2) | ₹0 cash, about 20–40 min broker time | Needs a good capture app and coaching |
| Platform field capturer (T1/T2) | **₹250–500** *(assumption: ₹20–25k/month salary + ₹4–6k conveyance, 4–6 properties/day in clustered localities)* | Best quality control during the pilot |
| 360 camera amortisation | ₹55 (₹55k kit / 1,000 captures) | E61 |
| Dedicated rig (T4) amortisation | ₹900–1,000+ (₹9–10 lakh / 1,000 captures) plus vendor software | E50. Not in the MVP. |
| Metric layer (T3, laser + RoomPlan on an existing iPhone Pro) | +10–15 min field time ≈ ₹50–100 | |

## 4. Storage and delivery

| Item | Calculation | Monthly cost |
|---|---|---|
| Raw captures retained 90 days | 4 GB/property × 500 new properties/month × 3 months ≈ 6 TB × $0.015 | ~$90 ≈ ₹7,900 |
| Published assets | 0.25 GB/property × 2,000 live properties = 0.5 TB × $0.015 | ~$7.5 ≈ ₹660 |
| Delivery via R2 + Cloudflare | Zero egress (E62). Class B ops ~50 chunk requests/session × 100k sessions = 5M × $0.36/M | ~$1.8 ≈ ₹160 |
| *Alternative*: S3 + CloudFront India | 25 MB × 100k sessions = 2.5 TB × ~$0.11/GB *(approximate CloudFront India rate: verify)* | ~$275 ≈ ₹24,000 |

**Takeaway:** with a zero-egress store, delivery cost is close to zero even at scale. Raw capture retention is the largest storage line, so lifecycle rules (delete or cold-archive raw video after 90 days) matter.

## 5. Fixed platform cost (MVP, monthly)

| Component | Estimate (₹/month) | Notes |
|---|---|---|
| Managed Postgres (2 vCPU / 4–8 GB, Mumbai) with backups | 6,000–10,000 | |
| App containers (2 × small) + load balancer | 5,000–9,000 | |
| Worker CPU container (non-GPU jobs) | 1,500–3,000 | |
| Object storage + CDN | 1,000–9,000 | Scales with raw retention (above) |
| Observability (Sentry/Grafana free→team tiers) | 0–4,000 | |
| Analytics (PostHog cloud free tier / self-host) | 0–3,000 | |
| Domain, email, misc SaaS | 1,000–2,000 | |
| **Subtotal infrastructure** | **₹15,000–40,000** | |

## 6. Per-use third-party costs *(all assumptions, confirm with vendors)*

| Item | Indicative unit cost | Usage driver |
|---|---|---|
| SMS OTP | ₹0.15–0.30 per OTP | logins, enquiries |
| WhatsApp Business messages (utility templates) | ~₹0.1–0.2 per message (Meta per-message pricing, India) | enquiry alerts, reconfirm pings |
| PAN verification API | ₹1–5 per call | broker onboarding |
| DigiLocker / ID KYC flow | ₹5–25 per completed flow | broker onboarding |
| Geocoding | ~$5 per 1,000 after free tier | property creation, search |
| Owner confirmation call (IVR / manual) | ₹2–20 per authorisation | per listing authorisation |

## 7. Scenario: Delhi pilot month (500 new listings, 2,000 live, 100k tour sessions)

| Line | T1-heavy (80% 360, 20% 3D) | 3D-heavy (20% 360, 80% 3D) |
|---|---|---|
| Processing | 100 × ₹300 = ₹30,000 | 400 × ₹300 = ₹1,20,000 |
| Field capture (50% done by platform) | 250 × ₹350 = ₹87,500 | 250 × ₹400 = ₹1,00,000 |
| Storage + delivery | ₹5,000 | ₹9,000 |
| Fixed infra | ₹30,000 | ₹30,000 |
| Messaging, OTP, KYC (≈ 300 new brokers, 20k enquiries) | ₹15,000 | ₹15,000 |
| **Total** | **≈ ₹1.7 lakh** | **≈ ₹2.7 lakh** |
| **Per new listing** | **≈ ₹335** | **≈ ₹550** |

Benchmark: a reported Nucleus price of $0.03 per sq ft per listing per year (E11, low confidence) works out to about ₹2,400/year for a 900 sq ft flat, **plus** a dedicated capture rig. A PG bed renting at ₹8–12k/month cannot carry that. Our per-listing cost must stay under roughly ₹500 to be monetisable through broker subscriptions or lead fees (business model out of scope here).

## 8. Cost controls

1. Per-zone GPU cost caps and early-exit training once hold-out quality plateaus.
2. Reconstruct only zones that need 3D (bedrooms, living). Bathrooms and kitchens default to 360 / photos if their quality gates fail. Small reflective rooms are the hardest for 3DGS.
3. Spot or interruptible GPUs with checkpointed training.
4. Lifecycle rules for raw media: 90 days → cold storage or delete (also good for DPDP minimisation).
5. Cache the first LOD of popular listings at the CDN edge. Use content-hashed keys so nothing is re-uploaded.
6. Don't regenerate scenes on listing edits. Scenes are versioned and edits only touch metadata and hotspots.

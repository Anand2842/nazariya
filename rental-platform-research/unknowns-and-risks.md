# Unknowns and Risks

Likelihood (L) and impact (I): H / M / L. Owners are roles. Evidence IDs refer to `evidence-ledger.md`.

## 1. Unknowns about Nucleus4D (cannot be resolved from public sources)

| ID | Unknown | Why it matters | How we would reduce it |
|---|---|---|---|
| U-N1 | How floor plans are generated (from LiDAR segmentation? manually drawn?) and their accuracy | Sets the bar renters/hotels may expect | Not needed. We design our own validated path (T3). |
| U-N2 | Measurement accuracy of their two-point tool (E34) | Same | Same |
| U-N3 | Whether phone or Insta360 captures are in production (code supports `insta360`/`generic`, E27, but all 4 demos are XGRIDS, E26) | Tells us whether a phone-grade pipeline is commercially viable | EXP-01/02 answer it for *our* market directly |
| U-N4 | Their own training pipeline versus XGRIDS LCC output | Not needed for our design | — |
| U-N5 | Real processing time ("under two hours", E04, vs "24–48 h", E03) | Benchmark for our turnaround promise | EXP-06 |
| U-N6 | Pricing ($0.03/sq ft/yr is low-confidence, E11) | Competitive benchmark | Optional: request a demo / partner pricing |
| U-N7 | Low-end mobile performance | We could not measure it (headless software rendering) | EXP-03 on real devices |
| U-N8 | Whether "Zillow approval" implies technical standards we should match | Low relevance in India | — |

## 2. Product and market unknowns

| ID | Unknown | Resolution |
|---|---|---|
| U-P1 | Will Delhi brokers adopt a capture app and declare brokerage transparently? | EXP-08, pilot with 10–20 brokers. Interviews. |
| U-P2 | Do renters choose based on 3D/360 enough to justify the cost? | EXP-07. MVP 1 funnel metrics. |
| U-P3 | Revenue model (broker subscription, lead fee, owner fee, hotel commission) | Out of scope for this phase. Needs a business workstream. |
| U-P4 | Which hotel channel managers / booking engines are used by Delhi independents, and their API access terms | Market survey before MVP 3 |
| U-P5 | RERA applicability to rental-only brokers in Delhi (E70) | Legal opinion |
| U-P6 | Delhi's position on the Model Tenancy Act (E73) and PG licensing rules (MCD/fire NOC) | Legal opinion. These affect PG listing disclosures. |

## 3. Risk register

| ID | Risk | L | I | Mitigation | Owner |
|---|---|---|---|---|---|
| R1 | Phone-captured splats look poor in small rooms, bathrooms, mirrors and low light | H | H | Per-zone quality gates. Automatic fallback to 360/photos. 360-camera tier. Capture coaching. | CV lead |
| R2 | 3D viewer crashes or stutters on low-end Android, the majority of PG renters' phones | H | H | Capability probe, LOD budgets, fallback tiers. Poster-first. EXP-03 before launch. | Frontend lead |
| R3 | Renters equate realistic visuals with accurate size ("looked bigger") | M | H | No dimensions without validation. Wide-angle distortion warning. Representative-room labels. Disclosure hotspots. | Product |
| R4 | Fake/unauthorised listings undermine trust | H | H | Authorisation plus owner confirmation, pHash cross-checks, reports, freshness, broker scores | Trust lead |
| R5 | Brokers refuse to disclose brokerage, or game "no brokerage" | H | M | Mandatory structured field. Renter outcome capture of actual brokerage paid. Upheld reports reduce ranking. | Product / Trust |
| R6 | Stale availability (beds filled, flats rented) | H | H | Category-specific reconfirm cadence, WhatsApp one-tap, auto-expiry, renter feedback | Ops |
| R7 | Privacy breach: faces, family photos or documents of current occupants in scenes | M | H | Occupant consent. In-app capture guidance. Automated blur and detection. Human check on misses (EXP-10). Takedown SLA. | Trust / CV |
| R8 | Exposure of exact PG addresses creates safety risks (esp. women's PGs) | M | H | Approximate pins. Address revealed after a confirmed enquiry/visit. Safety-report priority. | Product |
| R9 | KYC data handling violates Aadhaar/DPDP rules | M | H | Licensed providers. No raw Aadhaar. Encrypted evidence store. Retention schedule. Counsel review before MVP 2. | Legal / Eng |
| R10 | Licence contamination: using Inria 3DGS code (non-commercial, E56) or AGPL components in the pipeline | M | H | Allow-list: gsplat/Brush (Apache-2.0), GLOMAP/COLMAP (BSD), Spark/PlayCanvas (MIT). SBOM plus licence scan in CI. | Eng lead |
| R11 | Phone-app import path (Scaniverse/Polycam/KIRI) lacks commercial rights or changes terms | M | M | EXP-09. Treat as optional. Our own pipeline is the default. | Product |
| R12 | Vendor lock-in for hosted splat streaming | L | M | Self-host streamed SOG on R2. Hosted service only as a bridge. | Eng |
| R13 | GPU cost overruns from re-captures and retries | M | M | Per-zone caps, early stopping, spot GPUs, cost dashboards | Eng |
| R14 | Discriminatory tenant-preference content (religion, caste, food) creates legal and reputational exposure | M | H | Structured, limited preference fields. Moderation filters. Counsel-approved policy. | Trust / Legal |
| R15 | Disputes over changed terms (deposit, brokerage) after an enquiry | M | M | Price snapshots on enquiries. Versioned price plans. Audit log. | Eng |
| R16 | Rapidly evolving 3DGS tooling (formats, renderer APIs) | H | L | Abstract the renderer behind a `ZoneRenderer` interface. Keep source PLY. Re-run compression when formats change. | Frontend |
| R17 | Hotel inventory shown wrongly (overbooking) | M | M | Enquiry/booking-request mode until a real integration exists. "Check live price" wording. | Product |
| R18 | Scope creep toward a generic digital-twin platform | M | M | Mandate: rental only. Robotics/data licensing excluded. Roadmap exit gates. | Product |
| R19 | Scraping/copying of our listings and scenes by competitors | M | L | Rate limits, signed chunk URLs for scenes (optional), watermarks on posters | Eng |
| R20 | Field-capture operations don't scale beyond the pilot | M | M | Shift to broker self-capture as the app guidance improves (EXP-08). Partner photographers. | Ops |

## 4. Assumptions to revisit

- ₹88/USD. L4 at ~₹49/hr. Raw video ~0.3–1 GB per zone. Published splat ~8–25 MB per zone.
- Brokerage up to one month's rent and deposits of 2–3 months are common in Delhi. These are used only to size UI and examples. **Never default these values into listings.**
- Renters mostly arrive via shared WhatsApp links rather than search, so share previews are a priority.

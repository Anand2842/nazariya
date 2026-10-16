# Nazariya: production readiness map (2026-10-17)

How this was made:
- **Runtime check with REA**: production build (`next build` + `next start`, `DEV_TOOLS` off), headless Chrome at phone size (390×844), visiting a public tour, an embed, `/dev/outbox` and `/login`. REA capture: 45 requests, every one with its headers.
- **HTTP probes**: login codes, API key, private files, uploads, drafts.
- **Earlier work**: test runs and `PRODUCTION.md`.

Status: ✅ verified working · ⚠️ works but not production-grade · ❌ missing.

## Blockers (cannot take a paying customer's data until done)

| # | Gap | Evidence | Fix | Effort |
|---|---|---|---|---|
| B1 | ❌ **Source code is not in its own repository and has no backup.** `nazariya/` sits untracked (`??`) inside the REA tool's git repo, so one disk failure loses the company. | `git status` → `?? ./` | New private GitHub repo, first commit, CI running typecheck + unit tests. | 1 hour |
| B2 | ❌ **Files are stored on local disk** (`storage/`), not in cloud storage. | `PRODUCTION.md` §2; `src/server/storage.ts` | S3/R2 driver behind the existing interface. Publish files through a CDN. | 1–2 days |
| B3 | ❌ **Login codes are not delivered.** The OTP only reaches the dev outbox (now correctly off: `/dev/outbox` → 404 in prod). | REA capture: `/dev/outbox` 404 | MSG91/Gupshup SMS or WhatsApp in `deliverNotifications`. DLT registration takes days, so start now. | 1 day + DLT wait |
| B4 | ⚠️ **No real protection against login-code spam.** 8 OTP requests in a row for one number all returned 200. Cause: `.env.local` sets `OTP_MAX_PER_HOUR=500` for e2e tests, and nothing limits by IP. Every request costs ~₹0.20 of SMS. | curl burst: 8 × `{"ok":true}` | Production env must not set `OTP_MAX_PER_HOUR` (default 6). Add per-IP limits on `/api/auth/*`, `/api/uploads`, `/api/events`, `/api/captures/*`. | ½ day |
| B5 | ❌ **No hosting.** Runs only on this laptop with a self-signed certificate. | — | Managed Postgres (Mumbai) with point-in-time recovery; 2 web instances + 1 worker; real domain + TLS. Camera and motion sensors require HTTPS. | 1–2 days |
| B6 | ❌ **No legal pages**: terms, privacy policy (DPDP Act 2023), refund policy. Payment gateways require them. | — | Lawyer-reviewed templates; customer data-processing clause (we process their buyers' leads). | 2–3 days + lawyer |
| B7 | ❌ **No payments or GST invoices.** | `PRODUCTION.md` "Billing and plans" | Razorpay subscriptions + one-off payment links, GST invoice numbers, plan limits enforced from `Plans` sheet. Manual invoicing is fine for the first 10 customers. | 3–4 days |

## Must fix before scale (first 10–50 customers)

| # | Gap | Evidence | Fix |
|---|---|---|---|
| S1 | ⚠️ **Depth mode and the 3D GPU path are unproven on real hardware.** Depth mode was tested only on a simulated AR phone; the recon scripts have never run on a GPU. | Tests; `recon/README.md` | Test on 2 Android phones (one with a ToF depth sensor). Run one walkthrough on a rented RTX 4090 (~₹60/hour) and measure the GPU minutes that feed the pricing sheet. Until then, **sell 360° tours only**. |
| S2 | ⚠️ **360° capture quality**: your real room showed 6° heading drift and 7.25° pair disagreement, so seams are visible. | `stats.warning` on asset 2352972c… | Tripod (₹400–800) in every field kit; brief capturers on the lens-pivot rule. Use the 360 camera for bathrooms and kitchens. |
| S3 | ⚠️ **Security headers**: no Content-Security-Policy on site pages, no HSTS, `X-Powered-By: Next.js` exposed. | REA response headers on `/`, `/t/…`, `/login` | `poweredByHeader: false`, a CSP for site pages, HSTS once on HTTPS. Embeds already send a per-tour `frame-ancestors`. |
| S4 | ⚠️ **Embed default is "any site may frame"** (`frame-ancestors *` when a tour has no allowed domains). | REA/curl: `/embed/bwdb67wyyu` → `frame-ancestors *` | Fine for growth. Offer domain lock as a Pro feature and nudge customers to set it. |
| S5 | ⚠️ **Unpublished tours answer 200** (with a "not published" message) instead of 404. | curl `/embed/aqnmh5344x` → 200 | Return HTTP 404 (`notFound()`), so search engines and uptime checks see the truth. |
| S6 | ❌ **No error monitoring or uptime alerts.** | No Sentry in `package.json` | Sentry (browser WebGL errors + server), uptime ping on `/api/health`, alert on job-queue depth and failed jobs. |
| S7 | ❌ **No team invites or seats.** Roles exist in the database, but there is no invite screen, and plans sell seats. | `PRODUCTION.md` | Invite by phone or email, plus seat limits per plan. |
| S8 | ❌ **No email login.** Developer marketing teams expect email or Google login. | — | Email magic link. |
| S9 | ⚠️ **Large uploads go through the web server.** | `PRODUCTION.md` §6 | Pre-signed direct-to-bucket uploads for video and scans; proxy limits per route. |
| S10 | ❌ **No privacy blur** for faces or number plates in photos. | `PRODUCTION.md` | Automatic blur on upload (DPDP and good practice). Manual until then. |
| S11 | ⚠️ **No analytics export or lead routing to customers' CRMs.** Developers will ask for this. | — | Webhook + CSV export of leads; later Salesforce, LeadSquared, Sell.Do. |

## Verified working in the production build

- ✅ **Dev tools are off in production**: `/dev/outbox` → 404, and OTP codes are not echoed.
- ✅ **Private files stay private**: `/media/priv/...` → 404. `/api/uploads` without a session → 401. `/api/v1/spaces` without a key → `Invalid or missing API key`.
- ✅ **Files cache well**: published media is content-addressed and served `Cache-Control: public, max-age=31536000, immutable`. Delivery cost stays near zero on R2/CDN (REA headers).
- ✅ **Pages are light on a phone**: the tour page loads a poster first. The first panorama images on mobile were 4–63 KB, and shared JS is 103 kB (`next build` output).
- ✅ **Embeds send** `frame-ancestors` per tour plus a server-side referer check.
- ✅ **Tests**: 62 unit/integration tests and 15 browser tests pass on a production build. Typecheck is clean.

## Order of work (engineering, ~2 weeks for one engineer)

1. **Day 1**: B1 (repo + CI) and B4 env fix.
2. **Days 2–4**: B5 hosting, B2 storage driver, S3 headers, S5 404, S6 monitoring.
3. **Days 4–6**: B3 SMS (start DLT registration on day 1), then email login (S8).
4. **Days 6–9**: B7 Razorpay + invoices + plan limits, S7 invites.
5. **In parallel (founder)**: B6 legal pages. S1 real-phone depth test and one rented-GPU walkthrough. Then update `gpu_min_walk` in the pricing sheet.

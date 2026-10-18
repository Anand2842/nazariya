# Production checklist (for tomorrow)

Everything below is **not yet done**. The app runs and is tested locally with dev adapters.

## Must do before going live
1. **Database**: managed PostgreSQL 15+ (e.g. AWS RDS Mumbai / Neon / Supabase). Set `DATABASE_URL`, run `npm run db:migrate`
   (never `db:reset`). Enable automated backups and point-in-time recovery.
2. **Object storage**: implement the S3/R2 driver behind `src/server/storage.ts` (same interface: `putBuffer`, `getBuffer`,
   `openStream`, `publicUrl`). Serve `pub/*` through a CDN (Cloudflare R2 has zero egress; files are content-addressed and
   immutable, so cache forever). Keep `priv/*` private.
3. **OTP delivery**: replace the dev outbox with an SMS/WhatsApp provider (MSG91, Gupshup, Twilio Verify) in
   `deliverNotifications`. Then **`DEV_TOOLS` must be unset** (it echoes OTP codes).
4. **Secrets**: strong `SESSION_SECRET`, `APP_URL=https://…` (enables secure cookies). Store them in the platform's secret manager.
   Behind a load balancer / TLS proxy also set `INTERNAL_APP_URL` (e.g. `http://127.0.0.1:3100`): the embed
   middleware looks up each tour's allowed domains there; without it the lookup can fail and embeds are blocked.
5. **Processes**: run `npm start` (web, ≥2 instances behind a load balancer) and `npm run worker` (separate service; scale
   horizontally, since jobs are claimed with `FOR UPDATE SKIP LOCKED`). Health check: `GET /api/health`.
6. **Uploads**: put upload size limits at the proxy (360° ≤ 60 MB, video ≤ 800 MB, scans ≤ 500 MB). For large videos and scans,
   switch to direct-to-bucket pre-signed uploads.
7. **Rate limiting** on `/api/auth/*`, `/api/uploads`, `/api/events`, `/api/v1/*` (edge or Redis).
8. **Monitoring**: Sentry (front-end WebGL errors, server errors), logs and metrics for job failures and queue depth.
9. **In-app capture**: a real HTTPS domain is required (phones block camera/sensors on plain HTTP). Test guided 360°
   on at least one recent Android (Chrome) and one iPhone (Safari) before selling it. Set the upload proxy limit for
   `/api/captures/pano` to ≥ 120 MB (40 frames × ≤ 3 MB). Leave `OTP_MAX_PER_HOUR` unset (it is raised only for local e2e).
   Schedule `npm run storage:gc -- --delete` (removes unreferenced files older than 1 h).
10. **Depth mode / house tours**: run `npm run db:migrate` (adds `zones.plan`, `ar_sessions`). Test depth mode
    on real Android phones (one with a ToF sensor, one without). For true 3D, rent a GPU box, build `recon/Dockerfile`
    on it and set `NAZARIYA_RECON_CMD=recon/remote.sh` + `RECON_HOST` on the worker (see `recon/README.md`). Raise the
    proxy upload limit for `/api/captures/ar-room` (≈ 40 MB) and `/api/captures/ar-walk` (≈ 20 MB per batch).
11. **Legal**: terms of service, privacy policy (DPDP Act 2023), cookie notice; replace CC0 demo content with real tours.

## Should do soon
- GPU reconstruction worker for photos/video → 3D (`NAZARIYA_RECON_CMD` contract: read frames dir, write `scene.spz|ply`).
- Team invites and roles (owner/editor/viewer exist in the data model; no invite UI yet).
- Billing and plans (trial/pro/enterprise exist as a field; no payments yet). White-label is already gated on `plan`.
- Email login as an alternative to phone OTP for enterprise users.
- Custom domains for share pages (e.g. `tours.customer.com`).
- Streamed LOD for very large imported scans (Spark 2.x / PlayCanvas streamed SOG).
- Automatic face/number-plate blurring for uploaded images.

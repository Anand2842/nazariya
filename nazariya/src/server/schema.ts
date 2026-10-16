// Nazariya Studio schema (PostgreSQL): workspaces create "spaces" (a flat, room, villa, office, hotel room…),
// each with rooms built from images (360° panoramas, photos, video or imported splat files),
// published as embeddable interactive tours.
import { sql } from "drizzle-orm";
import { bigint, bigserial, boolean, index, integer, jsonb, pgTable, primaryKey, real, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";

const id = () => uuid("id").primaryKey().default(sql`gen_random_uuid()`);
const createdAt = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();
const updatedAt = () => timestamp("updated_at", { withTimezone: true }).notNull().defaultNow();

// ---------- identity & workspaces ----------
export const users = pgTable("users", {
  id: id(),
  phone: text("phone").notNull().unique(), // E.164, verified by OTP
  name: text("name"),
  email: text("email"),
  roles: text("roles").array().notNull().default(sql`'{}'::text[]`), // "admin" for platform staff
  status: text("status").notNull().default("active"),
  createdAt: createdAt(),
});

export const otpCodes = pgTable(
  "otp_codes",
  {
    id: id(),
    phone: text("phone").notNull(),
    purpose: text("purpose").notNull(),
    codeHash: text("code_hash").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    attempts: integer("attempts").notNull().default(0),
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
    context: jsonb("context"),
    createdAt: createdAt(),
  },
  (t) => [index("otp_phone_idx").on(t.phone, t.purpose)],
);

export const sessions = pgTable("sessions", {
  id: text("id").primaryKey(), // sha256 of the cookie token
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: createdAt(),
});

export const organizations = pgTable("organizations", {
  id: id(),
  name: text("name").notNull(),
  website: text("website"),
  plan: text("plan").notNull().default("trial"), // trial | pro | enterprise
  branding: jsonb("branding").notNull().default(sql`'{"primaryColor":"#0f766e","showPoweredBy":true}'::jsonb`),
  status: text("status").notNull().default("active"),
  createdAt: createdAt(),
});

export const memberships = pgTable(
  "memberships",
  {
    orgId: uuid("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    role: text("role").notNull().default("owner"), // owner | editor | viewer
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.orgId, t.userId] })],
);

export const apiKeys = pgTable("api_keys", {
  id: id(),
  orgId: uuid("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  prefix: text("prefix").notNull(), // first chars shown in UI, e.g. "nz_live_ab12"
  keyHash: text("key_hash").notNull().unique(),
  createdBy: uuid("created_by").references(() => users.id),
  lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
  createdAt: createdAt(),
});

/** Short-lived links that let a user capture on another device (e.g. their phone) without logging in there. */
export const captureLinks = pgTable("capture_links", {
  id: id(),
  tokenHash: text("token_hash").notNull().unique(),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  spaceId: uuid("space_id").notNull().references(() => spaces.id, { onDelete: "cascade" }),
  zoneId: uuid("zone_id"),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
  uses: integer("uses").notNull().default(0),
  createdAt: createdAt(),
});

// ---------- spaces & rooms ----------
export const spaces = pgTable(
  "spaces",
  {
    id: id(),
    orgId: uuid("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
    publicId: text("public_id").notNull().unique(), // used in embed/share URLs
    name: text("name").notNull(),
    kind: text("kind").notNull().default("apartment"), // apartment | room | villa | office | hotel_room | retail | other
    address: text("address"),
    description: text("description").notNull().default(""),
    externalRef: text("external_ref"), // customer's own listing/property id for API lookups
    status: text("status").notNull().default("draft"), // draft | published | archived
    allowedDomains: text("allowed_domains").array().notNull().default(sql`'{}'::text[]`), // empty = embeddable anywhere
    settings: jsonb("settings").notNull().default(sql`'{"defaultTier":"auto","showRoomList":true,"autoRotate":false}'::jsonb`),
    branding: jsonb("branding"), // overrides organisation branding
    posterAssetId: uuid("poster_asset_id"),
    publishedAt: timestamp("published_at", { withTimezone: true }),
    createdBy: uuid("created_by").references(() => users.id),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("spaces_org_idx").on(t.orgId, t.status), uniqueIndex("spaces_org_extref_uq").on(t.orgId, t.externalRef)],
);

export const mediaAssets = pgTable(
  "media_assets",
  {
    id: id(),
    orgId: uuid("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
    spaceId: uuid("space_id").references(() => spaces.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(), // photo | pano | video | splat | logo
    status: text("status").notNull().default("uploaded"), // uploaded | processing | ready | rejected
    rejectReason: text("reject_reason"),
    storageKey: text("storage_key").notNull(),
    originalName: text("original_name"),
    mime: text("mime"),
    bytes: bigint("bytes", { mode: "number" }),
    sha256: text("sha256"),
    width: integer("width"),
    height: integer("height"),
    durationS: real("duration_s"),
    blurScore: real("blur_score"),
    variants: jsonb("variants").notNull().default(sql`'{}'::jsonb`),
    meta: jsonb("meta").notNull().default(sql`'{}'::jsonb`),
    createdAt: createdAt(),
  },
  (t) => [index("media_space_idx").on(t.spaceId, t.kind)],
);

export const zones = pgTable(
  "zones",
  {
    id: id(),
    spaceId: uuid("space_id").notNull().references(() => spaces.id, { onDelete: "cascade" }),
    label: text("label").notNull(),
    roomType: text("room_type").notNull().default("room"),
    sort: integer("sort").notNull().default(0),
    panoAssetId: uuid("pano_asset_id").references(() => mediaAssets.id, { onDelete: "set null" }),
    splatAssetId: uuid("splat_asset_id").references(() => mediaAssets.id, { onDelete: "set null" }),
    photoAssetIds: uuid("photo_asset_ids").array().notNull().default(sql`'{}'::uuid[]`),
    roomDims: jsonb("room_dims").notNull().default(sql`'{"w":4,"d":4.5,"h":2.9,"camH":1.5}'::jsonb`),
    startYaw: real("start_yaw").notNull().default(0),
    splatSource: text("splat_source"), // generated_from_pano | imported | reconstructed
    splatTransform: jsonb("splat_transform").notNull().default(sql`'{"flip":false,"yawDeg":0,"scale":1}'::jsonb`),
    splatStatus: text("splat_status").notNull().default("none"), // none | queued | processing | ready | failed | qa_failed | needs_gpu_worker
    splatNote: text("splat_note"),
    // Where the room sits on the space's floor plan: capture point (metres) and the plan direction of the
    // room's 360° yaw 0. Null = not placed. source: manual (dragged in studio) | ar (measured while walking).
    plan: jsonb("plan"),
  },
  (t) => [index("zones_space_idx").on(t.spaceId)],
);

/**
 * One AR (depth + motion tracking) capture session on a phone. Rooms captured in the same session share a
 * coordinate frame, so they are placed on the floor plan and connected by doors automatically.
 */
export const arSessions = pgTable("ar_sessions", {
  id: uuid("id").primaryKey(), // generated on the phone
  spaceId: uuid("space_id").notNull().references(() => spaces.id, { onDelete: "cascade" }),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  // AR world → floor-plan transform, fixed when the session's first room is placed.
  worldToPlan: jsonb("world_to_plan"),
  lastZoneId: uuid("last_zone_id"),
  device: text("device"),
  createdAt: createdAt(),
});

export const hotspots = pgTable("hotspots", {
  id: id(),
  zoneId: uuid("zone_id").notNull().references(() => zones.id, { onDelete: "cascade" }),
  type: text("type").notNull(), // info | amenity | door_to_zone | view | link
  yaw: real("yaw").notNull(),
  pitch: real("pitch").notNull(),
  position: jsonb("position"),
  targetZoneId: uuid("target_zone_id"),
  title: text("title").notNull(),
  body: text("body").notNull().default(""),
  url: text("url"),
  createdBy: uuid("created_by").references(() => users.id),
  createdAt: createdAt(),
});

// ---------- platform ----------
export const jobs = pgTable(
  "jobs",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    kind: text("kind").notNull(),
    payload: jsonb("payload").notNull().default(sql`'{}'::jsonb`),
    status: text("status").notNull().default("queued"),
    attempts: integer("attempts").notNull().default(0),
    maxAttempts: integer("max_attempts").notNull().default(3),
    runAfter: timestamp("run_after", { withTimezone: true }).notNull().defaultNow(),
    lockedBy: text("locked_by"),
    lockedAt: timestamp("locked_at", { withTimezone: true }),
    lastError: text("last_error"),
    result: jsonb("result"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("jobs_pick_idx").on(t.status, t.runAfter)],
);

export const notifications = pgTable("notifications", {
  id: id(),
  userId: uuid("user_id").references(() => users.id),
  toPhone: text("to_phone"),
  channel: text("channel").notNull(),
  template: text("template").notNull(),
  body: text("body").notNull(),
  payload: jsonb("payload").notNull().default(sql`'{}'::jsonb`),
  status: text("status").notNull().default("queued"),
  sentAt: timestamp("sent_at", { withTimezone: true }),
  createdAt: createdAt(),
});

export const auditEvents = pgTable(
  "audit_events",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
    actorUserId: uuid("actor_user_id"),
    actorRole: text("actor_role").notNull(),
    action: text("action").notNull(),
    subjectType: text("subject_type").notNull(),
    subjectId: text("subject_id").notNull(),
    data: jsonb("data").notNull().default(sql`'{}'::jsonb`),
    prevHash: text("prev_hash").notNull(),
    hash: text("hash").notNull(),
  },
  (t) => [index("audit_subject_idx").on(t.subjectType, t.subjectId)],
);

export const viewEvents = pgTable(
  "view_events",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
    spaceId: uuid("space_id").references(() => spaces.id, { onDelete: "cascade" }),
    zoneId: uuid("zone_id"),
    name: text("name").notNull(), // tour_open | tour_first_render | zone_view | hotspot_open | tour_fallback | tier_switch
    sessionId: text("session_id"),
    referrerHost: text("referrer_host"),
    surface: text("surface"), // embed | share | studio_preview | api
    props: jsonb("props").notNull().default(sql`'{}'::jsonb`),
  },
  (t) => [index("view_space_idx").on(t.spaceId, t.occurredAt)],
);

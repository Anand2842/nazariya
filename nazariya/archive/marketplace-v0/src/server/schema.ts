// Nazariya database schema (PostgreSQL). Mirrors research/rental-data-model.md.
// Money is stored as bigint paise. Trust-relevant tables are append-only or versioned.
import { sql } from "drizzle-orm";
import {
  bigint,
  bigserial,
  boolean,
  date,
  doublePrecision,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  primaryKey,
  real,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

const id = () => uuid("id").primaryKey().default(sql`gen_random_uuid()`);
const createdAt = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();
const updatedAt = () => timestamp("updated_at", { withTimezone: true }).notNull().defaultNow();
const paise = (name: string) => bigint(name, { mode: "number" });

// ---------- identity ----------
export const users = pgTable("users", {
  id: id(),
  phone: text("phone").notNull().unique(), // E.164
  name: text("name"),
  email: text("email"),
  roles: text("roles").array().notNull().default(sql`'{renter}'::text[]`),
  status: text("status").notNull().default("active"),
  createdAt: createdAt(),
});

export const otpCodes = pgTable(
  "otp_codes",
  {
    id: id(),
    phone: text("phone").notNull(),
    purpose: text("purpose").notNull(), // login | owner_confirmation
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
  type: text("type").notNull(), // brokerage | pg_operator | property_manager | hotel | owner_individual
  displayName: text("display_name").notNull(),
  legalName: text("legal_name"),
  gstin: text("gstin"),
  reraAgentNo: text("rera_agent_no"),
  city: text("city").notNull().default("Delhi"),
  status: text("status").notNull().default("active"),
  createdAt: createdAt(),
});

export const memberships = pgTable(
  "memberships",
  {
    orgId: uuid("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    role: text("role").notNull().default("owner"), // owner | admin | agent
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.orgId, t.userId] })],
);

export const brokerProfiles = pgTable("broker_profiles", {
  userId: uuid("user_id").primaryKey().references(() => users.id, { onDelete: "cascade" }),
  displayName: text("display_name").notNull(),
  localities: text("localities").array().notNull().default(sql`'{}'::text[]`),
  languages: text("languages").array().notNull().default(sql`'{}'::text[]`),
  activeSince: date("active_since"),
  createdAt: createdAt(),
});

export const localities = pgTable("localities", {
  id: text("id").primaryKey(), // slug
  name: text("name").notNull(),
  city: text("city").notNull().default("Delhi"),
  zone: text("zone"),
  lat: doublePrecision("lat").notNull(),
  lng: doublePrecision("lng").notNull(),
  nearestMetro: text("nearest_metro"),
});

// ---------- physical inventory ----------
export const properties = pgTable(
  "properties",
  {
    id: id(),
    category: text("category").notNull(), // pg | apartment | house | hotel | guesthouse
    name: text("name"),
    addressLine: text("address_line").notNull(),
    localityId: text("locality_id").notNull().references(() => localities.id),
    city: text("city").notNull().default("Delhi"),
    pincode: text("pincode"),
    lat: doublePrecision("lat").notNull(),
    lng: doublePrecision("lng").notNull(),
    normalizedAddress: text("normalized_address").notNull(),
    floorsTotal: integer("floors_total"),
    amenities: text("amenities").array().notNull().default(sql`'{}'::text[]`),
    houseRules: jsonb("house_rules").notNull().default(sql`'{}'::jsonb`),
    createdByOrgId: uuid("created_by_org_id").notNull().references(() => organizations.id),
    dedupeClusterId: uuid("dedupe_cluster_id"),
    status: text("status").notNull().default("active"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("properties_locality_idx").on(t.localityId), index("properties_geo_idx").on(t.lat, t.lng)],
);

export const units = pgTable(
  "units",
  {
    id: id(),
    propertyId: uuid("property_id").notNull().references(() => properties.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(), // flat | house | pg_room | hotel_room_type | room_in_flat
    label: text("label").notNull(),
    floor: integer("floor"),
    bhk: integer("bhk"),
    bathrooms: integer("bathrooms"),
    balconies: integer("balconies"),
    attachedBath: boolean("attached_bath"),
    ac: boolean("ac"),
    furnishing: text("furnishing"), // unfurnished | semi | full
    sharingCapacity: integer("sharing_capacity"), // PG
    maxOccupancy: integer("max_occupancy"), // hotel
    inventoryCount: integer("inventory_count"), // hotel room type
    declaredAreaSqft: integer("declared_area_sqft"),
    amenities: text("amenities").array().notNull().default(sql`'{}'::text[]`),
    attributes: jsonb("attributes").notNull().default(sql`'{}'::jsonb`),
    sort: integer("sort").notNull().default(0),
    createdAt: createdAt(),
  },
  (t) => [index("units_property_idx").on(t.propertyId)],
);

export const beds = pgTable("beds", {
  id: id(),
  unitId: uuid("unit_id").notNull().references(() => units.id, { onDelete: "cascade" }),
  label: text("label").notNull(),
  status: text("status").notNull().default("vacant"), // vacant | occupied | notice | reserved | blocked
  statusSince: timestamp("status_since", { withTimezone: true }).notNull().defaultNow(),
  noticeUntil: date("notice_until"),
  reservedUntil: date("reserved_until"),
});

export const ownerContacts = pgTable("owner_contacts", {
  id: id(),
  propertyId: uuid("property_id").notNull().references(() => properties.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  phone: text("phone").notNull(),
  relationship: text("relationship").notNull().default("owner"),
  consentAt: timestamp("consent_at", { withTimezone: true }),
  createdAt: createdAt(),
});

export const propertyAuthorizations = pgTable("property_authorizations", {
  id: id(),
  propertyId: uuid("property_id").notNull().references(() => properties.id, { onDelete: "cascade" }),
  orgId: uuid("org_id").notNull().references(() => organizations.id),
  unitIds: uuid("unit_ids").array(),
  basis: text("basis").notNull(), // owner_self | owner_mandate | operator_lease | hotel_management
  exclusive: boolean("exclusive").notNull().default(false),
  validFrom: date("valid_from").notNull(),
  validUntil: date("valid_until"),
  status: text("status").notNull().default("pending"), // pending | active | revoked | expired | rejected
  ownerContactId: uuid("owner_contact_id").references(() => ownerContacts.id),
  createdAt: createdAt(),
});

// ---------- listings ----------
export const listings = pgTable(
  "listings",
  {
    id: id(),
    shortId: text("short_id").notNull().unique(),
    slug: text("slug").notNull().unique(),
    propertyId: uuid("property_id").notNull().references(() => properties.id),
    orgId: uuid("org_id").notNull().references(() => organizations.id),
    listerUserId: uuid("lister_user_id").notNull().references(() => users.id),
    authorizationId: uuid("authorization_id").references(() => propertyAuthorizations.id),
    category: text("category").notNull(), // pg | rent | short_stay
    scope: text("scope").notNull(), // beds | units | room_types | whole_property
    title: text("title").notNull(),
    description: text("description").notNull().default(""),
    terms: jsonb("terms").notNull().default(sql`'{}'::jsonb`),
    status: text("status").notNull().default("draft"), // draft | pending_review | published | stale | expired | paused | suspended | closed
    publishedAt: timestamp("published_at", { withTimezone: true }),
    lastConfirmedAt: timestamp("last_confirmed_at", { withTimezone: true }),
    lastConfirmedBy: text("last_confirmed_by"),
    posterAssetId: uuid("poster_asset_id"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("listings_status_idx").on(t.status, t.category), index("listings_property_idx").on(t.propertyId)],
);

export const listingUnits = pgTable(
  "listing_units",
  {
    listingId: uuid("listing_id").notNull().references(() => listings.id, { onDelete: "cascade" }),
    unitId: uuid("unit_id").notNull().references(() => units.id, { onDelete: "cascade" }),
  },
  (t) => [primaryKey({ columns: [t.listingId, t.unitId] })],
);

export const pricePlans = pgTable(
  "price_plans",
  {
    id: id(),
    listingId: uuid("listing_id").notNull().references(() => listings.id, { onDelete: "cascade" }),
    unitId: uuid("unit_id").references(() => units.id),
    planKey: text("plan_key").notNull(), // stable key across versions, e.g. "bed_double", "unit_monthly", "rt:<unitId>"
    appliesTo: text("applies_to").notNull(), // bed_single | bed_double | bed_triple | bed_quad | unit_monthly | room_type_nightly
    label: text("label").notNull(),
    basePaise: paise("base_paise").notNull(),
    period: text("period").notNull(), // month | night
    mealPlan: text("meal_plan"),
    version: integer("version").notNull().default(1),
    effectiveFrom: timestamp("effective_from", { withTimezone: true }).notNull().defaultNow(),
    supersededAt: timestamp("superseded_at", { withTimezone: true }),
    createdBy: uuid("created_by").references(() => users.id),
    createdAt: createdAt(),
  },
  (t) => [index("price_plans_listing_idx").on(t.listingId, t.planKey)],
);

export const charges = pgTable("charges", {
  id: id(),
  pricePlanId: uuid("price_plan_id").notNull().references(() => pricePlans.id, { onDelete: "cascade" }),
  code: text("code").notNull(), // security_deposit | brokerage | maintenance | electricity | water | food | admission_fee | parking | tax | extra_bed | lock_in_penalty
  mode: text("mode").notNull(), // fixed | months_of_rent | percent | metered | included | none
  amountPaise: paise("amount_paise"),
  months: numeric("months", { mode: "number" }),
  percent: numeric("percent", { mode: "number" }),
  recurrence: text("recurrence").notNull(), // one_time | monthly | nightly
  refundable: boolean("refundable").notNull().default(false),
  mandatory: boolean("mandatory").notNull().default(true),
  note: text("note"),
});

export const availability = pgTable("availability", {
  id: id(),
  unitId: uuid("unit_id").notNull().references(() => units.id, { onDelete: "cascade" }),
  availableFrom: date("available_from").notNull(),
  minLeaseMonths: integer("min_lease_months"),
  status: text("status").notNull().default("available"), // available | let_out | on_hold
  source: text("source").notNull().default("lister"),
  confirmedAt: timestamp("confirmed_at", { withTimezone: true }).notNull().defaultNow(),
  createdAt: createdAt(),
});

export const nightlyInventory = pgTable(
  "nightly_inventory",
  {
    unitId: uuid("unit_id").notNull().references(() => units.id, { onDelete: "cascade" }),
    date: date("date").notNull(),
    availableCount: integer("available_count").notNull(),
    ratePaise: paise("rate_paise").notNull(),
    minStay: integer("min_stay").notNull().default(1),
    closedToArrival: boolean("closed_to_arrival").notNull().default(false),
    syncedAt: timestamp("synced_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.unitId, t.date] })],
);

// ---------- capture, media, tours ----------
export const captureSessions = pgTable("capture_sessions", {
  id: id(),
  propertyId: uuid("property_id").notNull().references(() => properties.id, { onDelete: "cascade" }),
  userId: uuid("user_id").notNull().references(() => users.id),
  device: text("device"),
  tier: text("tier").notNull().default("T0"),
  lat: doublePrecision("lat"),
  lng: doublePrecision("lng"),
  inApp: boolean("in_app").notNull().default(true),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
  completedAt: timestamp("completed_at", { withTimezone: true }),
});

export const mediaAssets = pgTable(
  "media_assets",
  {
    id: id(),
    orgId: uuid("org_id").references(() => organizations.id),
    propertyId: uuid("property_id").references(() => properties.id, { onDelete: "cascade" }),
    unitId: uuid("unit_id").references(() => units.id, { onDelete: "set null" }),
    captureSessionId: uuid("capture_session_id").references(() => captureSessions.id),
    kind: text("kind").notNull(), // photo | pano | video | splat | document
    status: text("status").notNull().default("uploaded"), // uploaded | processing | ready | rejected
    rejectReason: text("reject_reason"),
    storageKey: text("storage_key").notNull(),
    originalName: text("original_name"),
    mime: text("mime"),
    bytes: bigint("bytes", { mode: "number" }),
    sha256: text("sha256"),
    dhash: text("dhash"),
    width: integer("width"),
    height: integer("height"),
    durationS: real("duration_s"),
    blurScore: real("blur_score"),
    privacyStatus: text("privacy_status").notNull().default("pending"), // pending | clean | needs_review | rejected
    visibility: text("visibility").notNull().default("public"), // public | private
    variants: jsonb("variants").notNull().default(sql`'{}'::jsonb`),
    meta: jsonb("meta").notNull().default(sql`'{}'::jsonb`),
    createdAt: createdAt(),
  },
  (t) => [index("media_property_idx").on(t.propertyId, t.kind), index("media_sha_idx").on(t.sha256)],
);

export const tours = pgTable("tours", {
  id: id(),
  propertyId: uuid("property_id").notNull().references(() => properties.id, { onDelete: "cascade" }),
  version: integer("version").notNull().default(1),
  status: text("status").notNull().default("draft"),
  createdAt: createdAt(),
});

export const zones = pgTable(
  "zones",
  {
    id: id(),
    tourId: uuid("tour_id").notNull().references(() => tours.id, { onDelete: "cascade" }),
    unitId: uuid("unit_id").references(() => units.id, { onDelete: "set null" }),
    label: text("label").notNull(),
    roomType: text("room_type").notNull(), // bedroom | living | kitchen | bathroom | common | dining | balcony | lobby | room
    sort: integer("sort").notNull().default(0),
    panoAssetId: uuid("pano_asset_id").references(() => mediaAssets.id, { onDelete: "set null" }),
    splatAssetId: uuid("splat_asset_id").references(() => mediaAssets.id, { onDelete: "set null" }),
    photoAssetIds: uuid("photo_asset_ids").array().notNull().default(sql`'{}'::uuid[]`),
    roomDims: jsonb("room_dims").notNull().default(sql`'{"w":4,"d":4.5,"h":2.9,"camH":1.5}'::jsonb`),
    startYaw: real("start_yaw").notNull().default(0),
    splatStatus: text("splat_status").notNull().default("none"), // none | queued | processing | ready | failed | qa_failed | needs_gpu_worker
    splatNote: text("splat_note"),
    scaleStatus: text("scale_status").notNull().default("arbitrary"), // arbitrary | scaled_unvalidated | validated
  },
  (t) => [index("zones_tour_idx").on(t.tourId)],
);

export const hotspots = pgTable("hotspots", {
  id: id(),
  zoneId: uuid("zone_id").notNull().references(() => zones.id, { onDelete: "cascade" }),
  type: text("type").notNull(), // room_label | amenity | issue_disclosure | door_to_zone | view | info
  yaw: real("yaw").notNull(),
  pitch: real("pitch").notNull(),
  position: jsonb("position"), // [x,y,z] in tour space (derived from yaw/pitch + room dims)
  targetZoneId: uuid("target_zone_id"),
  title: text("title").notNull(),
  body: text("body").notNull().default(""),
  locked: boolean("locked").notNull().default(false),
  createdBy: uuid("created_by").references(() => users.id),
  createdAt: createdAt(),
});

// ---------- engagement ----------
export const enquiries = pgTable(
  "enquiries",
  {
    id: id(),
    listingId: uuid("listing_id").notNull().references(() => listings.id),
    unitId: uuid("unit_id").references(() => units.id),
    planKey: text("plan_key"),
    renterUserId: uuid("renter_user_id").notNull().references(() => users.id),
    moveInDate: date("move_in_date"),
    stayFrom: date("stay_from"),
    stayTo: date("stay_to"),
    guests: integer("guests").notNull().default(1),
    message: text("message").notNull().default(""),
    status: text("status").notNull().default("new"), // new | responded | visit_scheduled | closed_won | closed_lost | spam
    priceSnapshot: jsonb("price_snapshot").notNull(),
    firstResponseAt: timestamp("first_response_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("enquiries_listing_idx").on(t.listingId), index("enquiries_renter_idx").on(t.renterUserId)],
);

export const enquiryMessages = pgTable("enquiry_messages", {
  id: id(),
  enquiryId: uuid("enquiry_id").notNull().references(() => enquiries.id, { onDelete: "cascade" }),
  senderRole: text("sender_role").notNull(), // renter | lister | system
  senderUserId: uuid("sender_user_id").references(() => users.id),
  body: text("body").notNull(),
  createdAt: createdAt(),
});

export const visits = pgTable("visits", {
  id: id(),
  enquiryId: uuid("enquiry_id").notNull().references(() => enquiries.id, { onDelete: "cascade" }),
  mode: text("mode").notNull().default("in_person"), // in_person | video
  slotStart: timestamp("slot_start", { withTimezone: true }).notNull(),
  slotEnd: timestamp("slot_end", { withTimezone: true }).notNull(),
  status: text("status").notNull().default("proposed"), // proposed | confirmed | completed | no_show_renter | no_show_lister | cancelled
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const rentalOutcomes = pgTable("rental_outcomes", {
  enquiryId: uuid("enquiry_id").primaryKey().references(() => enquiries.id, { onDelete: "cascade" }),
  outcome: text("outcome").notNull(), // rented_here | rented_elsewhere | not_rented | listing_unavailable | misleading
  reportedBy: text("reported_by").notNull(), // renter | lister
  finalRentPaise: paise("final_rent_paise"),
  brokeragePaidPaise: paise("brokerage_paid_paise"),
  createdAt: createdAt(),
});

export const bookings = pgTable("bookings", {
  id: id(),
  listingId: uuid("listing_id").notNull().references(() => listings.id),
  unitId: uuid("unit_id").notNull().references(() => units.id),
  renterUserId: uuid("renter_user_id").notNull().references(() => users.id),
  stayFrom: date("stay_from").notNull(),
  stayTo: date("stay_to").notNull(),
  guests: integer("guests").notNull().default(1),
  quote: jsonb("quote").notNull(),
  status: text("status").notNull().default("requested"), // requested | confirmed | declined | cancelled
  createdAt: createdAt(),
});

// ---------- trust ----------
export const verificationChecks = pgTable(
  "verification_checks",
  {
    id: id(),
    subjectType: text("subject_type").notNull(), // user | organization | property | authorization | listing | capture_session
    subjectId: uuid("subject_id").notNull(),
    checkType: text("check_type").notNull(),
    status: text("status").notNull().default("pending"), // pending | passed | failed | expired | revoked | needs_review
    method: text("method").notNull(), // automated | provider | manual
    provider: text("provider"),
    providerRef: text("provider_ref"),
    data: jsonb("data").notNull().default(sql`'{}'::jsonb`), // masked values only
    reason: text("reason"),
    decidedBy: uuid("decided_by").references(() => users.id),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [index("checks_subject_idx").on(t.subjectType, t.subjectId), index("checks_status_idx").on(t.status)],
);

export const verificationEvidence = pgTable("verification_evidence", {
  id: id(),
  checkId: uuid("check_id").notNull().references(() => verificationChecks.id, { onDelete: "cascade" }),
  kind: text("kind").notNull(), // document_image | provider_response | call_record | geo_capture | note
  storageKey: text("storage_key"),
  sha256: text("sha256"),
  note: text("note"),
  createdAt: createdAt(),
});

export const moderationCases = pgTable("moderation_cases", {
  id: id(),
  kind: text("kind").notNull(), // report | dispute | duplicate | verification_appeal
  listingId: uuid("listing_id").references(() => listings.id),
  subject: jsonb("subject").notNull().default(sql`'{}'::jsonb`),
  priority: text("priority").notNull().default("normal"), // safety | fraud | normal
  status: text("status").notNull().default("open"), // open | awaiting_party | decided | closed
  slaDueAt: timestamp("sla_due_at", { withTimezone: true }),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const reports = pgTable("reports", {
  id: id(),
  listingId: uuid("listing_id").notNull().references(() => listings.id),
  reporterUserId: uuid("reporter_user_id").references(() => users.id),
  reason: text("reason").notNull(),
  details: text("details").notNull().default(""),
  status: text("status").notNull().default("open"),
  caseId: uuid("case_id").references(() => moderationCases.id),
  createdAt: createdAt(),
});

export const moderationDecisions = pgTable("moderation_decisions", {
  id: id(),
  caseId: uuid("case_id").notNull().references(() => moderationCases.id),
  decision: text("decision").notNull(), // no_action | edit_required | suspend_listing | remove_listing | restore_listing | link_same_property | mark_different
  rationale: text("rationale").notNull(),
  decidedBy: uuid("decided_by").notNull().references(() => users.id),
  decidedAt: timestamp("decided_at", { withTimezone: true }).notNull().defaultNow(),
});

export const dedupeCandidates = pgTable(
  "dedupe_candidates",
  {
    id: id(),
    propertyA: uuid("property_a").notNull().references(() => properties.id, { onDelete: "cascade" }),
    propertyB: uuid("property_b").notNull().references(() => properties.id, { onDelete: "cascade" }),
    score: real("score").notNull(),
    signals: jsonb("signals").notNull(),
    status: text("status").notNull().default("open"), // open | same_property | different
    caseId: uuid("case_id").references(() => moderationCases.id),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("dedupe_pair_uq").on(t.propertyA, t.propertyB)],
);

// ---------- platform ----------
export const jobs = pgTable(
  "jobs",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    kind: text("kind").notNull(),
    payload: jsonb("payload").notNull().default(sql`'{}'::jsonb`),
    status: text("status").notNull().default("queued"), // queued | running | done | failed | dead
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
  channel: text("channel").notNull(), // whatsapp | sms
  template: text("template").notNull(),
  body: text("body").notNull(),
  payload: jsonb("payload").notNull().default(sql`'{}'::jsonb`),
  status: text("status").notNull().default("queued"), // queued | sent | failed
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

export const analyticsEvents = pgTable(
  "analytics_events",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    name: text("name").notNull(),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
    anonId: text("anon_id"),
    userId: uuid("user_id"),
    listingId: uuid("listing_id"),
    props: jsonb("props").notNull().default(sql`'{}'::jsonb`),
  },
  (t) => [index("analytics_listing_idx").on(t.listingId, t.name)],
);

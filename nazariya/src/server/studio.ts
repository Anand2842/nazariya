// Nazariya Studio: workspaces build "spaces" (tours) from images and publish them for embedding.
import { createHash, randomBytes } from "node:crypto";
import { and, asc, desc, eq, gte, inArray, isNull, ne, sql } from "drizzle-orm";
import { z } from "zod";
import type { PlanPlacement } from "@/lib/floorplan";
import { positionFromYawPitch, validateRoomDims, type RoomDims } from "@/lib/pano-geometry";
import { addReturnDoor } from "./house";
import { writeAudit } from "./audit";
import type { SessionUser } from "./auth";
import { db, type Exec } from "./db";
import { DomainError, shortId } from "./errors";
import { enqueue } from "./jobs";
import { apiKeys, hotspots, mediaAssets, memberships, organizations, spaces, users, viewEvents, zones } from "./schema";
import { publicUrl } from "./storage";

// ---------- access ----------

export function workspaceOf(user: SessionUser, orgId?: string) {
  const org = orgId ? user.orgs.find((o) => o.id === orgId) : user.orgs[0];
  if (!org) throw new DomainError("Create your workspace first", "forbidden");
  return org;
}

function canEdit(role: string) {
  return role === "owner" || role === "editor";
}

export async function loadSpace(user: SessionUser, spaceId: string, opts: { edit?: boolean } = { edit: true }, exec: Exec = db) {
  const [s] = await exec.select().from(spaces).where(eq(spaces.id, spaceId));
  if (!s) throw new DomainError("Space not found", "not_found");
  const m = user.orgs.find((o) => o.id === s.orgId);
  if (!m && !user.roles.includes("admin")) throw new DomainError("Not in your workspace", "forbidden");
  if (opts.edit && m && !canEdit(m.role)) throw new DomainError("Your role is read-only", "forbidden");
  return s;
}

export async function loadZone(user: SessionUser, zoneId: string) {
  const [z] = await db.select().from(zones).where(eq(zones.id, zoneId));
  if (!z) throw new DomainError("Room not found", "not_found");
  const s = await loadSpace(user, z.spaceId);
  return { zone: z, space: s };
}

// ---------- workspaces ----------

export const workspaceSchema = z.object({
  name: z.string().trim().min(2).max(80),
  yourName: z.string().trim().min(2).max(80),
  website: z.string().trim().max(200).optional().nullable(),
});

export async function createWorkspace(user: SessionUser, input: z.input<typeof workspaceSchema>) {
  const v = workspaceSchema.parse(input);
  const website = v.website ? normalizeWebsite(v.website) : null;
  return db.transaction(async (tx) => {
    const [org] = await tx.insert(organizations).values({ name: v.name, website }).returning();
    await tx.insert(memberships).values({ orgId: org.id, userId: user.id, role: "owner" });
    await tx.update(users).set({ name: v.yourName }).where(eq(users.id, user.id));
    await writeAudit(tx, { actorUserId: user.id, actorRole: "owner", action: "workspace.created", subjectType: "organization", subjectId: org.id });
    return org;
  });
}

function normalizeWebsite(w: string): string {
  const s = w.startsWith("http") ? w : `https://${w}`;
  try {
    return new URL(s).origin;
  } catch {
    throw new DomainError("Enter a valid website address");
  }
}

export const brandingSchema = z.object({
  primaryColor: z.string().regex(/^#[0-9a-fA-F]{6}$/, "Use a hex colour like #0f766e"),
  showPoweredBy: z.boolean(),
  logoAssetId: z.string().uuid().nullable().optional(),
});

export async function updateWorkspaceBranding(user: SessionUser, orgId: string, input: z.input<typeof brandingSchema>) {
  const org = workspaceOf(user, orgId);
  if (org.role !== "owner") throw new DomainError("Only the workspace owner can change branding", "forbidden");
  const v = brandingSchema.parse(input);
  const [o] = await db.select().from(organizations).where(eq(organizations.id, orgId));
  // Removing the "Powered by Nazariya" badge is a paid-plan feature.
  if (!v.showPoweredBy && o.plan === "trial") throw new DomainError("Removing the Nazariya badge requires the Pro plan", "blocked");
  await db.transaction(async (tx) => {
    await tx.update(organizations).set({ branding: v }).where(eq(organizations.id, orgId));
    await writeAudit(tx, { actorUserId: user.id, actorRole: "owner", action: "workspace.branding_updated", subjectType: "organization", subjectId: orgId, data: v });
  });
}

// ---------- spaces ----------

export const spaceSchema = z.object({
  name: z.string().trim().min(2).max(100),
  kind: z.enum(["apartment", "room", "villa", "office", "hotel_room", "retail", "other"]).default("apartment"),
  address: z.string().trim().max(200).optional().nullable(),
  description: z.string().trim().max(2000).default(""),
  externalRef: z.string().trim().max(100).optional().nullable(),
});

export async function createSpace(user: SessionUser, input: z.input<typeof spaceSchema>, orgId?: string) {
  const org = workspaceOf(user, orgId);
  if (!canEdit(org.role)) throw new DomainError("Your role is read-only", "forbidden");
  const v = spaceSchema.parse(input);
  return db.transaction(async (tx) => {
    const [s] = await tx
      .insert(spaces)
      .values({ orgId: org.id, publicId: shortId(10), name: v.name, kind: v.kind, address: v.address || null, description: v.description, externalRef: v.externalRef || null, createdBy: user.id })
      .returning();
    await writeAudit(tx, { actorUserId: user.id, actorRole: org.role, action: "space.created", subjectType: "space", subjectId: s.id });
    return s;
  });
}

export const spaceUpdateSchema = spaceSchema.partial().extend({
  allowedDomains: z.array(z.string()).max(20).optional(),
  settings: z
    .object({ defaultTier: z.enum(["auto", "3d", "360", "photos"]), showRoomList: z.boolean(), autoRotate: z.boolean(), showFloorPlan: z.boolean().default(true) })
    .partial()
    .optional(),
});

/** "www.Example.com/path" → "www.example.com"; "*.example.com" allowed; rejects garbage. */
export function normalizeDomain(raw: string): string {
  let s = raw.trim().toLowerCase();
  if (!s) throw new DomainError("Empty domain");
  s = s.replace(/^https?:\/\//, "").replace(/\/.*$/, "");
  if (!/^(\*\.)?([a-z0-9-]+\.)*[a-z0-9-]+(:\d{2,5})?$/.test(s)) throw new DomainError(`"${raw}" is not a valid domain`);
  return s;
}

export async function updateSpace(user: SessionUser, spaceId: string, input: z.input<typeof spaceUpdateSchema>) {
  const s = await loadSpace(user, spaceId);
  const v = spaceUpdateSchema.parse(input);
  const patch: Partial<typeof spaces.$inferInsert> = { updatedAt: new Date() };
  if (v.name !== undefined) patch.name = v.name;
  if (v.kind !== undefined) patch.kind = v.kind;
  if (v.address !== undefined) patch.address = v.address || null;
  if (v.description !== undefined) patch.description = v.description;
  if (v.externalRef !== undefined) patch.externalRef = v.externalRef || null;
  if (v.allowedDomains !== undefined) patch.allowedDomains = [...new Set(v.allowedDomains.filter((d) => d.trim()).map(normalizeDomain))];
  if (v.settings) patch.settings = { ...(s.settings as object), ...v.settings };
  await db.transaction(async (tx) => {
    await tx.update(spaces).set(patch).where(eq(spaces.id, spaceId));
    await writeAudit(tx, { actorUserId: user.id, actorRole: "editor", action: "space.updated", subjectType: "space", subjectId: spaceId, data: { fields: Object.keys(patch) } });
  });
}

export async function publishChecklist(spaceId: string) {
  const errors: string[] = [];
  const warnings: string[] = [];
  const zs = await db.select().from(zones).where(eq(zones.spaceId, spaceId));
  if (!zs.length) errors.push("Add at least one room");
  const assetIds = zs.flatMap((z) => [z.panoAssetId, ...z.photoAssetIds].filter((x): x is string => !!x));
  const ready = assetIds.length ? await db.select({ id: mediaAssets.id }).from(mediaAssets).where(and(inArray(mediaAssets.id, assetIds), eq(mediaAssets.status, "ready"))) : [];
  const readyIds = new Set(ready.map((r) => r.id));
  for (const z of zs) {
    const ok = (z.panoAssetId && readyIds.has(z.panoAssetId)) || z.photoAssetIds.some((p) => readyIds.has(p)) || z.splatStatus === "ready";
    if (!ok) errors.push(`"${z.label}" needs a processed 360° image, photos or 3D scene`);
  }
  if (zs.length && !zs.some((z) => z.panoAssetId || z.splatStatus === "ready")) warnings.push("No 360° or 3D room yet: the tour will show photos only");
  if (zs.some((z) => z.panoAssetId) && !zs.some((z) => z.splatStatus === "ready")) warnings.push("Optional: build 3D walkthroughs from your 360° images");
  const pending = await db.select({ id: mediaAssets.id }).from(mediaAssets).where(and(eq(mediaAssets.spaceId, spaceId), inArray(mediaAssets.status, ["uploaded", "processing"])));
  if (pending.length) warnings.push(`${pending.length} upload(s) still processing`);
  return { errors: [...new Set(errors)], warnings };
}

export async function publishSpace(user: SessionUser, spaceId: string) {
  const s = await loadSpace(user, spaceId);
  const check = await publishChecklist(spaceId);
  if (check.errors.length) throw new DomainError("Fix these before publishing", "blocked", check.errors);
  await db.transaction(async (tx) => {
    const poster = s.posterAssetId ?? (await choosePoster(tx, spaceId));
    await tx.update(spaces).set({ status: "published", publishedAt: s.publishedAt ?? new Date(), posterAssetId: poster, updatedAt: new Date() }).where(eq(spaces.id, spaceId));
    await writeAudit(tx, { actorUserId: user.id, actorRole: "editor", action: "space.published", subjectType: "space", subjectId: spaceId });
  });
}

export async function unpublishSpace(user: SessionUser, spaceId: string, archive = false) {
  await loadSpace(user, spaceId);
  await db.transaction(async (tx) => {
    await tx.update(spaces).set({ status: archive ? "archived" : "draft", updatedAt: new Date() }).where(eq(spaces.id, spaceId));
    await writeAudit(tx, { actorUserId: user.id, actorRole: "editor", action: archive ? "space.archived" : "space.unpublished", subjectType: "space", subjectId: spaceId });
  });
}

async function choosePoster(tx: Exec, spaceId: string): Promise<string | null> {
  const zs = await tx.select().from(zones).where(eq(zones.spaceId, spaceId)).orderBy(asc(zones.sort));
  for (const z of zs) if (z.panoAssetId) return z.panoAssetId;
  for (const z of zs) if (z.photoAssetIds[0]) return z.photoAssetIds[0];
  return null;
}

export async function setPoster(user: SessionUser, spaceId: string, assetId: string) {
  await loadSpace(user, spaceId);
  const [a] = await db.select().from(mediaAssets).where(and(eq(mediaAssets.id, assetId), eq(mediaAssets.spaceId, spaceId), eq(mediaAssets.status, "ready")));
  if (!a) throw new DomainError("Pick a processed image from this space");
  await db.update(spaces).set({ posterAssetId: assetId }).where(eq(spaces.id, spaceId));
}

// ---------- rooms (zones) ----------

export async function createZone(user: SessionUser, spaceId: string, input: { label: string; roomType?: string }) {
  await loadSpace(user, spaceId);
  const label = input.label.trim();
  if (!label || label.length > 60) throw new DomainError("Give the room a name (max 60 characters)");
  const [{ n }] = await db.select({ n: sql<number>`count(*)::int` }).from(zones).where(eq(zones.spaceId, spaceId));
  if (n >= 60) throw new DomainError("A space can have at most 60 rooms");
  const [z] = await db.insert(zones).values({ spaceId, label, roomType: input.roomType ?? "room", sort: n }).returning();
  return z;
}

export async function updateZone(
  user: SessionUser,
  zoneId: string,
  input: { label?: string; roomType?: string; roomDims?: Partial<RoomDims>; startYaw?: number },
) {
  const { zone } = await loadZone(user, zoneId);
  const patch: Partial<typeof zones.$inferInsert> = {};
  if (input.label !== undefined) {
    if (!input.label.trim()) throw new DomainError("Room name cannot be empty");
    patch.label = input.label.trim().slice(0, 60);
  }
  if (input.roomType !== undefined) patch.roomType = input.roomType;
  if (input.startYaw !== undefined && Number.isFinite(input.startYaw)) patch.startYaw = input.startYaw;
  // Editing the shape by hand replaces any phone measurement.
  if (input.roomDims) patch.roomDims = validateRoomDims({ ...(zone.roomDims as RoomDims), ...input.roomDims, measured: false });
  await db.update(zones).set(patch).where(eq(zones.id, zoneId));
  if (input.roomDims) {
    const hs = await db.select().from(hotspots).where(eq(hotspots.zoneId, zoneId));
    for (const h of hs) await db.update(hotspots).set({ position: positionFromYawPitch(h.yaw, h.pitch, patch.roomDims as RoomDims) }).where(eq(hotspots.id, h.id));
  }
}

export async function moveZone(user: SessionUser, zoneId: string, dir: -1 | 1) {
  const { zone } = await loadZone(user, zoneId);
  const all = await db.select().from(zones).where(eq(zones.spaceId, zone.spaceId)).orderBy(asc(zones.sort), asc(zones.label));
  const i = all.findIndex((z) => z.id === zoneId);
  const j = i + dir;
  if (j < 0 || j >= all.length) return;
  [all[i], all[j]] = [all[j], all[i]];
  await db.transaction(async (tx) => {
    for (let k = 0; k < all.length; k++) await tx.update(zones).set({ sort: k }).where(eq(zones.id, all[k].id));
  });
}

export async function deleteZone(user: SessionUser, zoneId: string) {
  const { zone } = await loadZone(user, zoneId);
  await db.transaction(async (tx) => {
    await tx.update(hotspots).set({ targetZoneId: null }).where(eq(hotspots.targetZoneId, zoneId));
    await tx.delete(hotspots).where(and(eq(hotspots.type, "door_to_zone"), isNull(hotspots.targetZoneId)));
    await tx.delete(zones).where(eq(zones.id, zoneId));
    await writeAudit(tx, { actorUserId: user.id, actorRole: "editor", action: "room.deleted", subjectType: "space", subjectId: zone.spaceId, data: { label: zone.label } });
  });
}

export async function requestSplatBuild(user: SessionUser, zoneId: string) {
  const { zone } = await loadZone(user, zoneId);
  if (!zone.panoAssetId) throw new DomainError("Add a 360° image to this room first");
  await db.transaction(async (tx) => {
    await tx.update(zones).set({ splatStatus: "queued", splatNote: null }).where(eq(zones.id, zoneId));
    await enqueue(tx, "scene.build_from_pano", { zoneId });
  });
}

const hotspotSchema = z.object({
  type: z.enum(["info", "amenity", "door_to_zone", "view", "link"]),
  yaw: z.number().min(-Math.PI * 2).max(Math.PI * 2),
  pitch: z.number().min(-Math.PI / 2).max(Math.PI / 2),
  title: z.string().trim().min(1).max(60),
  body: z.string().trim().max(500).default(""),
  url: z.string().trim().url().max(500).optional().nullable(),
  targetZoneId: z.string().uuid().optional().nullable(),
});

export async function addHotspot(user: SessionUser, zoneId: string, input: z.input<typeof hotspotSchema>) {
  const { zone } = await loadZone(user, zoneId);
  const v = hotspotSchema.parse(input);
  if (v.type === "door_to_zone") {
    if (!v.targetZoneId) throw new DomainError("Choose which room this leads to");
    const [t] = await db.select().from(zones).where(and(eq(zones.id, v.targetZoneId), eq(zones.spaceId, zone.spaceId)));
    if (!t) throw new DomainError("Target room is not in this space");
  }
  if (v.type === "link" && !v.url) throw new DomainError("Add the link URL");
  if (v.url && !/^https:\/\//.test(v.url)) throw new DomainError("Links must use https://");
  const [h] = await db
    .insert(hotspots)
    .values({ ...v, url: v.url ?? null, targetZoneId: v.targetZoneId ?? null, zoneId, position: positionFromYawPitch(v.yaw, v.pitch, zone.roomDims as RoomDims), createdBy: user.id })
    .returning();
  // On a floor plan we know where the doorway is, so the way back is added automatically.
  if (v.type === "door_to_zone" && v.targetZoneId) await addReturnDoor(user.id, zone, v.targetZoneId, v.yaw);
  return h;
}

export async function deleteHotspot(user: SessionUser, hotspotId: string) {
  const [h] = await db.select().from(hotspots).where(eq(hotspots.id, hotspotId));
  if (!h) throw new DomainError("Hotspot not found", "not_found");
  await loadZone(user, h.zoneId);
  await db.delete(hotspots).where(eq(hotspots.id, hotspotId));
}

// ---------- read models ----------

export function mediaUrls(a: typeof mediaAssets.$inferSelect | undefined | null) {
  if (!a) return null;
  const v = (a.variants ?? {}) as Record<string, string>;
  const u = (k: string) => (v[k] ? publicUrl(v[k]) : null);
  return { id: a.id, kind: a.kind, full: u("full"), mobile: u("mobile"), thumb: u("thumb"), poster: u("poster"), desktop: u("desktop"), meta: a.meta as Record<string, unknown> };
}

export async function getTourZones(spaceId: string) {
  const zs = await db.select().from(zones).where(eq(zones.spaceId, spaceId)).orderBy(asc(zones.sort), asc(zones.label));
  const assetIds = [...new Set(zs.flatMap((z) => [z.panoAssetId, z.splatAssetId, ...z.photoAssetIds].filter((x): x is string => !!x)))];
  const assets = assetIds.length ? await db.select().from(mediaAssets).where(and(inArray(mediaAssets.id, assetIds), eq(mediaAssets.status, "ready"))) : [];
  const byId = new Map(assets.map((a) => [a.id, a]));
  const hs = zs.length ? await db.select().from(hotspots).where(inArray(hotspots.zoneId, zs.map((z) => z.id))) : [];
  return zs.map((z) => {
    const pano = z.panoAssetId ? mediaUrls(byId.get(z.panoAssetId)) : null;
    const splat = z.splatStatus === "ready" && z.splatAssetId ? mediaUrls(byId.get(z.splatAssetId)) : null;
    return {
      id: z.id,
      label: z.label,
      roomType: z.roomType,
      startYaw: z.startYaw,
      roomDims: z.roomDims as RoomDims,
      plan: (z.plan as PlanPlacement | null) ?? null,
      splatStatus: z.splatStatus,
      splatNote: z.splatNote,
      splatSource: z.splatSource,
      splatTransform: z.splatTransform as { flip: boolean; yawDeg: number; scale: number; offset?: [number, number, number] },
      pano: pano ? { url: pano.full, mobileUrl: pano.mobile, thumb: pano.thumb, poster: pano.poster } : null,
      splat: splat ? { url: splat.desktop ?? splat.full, mobileUrl: splat.mobile ?? splat.desktop ?? splat.full, splats: (splat.meta?.splatsDesktop as number) ?? null, bytes: (splat.meta?.bytesDesktop as number) ?? null } : null,
      photos: z.photoAssetIds
        .map((pid) => mediaUrls(byId.get(pid)))
        .filter((m): m is NonNullable<typeof m> => !!m)
        .map((m) => ({ id: m.id, url: m.full!, thumb: m.thumb! })),
      hotspots: hs
        .filter((h) => h.zoneId === z.id)
        .map((h) => ({ id: h.id, type: h.type, yaw: h.yaw, pitch: h.pitch, position: h.position as [number, number, number] | null, title: h.title, body: h.body, url: h.url, targetZoneId: h.targetZoneId })),
    };
  });
}

export type TourZone = Awaited<ReturnType<typeof getTourZones>>[number];

export interface Branding {
  primaryColor: string;
  showPoweredBy: boolean;
  logoUrl: string | null;
  orgName: string;
}

async function brandingFor(space: typeof spaces.$inferSelect): Promise<Branding> {
  const [org] = await db.select().from(organizations).where(eq(organizations.id, space.orgId));
  const b = { ...(org.branding as Record<string, unknown>), ...((space.branding as Record<string, unknown>) ?? {}) } as { primaryColor?: string; showPoweredBy?: boolean; logoAssetId?: string | null };
  let logoUrl: string | null = null;
  if (b.logoAssetId) {
    const [l] = await db.select().from(mediaAssets).where(and(eq(mediaAssets.id, b.logoAssetId), eq(mediaAssets.status, "ready")));
    logoUrl = mediaUrls(l)?.full ?? null;
  }
  return { primaryColor: b.primaryColor ?? "#0f766e", showPoweredBy: org.plan === "trial" ? true : b.showPoweredBy !== false, logoUrl, orgName: org.name };
}

/** Everything an embed/share viewer needs. Drafts are visible only to workspace members (preview). */
export async function getPublicTour(publicId: string, viewer: SessionUser | null = null) {
  const [s] = await db.select().from(spaces).where(eq(spaces.publicId, publicId));
  if (!s) return null;
  const member = !!viewer && (viewer.orgs.some((o) => o.id === s.orgId) || viewer.roles.includes("admin"));
  if (s.status !== "published" && !member) return null;
  const zonesData = await getTourZones(s.id);
  const [posterAsset] = s.posterAssetId ? await db.select().from(mediaAssets).where(eq(mediaAssets.id, s.posterAssetId)) : [];
  const poster = mediaUrls(posterAsset);
  return {
    space: { id: s.id, publicId: s.publicId, name: s.name, kind: s.kind, address: s.address, description: s.description, status: s.status, settings: s.settings as { defaultTier: string; showRoomList: boolean; autoRotate: boolean; showFloorPlan?: boolean }, allowedDomains: s.allowedDomains },
    zones: zonesData,
    posterUrl: poster?.poster ?? poster?.full ?? zonesData.find((z) => z.pano?.poster)?.pano?.poster ?? zonesData.find((z) => z.photos[0])?.photos[0].url ?? null,
    branding: await brandingFor(s),
    preview: s.status !== "published",
  };
}

export type PublicTour = NonNullable<Awaited<ReturnType<typeof getPublicTour>>>;

// ---------- embed domain policy ----------

export function hostMatches(host: string, allowed: string[]): boolean {
  if (!allowed.length) return true;
  const h = host.toLowerCase();
  return allowed.some((a) => (a.startsWith("*.") ? h === a.slice(2) || h.endsWith(a.slice(1)) : h === a));
}

/** CSP frame-ancestors value for a published space (empty allow-list = any site). */
export async function frameAncestorsFor(publicId: string): Promise<string | null> {
  const [s] = await db.select({ allowed: spaces.allowedDomains, status: spaces.status }).from(spaces).where(eq(spaces.publicId, publicId));
  if (!s) return null;
  const self = "'self'";
  if (!s.allowed.length) return "*";
  return [self, ...s.allowed.flatMap((d) => [`https://${d}`, `http://${d}`])].join(" ");
}

// ---------- studio read models ----------

export async function listSpaces(user: SessionUser, orgId?: string) {
  const org = workspaceOf(user, orgId);
  const rows = await db.select().from(spaces).where(and(eq(spaces.orgId, org.id), ne(spaces.status, "archived"))).orderBy(desc(spaces.updatedAt));
  if (!rows.length) return [];
  const zoneCounts = await db
    .select({ spaceId: zones.spaceId, rooms: sql<number>`count(*)::int`, threeD: sql<number>`count(*) filter (where ${zones.splatStatus} = 'ready')::int` })
    .from(zones)
    .where(inArray(zones.spaceId, rows.map((r) => r.id)))
    .groupBy(zones.spaceId);
  const since = new Date(Date.now() - 30 * 86400_000);
  const views = await db
    .select({ spaceId: viewEvents.spaceId, n: sql<number>`count(*)::int` })
    .from(viewEvents)
    .where(and(inArray(viewEvents.spaceId, rows.map((r) => r.id)), eq(viewEvents.name, "tour_open"), gte(viewEvents.occurredAt, since)))
    .groupBy(viewEvents.spaceId);
  const posters = rows.map((r) => r.posterAssetId).filter((x): x is string => !!x);
  const pa = posters.length ? await db.select().from(mediaAssets).where(inArray(mediaAssets.id, posters)) : [];
  return rows.map((r) => ({
    ...r,
    rooms: zoneCounts.find((z) => z.spaceId === r.id)?.rooms ?? 0,
    threeD: zoneCounts.find((z) => z.spaceId === r.id)?.threeD ?? 0,
    views30d: views.find((v) => v.spaceId === r.id)?.n ?? 0,
    poster: mediaUrls(pa.find((p) => p.id === r.posterAssetId))?.poster ?? mediaUrls(pa.find((p) => p.id === r.posterAssetId))?.thumb ?? null,
  }));
}

export async function spaceEditorData(user: SessionUser, spaceId: string) {
  const s = await loadSpace(user, spaceId, { edit: false });
  const [tour, media, checklist, stats] = await Promise.all([
    getTourZones(s.id),
    db.select().from(mediaAssets).where(eq(mediaAssets.spaceId, s.id)).orderBy(desc(mediaAssets.createdAt)),
    publishChecklist(s.id),
    spaceStats(s.id),
  ]);
  const zoneRows = await db.select().from(zones).where(eq(zones.spaceId, s.id)).orderBy(asc(zones.sort));
  return { space: s, tour, zones: zoneRows, media: media.map((m) => ({ ...m, urls: mediaUrls(m) })), checklist, stats };
}

export async function spaceStats(spaceId: string, days = 30) {
  const since = new Date(Date.now() - days * 86400_000);
  const byName = await db
    .select({ name: viewEvents.name, n: sql<number>`count(*)::int` })
    .from(viewEvents)
    .where(and(eq(viewEvents.spaceId, spaceId), gte(viewEvents.occurredAt, since)))
    .groupBy(viewEvents.name);
  const byRef = await db
    .select({ host: viewEvents.referrerHost, n: sql<number>`count(*)::int` })
    .from(viewEvents)
    .where(and(eq(viewEvents.spaceId, spaceId), eq(viewEvents.name, "tour_open"), gte(viewEvents.occurredAt, since)))
    .groupBy(viewEvents.referrerHost)
    .orderBy(desc(sql`count(*)`))
    .limit(8);
  const byZone = await db
    .select({ zoneId: viewEvents.zoneId, n: sql<number>`count(*)::int` })
    .from(viewEvents)
    .where(and(eq(viewEvents.spaceId, spaceId), eq(viewEvents.name, "zone_view"), gte(viewEvents.occurredAt, since)))
    .groupBy(viewEvents.zoneId)
    .orderBy(desc(sql`count(*)`))
    .limit(10);
  const fallbacks = await db
    .select({ reason: sql<string>`${viewEvents.props}->>'reason'`, n: sql<number>`count(*)::int` })
    .from(viewEvents)
    .where(and(eq(viewEvents.spaceId, spaceId), eq(viewEvents.name, "tour_fallback"), gte(viewEvents.occurredAt, since)))
    .groupBy(sql`${viewEvents.props}->>'reason'`);
  const counts = Object.fromEntries(byName.map((r) => [r.name, r.n])) as Record<string, number>;
  return { days, opens: counts.tour_open ?? 0, renders: counts.tour_first_render ?? 0, roomViews: counts.zone_view ?? 0, hotspotOpens: counts.hotspot_open ?? 0, byRef, byZone, fallbacks };
}

// ---------- analytics ingestion ----------

const VIEW_EVENTS = new Set(["tour_open", "tour_first_render", "tour_fallback", "tier_switch", "zone_view", "hotspot_open"]);

export async function recordViewEvent(e: { publicId: string; name: string; zoneId?: string | null; sessionId?: string | null; referrer?: string | null; surface?: string | null; props?: Record<string, unknown> }) {
  if (!VIEW_EVENTS.has(e.name)) throw new DomainError("Unknown event");
  const [s] = await db.select({ id: spaces.id }).from(spaces).where(eq(spaces.publicId, e.publicId));
  if (!s) throw new DomainError("Unknown tour", "not_found");
  let host: string | null = null;
  try {
    host = e.referrer ? new URL(e.referrer).host.toLowerCase().slice(0, 120) : null;
  } catch {}
  await db.insert(viewEvents).values({
    spaceId: s.id,
    zoneId: e.zoneId && /^[0-9a-f-]{36}$/.test(e.zoneId) ? e.zoneId : null,
    name: e.name,
    sessionId: e.sessionId?.slice(0, 64) ?? null,
    referrerHost: host,
    surface: ["embed", "share", "studio_preview"].includes(e.surface ?? "") ? e.surface : null,
    props: JSON.parse(JSON.stringify(e.props ?? {}).slice(0, 1500) || "{}"),
  });
}

// ---------- API keys ----------

export function hashKey(key: string) {
  return createHash("sha256").update(key).digest("hex");
}

export async function createApiKey(user: SessionUser, name: string, orgId?: string) {
  const org = workspaceOf(user, orgId);
  if (org.role !== "owner") throw new DomainError("Only the workspace owner can create API keys", "forbidden");
  if (!name.trim()) throw new DomainError("Name the key, e.g. 'Website'");
  const key = `nz_live_${randomBytes(24).toString("base64url")}`;
  const [row] = await db.transaction(async (tx) => {
    const r = await tx.insert(apiKeys).values({ orgId: org.id, name: name.trim().slice(0, 60), prefix: key.slice(0, 12), keyHash: hashKey(key), createdBy: user.id }).returning();
    await writeAudit(tx, { actorUserId: user.id, actorRole: "owner", action: "api_key.created", subjectType: "organization", subjectId: org.id, data: { prefix: key.slice(0, 12) } });
    return r;
  });
  return { id: row.id, key }; // the full key is shown exactly once
}

export async function revokeApiKey(user: SessionUser, keyId: string) {
  const [k] = await db.select().from(apiKeys).where(eq(apiKeys.id, keyId));
  if (!k) throw new DomainError("Key not found", "not_found");
  const org = workspaceOf(user, k.orgId);
  if (org.role !== "owner") throw new DomainError("Only the workspace owner can revoke keys", "forbidden");
  await db.transaction(async (tx) => {
    await tx.update(apiKeys).set({ revokedAt: new Date() }).where(eq(apiKeys.id, keyId));
    await writeAudit(tx, { actorUserId: user.id, actorRole: "owner", action: "api_key.revoked", subjectType: "organization", subjectId: k.orgId, data: { prefix: k.prefix } });
  });
}

export async function listApiKeys(user: SessionUser, orgId?: string) {
  const org = workspaceOf(user, orgId);
  return db.select({ id: apiKeys.id, name: apiKeys.name, prefix: apiKeys.prefix, lastUsedAt: apiKeys.lastUsedAt, revokedAt: apiKeys.revokedAt, createdAt: apiKeys.createdAt }).from(apiKeys).where(eq(apiKeys.orgId, org.id)).orderBy(desc(apiKeys.createdAt));
}

export async function orgFromApiKey(header: string | null): Promise<string | null> {
  const m = header?.match(/^Bearer\s+(nz_live_[A-Za-z0-9_-]{20,})$/);
  if (!m) return null;
  const [k] = await db.select().from(apiKeys).where(and(eq(apiKeys.keyHash, hashKey(m[1])), isNull(apiKeys.revokedAt)));
  if (!k) return null;
  await db.update(apiKeys).set({ lastUsedAt: new Date() }).where(eq(apiKeys.id, k.id));
  return k.orgId;
}

/** Public API representation of a space (used by customers' apps). */
export function apiSpace(s: typeof spaces.$inferSelect, base: string, extra: { rooms: number; threeD: number; posterUrl: string | null }) {
  return {
    id: s.publicId,
    name: s.name,
    kind: s.kind,
    externalRef: s.externalRef,
    status: s.status,
    rooms: extra.rooms,
    rooms3d: extra.threeD,
    posterUrl: extra.posterUrl ? base + extra.posterUrl : null,
    embedUrl: `${base}/embed/${s.publicId}`,
    shareUrl: `${base}/t/${s.publicId}`,
    iframe: embedSnippet(base, s.publicId),
    updatedAt: s.updatedAt.toISOString(),
  };
}

export function embedSnippet(base: string, publicId: string, height = 560) {
  return `<iframe src="${base}/embed/${publicId}" title="3D tour" width="100%" height="${height}" style="border:0;border-radius:12px" allow="fullscreen; gyroscope; accelerometer; xr-spatial-tracking" allowfullscreen loading="lazy"></iframe>`;
}

export function sdkSnippet(base: string, publicId: string) {
  return `<div id="nazariya-tour" style="height:560px"></div>
<script src="${base}/sdk/nazariya.js" async></script>
<script>
  window.addEventListener("load", function () {
    var tour = Nazariya.embed("#nazariya-tour", { space: "${publicId}" });
    tour.on("roomchange", function (e) { console.log("Room:", e.label); });
  });
</script>`;
}

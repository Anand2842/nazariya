"use server";
import { revalidatePath } from "next/cache";
import { verifyAuditChain } from "@/server/audit";
import { DomainError } from "@/server/errors";
import { deleteMedia } from "@/server/media";
import { getCurrentUser, requireAdmin } from "@/server/session";
import * as S from "@/server/studio";
import { db } from "@/server/db";
import { zones } from "@/server/schema";
import { and, eq } from "drizzle-orm";
import { createCaptureLink } from "@/server/capture";
import { autoArrange, setZonePlan } from "@/server/house";
import { act } from "./result";

async function me() {
  const u = await getCurrentUser();
  if (!u) throw new DomainError("Please log in first", "forbidden");
  return u;
}

const touch = (spaceId?: string) => {
  revalidatePath("/studio");
  if (spaceId) revalidatePath(`/studio/spaces/${spaceId}`);
};

export async function createWorkspaceAction(input: Parameters<typeof S.createWorkspace>[1]) {
  return act(async () => {
    const o = await S.createWorkspace(await me(), input);
    touch();
    return { id: o.id };
  });
}

export async function createSpaceAction(input: Parameters<typeof S.createSpace>[1]) {
  return act(async () => {
    const s = await S.createSpace(await me(), input);
    touch();
    return { id: s.id };
  });
}

export async function updateSpaceAction(spaceId: string, input: Parameters<typeof S.updateSpace>[2]) {
  return act(async () => {
    await S.updateSpace(await me(), spaceId, input);
    touch(spaceId);
  });
}

export async function publishAction(spaceId: string) {
  return act(async () => {
    await S.publishSpace(await me(), spaceId);
    touch(spaceId);
  });
}

export async function unpublishAction(spaceId: string, archive = false) {
  return act(async () => {
    await S.unpublishSpace(await me(), spaceId, archive);
    touch(spaceId);
  });
}

export async function setPosterAction(spaceId: string, assetId: string) {
  return act(async () => {
    await S.setPoster(await me(), spaceId, assetId);
    touch(spaceId);
  });
}

export async function createZoneAction(spaceId: string, input: { label: string; roomType?: string }) {
  return act(async () => {
    const z = await S.createZone(await me(), spaceId, input);
    touch(spaceId);
    return { id: z.id };
  });
}

export async function updateZoneAction(spaceId: string, zoneId: string, input: Parameters<typeof S.updateZone>[2]) {
  return act(async () => {
    await S.updateZone(await me(), zoneId, input);
    touch(spaceId);
  });
}

export async function setScanTransformAction(spaceId: string, zoneId: string, t: { flip: boolean; yawDeg: number; scale: number }) {
  return act(async () => {
    const user = await me();
    await S.loadSpace(user, spaceId);
    const scale = Math.min(10, Math.max(0.1, Number(t.scale) || 1));
    const yawDeg = ((Number(t.yawDeg) || 0) % 360 + 360) % 360;
    const [z] = await db.select({ t: zones.splatTransform }).from(zones).where(and(eq(zones.id, zoneId), eq(zones.spaceId, spaceId)));
    if (!z) throw new DomainError("Room not in this space", "not_found");
    // Keep what the reconstruction worked out (upright alignment, start point); the editor adjusts the rest.
    const prev = z.t as { offset?: [number, number, number]; align?: [number, number, number, number] };
    await db.update(zones).set({ splatTransform: { flip: !!t.flip, yawDeg, scale, ...(prev.offset ? { offset: prev.offset } : {}), ...(prev.align ? { align: prev.align } : {}) } }).where(eq(zones.id, zoneId));
    touch(spaceId);
  });
}

export async function moveZoneAction(spaceId: string, zoneId: string, dir: -1 | 1) {
  return act(async () => {
    await S.moveZone(await me(), zoneId, dir);
    touch(spaceId);
  });
}

export async function deleteZoneAction(spaceId: string, zoneId: string) {
  return act(async () => {
    await S.deleteZone(await me(), zoneId);
    touch(spaceId);
  });
}

export async function buildSplatAction(spaceId: string, zoneId: string) {
  return act(async () => {
    await S.requestSplatBuild(await me(), zoneId);
    touch(spaceId);
  });
}

export async function addHotspotAction(spaceId: string, zoneId: string, input: Parameters<typeof S.addHotspot>[2]) {
  return act(async () => {
    const h = await S.addHotspot(await me(), zoneId, input);
    touch(spaceId);
    return { id: h.id };
  });
}

export async function deleteHotspotAction(spaceId: string, hotspotId: string) {
  return act(async () => {
    await S.deleteHotspot(await me(), hotspotId);
    touch(spaceId);
  });
}

export async function deleteMediaAction(spaceId: string, assetId: string) {
  return act(async () => {
    await deleteMedia(await me(), assetId);
    touch(spaceId);
  });
}

export async function brandingAction(orgId: string, input: Parameters<typeof S.updateWorkspaceBranding>[2]) {
  return act(async () => {
    await S.updateWorkspaceBranding(await me(), orgId, input);
    revalidatePath("/studio/settings");
  });
}

export async function createApiKeyAction(name: string) {
  return act(async () => {
    const r = await S.createApiKey(await me(), name);
    revalidatePath("/studio/settings");
    return r;
  });
}

export async function revokeApiKeyAction(id: string) {
  return act(async () => {
    await S.revokeApiKey(await me(), id);
    revalidatePath("/studio/settings");
  });
}

export async function verifyAuditAction() {
  return act(async () => {
    await requireAdmin();
    return verifyAuditChain();
  });
}

export async function createCaptureLinkAction(spaceId: string, zoneId: string | null) {
  return act(async () => {
    const r = await createCaptureLink(await me(), spaceId, zoneId);
    return { token: r.token, expiresAt: r.expiresAt.toISOString() };
  });
}

export async function setZonePlanAction(spaceId: string, zoneId: string, plan: { x: number; z: number; rotDeg: number } | null) {
  return act(async () => {
    await setZonePlan(await me(), zoneId, plan);
    touch(spaceId);
  });
}

export async function autoArrangeAction(spaceId: string) {
  return act(async () => {
    const n = await autoArrange(await me(), spaceId);
    touch(spaceId);
    return { placed: n };
  });
}

"use server";
import { revalidatePath } from "next/cache";
import { decideBooking, proposeVisits } from "@/server/enquiries";
import { DomainError } from "@/server/errors";
import * as L from "@/server/listings";
import { deleteMedia, startCaptureSession } from "@/server/media";
import { getCurrentUser } from "@/server/session";
import { contentKey, putBuffer, sha256 } from "@/server/storage";
import { requestOwnerConfirmation, submitAuthorizationDocument, submitRera, verifyDigilocker, verifyPan } from "@/server/trust";
import { sniffMime } from "@/server/media";
import { act } from "./result";

async function me() {
  const u = await getCurrentUser();
  if (!u) throw new DomainError("Please log in first", "forbidden");
  return u;
}

const touch = (listingId?: string) => {
  revalidatePath("/dashboard");
  if (listingId) revalidatePath(`/dashboard/listings/${listingId}`);
  revalidatePath("/search");
  revalidatePath("/");
};

export async function createOrg(input: Parameters<typeof L.createOrganization>[1]) {
  return act(async () => {
    const o = await L.createOrganization(await me(), input);
    touch();
    return { id: o.id };
  });
}

export async function createPropertyAction(input: Parameters<typeof L.createProperty>[1]) {
  return act(async () => {
    const r = await L.createProperty(await me(), input);
    touch();
    return { propertyId: r.property.id };
  });
}

export async function createListingAction(input: Parameters<typeof L.createListing>[1]) {
  return act(async () => {
    const l = await L.createListing(await me(), input);
    touch();
    return { id: l.id };
  });
}

export async function updateDetailsAction(listingId: string, input: { title: string; description: string; terms?: Record<string, unknown> }) {
  return act(async () => {
    await L.updateListingDetails(await me(), listingId, input);
    touch(listingId);
  });
}

export async function setPlanAction(listingId: string, input: Parameters<typeof L.setPricePlan>[2]) {
  return act(async () => {
    await L.setPricePlan(await me(), listingId, input);
    touch(listingId);
  });
}

export async function retirePlanAction(listingId: string, planKey: string) {
  return act(async () => {
    await L.retirePricePlan(await me(), listingId, planKey);
    touch(listingId);
  });
}

export async function bedStatusAction(listingId: string, bedId: string, input: Parameters<typeof L.setBedStatus>[2]) {
  return act(async () => {
    await L.setBedStatus(await me(), bedId, input);
    touch(listingId);
  });
}

export async function unitAvailabilityAction(listingId: string, unitId: string, input: Parameters<typeof L.setUnitAvailability>[2]) {
  return act(async () => {
    await L.setUnitAvailability(await me(), unitId, input);
    touch(listingId);
  });
}

export async function nightlyAction(listingId: string, unitId: string, input: Parameters<typeof L.setNightlyInventory>[2]) {
  return act(async () => {
    await L.setNightlyInventory(await me(), unitId, input);
    touch(listingId);
  });
}

export async function reconfirmAction(listingId: string) {
  return act(async () => {
    await L.reconfirmListing(await me(), listingId);
    touch(listingId);
  });
}

export async function publishAction(listingId: string) {
  return act(async () => {
    await L.publishListing(await me(), listingId);
    touch(listingId);
  });
}

export async function setStatusAction(listingId: string, to: "paused" | "closed") {
  return act(async () => {
    await L.setListingStatusByLister(await me(), listingId, to);
    touch(listingId);
  });
}

export async function createZoneAction(listingId: string, propertyId: string, input: { label: string; roomType: string; unitId?: string | null }) {
  return act(async () => {
    const z = await L.createZone(await me(), propertyId, input);
    touch(listingId);
    return { id: z.id };
  });
}

export async function updateZoneAction(listingId: string, zoneId: string, input: Parameters<typeof L.updateZone>[2]) {
  return act(async () => {
    await L.updateZone(await me(), zoneId, input);
    touch(listingId);
  });
}

export async function deleteZoneAction(listingId: string, zoneId: string) {
  return act(async () => {
    await L.deleteZone(await me(), zoneId);
    touch(listingId);
  });
}

export async function buildSplatAction(listingId: string, zoneId: string) {
  return act(async () => {
    await L.requestSplatBuild(await me(), zoneId);
    touch(listingId);
  });
}

export async function addHotspotAction(listingId: string, zoneId: string, input: Parameters<typeof L.addHotspot>[2]) {
  return act(async () => {
    const h = await L.addHotspot(await me(), zoneId, input);
    touch(listingId);
    return { id: h.id };
  });
}

export async function deleteHotspotAction(listingId: string, hotspotId: string) {
  return act(async () => {
    await L.deleteHotspot(await me(), hotspotId);
    touch(listingId);
  });
}

export async function startCaptureAction(input: { propertyId: string; device?: string; lat?: number | null; lng?: number | null; tier?: string }) {
  return act(async () => {
    const s = await startCaptureSession(await me(), { ...input, inApp: true });
    return { id: s.id };
  });
}

export async function deleteMediaAction(listingId: string, assetId: string) {
  return act(async () => {
    await deleteMedia(await me(), assetId);
    touch(listingId);
  });
}

export async function askOwnerAction(listingId: string, authorizationId: string) {
  return act(async () => {
    await requestOwnerConfirmation(await me(), authorizationId);
    touch(listingId);
  });
}

export async function uploadAuthDocAction(listingId: string, authorizationId: string, checkType: "ownership_document" | "operator_lease" | "hotel_registration", form: FormData) {
  return act(async () => {
    const user = await me();
    const file = form.get("file");
    if (!(file instanceof File)) throw new DomainError("Choose a file");
    if (file.size > 10 * 1024 * 1024) throw new DomainError("Max 10 MB");
    const bytes = new Uint8Array(await file.arrayBuffer());
    const mime = sniffMime(bytes);
    if (!mime || !["image/jpeg", "image/png", "application/pdf"].includes(mime)) throw new DomainError("Upload a JPG, PNG or PDF");
    const hash = sha256(bytes);
    const key = contentKey("priv", "evidence", hash, mime === "application/pdf" ? "pdf" : mime.split("/")[1]);
    await putBuffer(key, bytes);
    await submitAuthorizationDocument(user, authorizationId, checkType, { key, sha256: hash });
    touch(listingId);
  });
}

export async function panAction(pan: string, name: string) {
  return act(async () => {
    const c = await verifyPan(await me(), pan, name);
    revalidatePath("/dashboard/verification");
    return { status: c.status };
  });
}

export async function digilockerAction(consent: boolean) {
  return act(async () => {
    await verifyDigilocker(await me(), consent);
    revalidatePath("/dashboard/verification");
  });
}

export async function reraAction(no: string) {
  return act(async () => {
    await submitRera(await me(), no);
    revalidatePath("/dashboard/verification");
  });
}

export async function proposeVisitsAction(enquiryId: string, slots: { start: string; mode: "in_person" | "video" }[]) {
  return act(async () => {
    await proposeVisits(await me(), enquiryId, slots);
    revalidatePath(`/dashboard/enquiries/${enquiryId}`);
  });
}

export async function decideBookingAction(bookingId: string, decision: "confirmed" | "declined") {
  return act(async () => {
    await decideBooking(await me(), bookingId, decision);
    revalidatePath("/dashboard/enquiries");
  });
}

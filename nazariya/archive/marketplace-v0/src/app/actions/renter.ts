"use server";
import { revalidatePath } from "next/cache";
import { createBookingRequest, createEnquiry, postMessage, recordOutcome, updateVisit } from "@/server/enquiries";
import { getCurrentUser } from "@/server/session";
import { createReport } from "@/server/trust";
import { act } from "./result";

async function me() {
  const u = await getCurrentUser();
  if (!u) throw new (await import("@/server/errors")).DomainError("Please log in first", "forbidden");
  return u;
}

export async function submitEnquiry(input: Parameters<typeof createEnquiry>[1]) {
  return act(async () => {
    const e = await createEnquiry(await me(), input);
    revalidatePath("/me");
    return { id: e.id };
  });
}

export async function submitBookingRequest(input: Parameters<typeof createBookingRequest>[1]) {
  return act(async () => {
    const b = await createBookingRequest(await me(), input);
    revalidatePath("/me");
    return { id: b.id };
  });
}

export async function submitReport(listingId: string, reason: string, details: string) {
  return act(async () => {
    await createReport(await getCurrentUser(), listingId, reason, details);
    return {};
  });
}

export async function sendMessage(enquiryId: string, body: string) {
  return act(async () => {
    await postMessage(await me(), enquiryId, body);
    revalidatePath(`/me/enquiries/${enquiryId}`);
    revalidatePath(`/dashboard/enquiries/${enquiryId}`);
  });
}

export async function changeVisit(visitId: string, to: string, enquiryId: string) {
  return act(async () => {
    await updateVisit(await me(), visitId, to);
    revalidatePath(`/me/enquiries/${enquiryId}`);
    revalidatePath(`/dashboard/enquiries/${enquiryId}`);
  });
}

export async function saveOutcome(enquiryId: string, input: Parameters<typeof recordOutcome>[2]) {
  return act(async () => {
    await recordOutcome(await me(), enquiryId, input);
    revalidatePath(`/me/enquiries/${enquiryId}`);
    revalidatePath(`/dashboard/enquiries/${enquiryId}`);
  });
}

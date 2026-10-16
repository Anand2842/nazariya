"use server";
import { revalidatePath } from "next/cache";
import { verifyAuditChain } from "@/server/audit";
import { requireAdmin } from "@/server/session";
import { decideCase, decideCheck, freshnessSweep, revokeCheck, type CaseDecision } from "@/server/trust";
import { act } from "./result";

export async function decideCheckAction(checkId: string, decision: "passed" | "failed", reason: string) {
  return act(async () => {
    await decideCheck(await requireAdmin(), checkId, decision, reason);
    revalidatePath("/admin");
  });
}

export async function revokeCheckAction(checkId: string, reason: string) {
  return act(async () => {
    await revokeCheck(await requireAdmin(), checkId, reason);
    revalidatePath("/admin");
  });
}

export async function decideCaseAction(caseId: string, decision: CaseDecision, rationale: string) {
  return act(async () => {
    await decideCase(await requireAdmin(), caseId, decision, rationale);
    revalidatePath("/admin");
  });
}

export async function verifyAuditAction() {
  return act(async () => {
    await requireAdmin();
    return verifyAuditChain();
  });
}

export async function freshnessAction() {
  return act(async () => {
    await requireAdmin();
    return freshnessSweep();
  });
}

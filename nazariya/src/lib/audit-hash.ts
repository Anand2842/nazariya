import { createHash } from "node:crypto";

/** Deterministic JSON with sorted keys, used for audit hashing. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value ?? null);
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (Array.isArray(value)) return "[" + value.map(canonicalJson).join(",") + "]";
  const obj = value as Record<string, unknown>;
  return (
    "{" +
    Object.keys(obj)
      .filter((k) => obj[k] !== undefined)
      .sort()
      .map((k) => JSON.stringify(k) + ":" + canonicalJson(obj[k]))
      .join(",") +
    "}"
  );
}

export interface AuditPayload {
  occurredAt: string;
  actorUserId: string | null;
  actorRole: string;
  action: string;
  subjectType: string;
  subjectId: string;
  data: unknown;
}

export const GENESIS_HASH = "0".repeat(64);

export function auditHash(prevHash: string, p: AuditPayload): string {
  return createHash("sha256").update(prevHash).update("|").update(canonicalJson(p)).digest("hex");
}

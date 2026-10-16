import { asc, desc, sql } from "drizzle-orm";
import { auditHash, GENESIS_HASH, type AuditPayload } from "@/lib/audit-hash";
import { db, type Exec } from "./db";
import { auditEvents } from "./schema";

export interface AuditInput {
  actorUserId: string | null;
  actorRole: string; // renter | lister | owner | admin | system
  action: string;
  subjectType: string;
  subjectId: string;
  data?: Record<string, unknown>;
}

/**
 * Append a hash-chained audit event. MUST be called inside the same transaction as the change it records.
 * An advisory transaction lock serialises chain appends.
 */
export async function writeAudit(tx: Exec, e: AuditInput): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(724242)`);
  const last = await tx.select({ hash: auditEvents.hash }).from(auditEvents).orderBy(desc(auditEvents.id)).limit(1);
  const prevHash = last[0]?.hash ?? GENESIS_HASH;
  const occurredAt = new Date();
  const payload: AuditPayload = {
    occurredAt: occurredAt.toISOString(),
    actorUserId: e.actorUserId,
    actorRole: e.actorRole,
    action: e.action,
    subjectType: e.subjectType,
    subjectId: e.subjectId,
    data: e.data ?? {},
  };
  await tx.insert(auditEvents).values({
    occurredAt,
    actorUserId: e.actorUserId,
    actorRole: e.actorRole,
    action: e.action,
    subjectType: e.subjectType,
    subjectId: e.subjectId,
    data: e.data ?? {},
    prevHash,
    hash: auditHash(prevHash, payload),
  });
}

export interface ChainVerification {
  ok: boolean;
  checked: number;
  brokenAtId?: number;
  reason?: string;
}

/** Re-compute the whole chain. Detects edited, deleted or re-ordered rows. */
export async function verifyAuditChain(exec: Exec = db): Promise<ChainVerification> {
  let prev = GENESIS_HASH;
  let checked = 0;
  let lastId = 0;
  for (;;) {
    const rows = await exec
      .select()
      .from(auditEvents)
      .where(sql`${auditEvents.id} > ${lastId}`)
      .orderBy(asc(auditEvents.id))
      .limit(2000);
    if (!rows.length) break;
    for (const r of rows) {
      if (r.prevHash !== prev) return { ok: false, checked, brokenAtId: r.id, reason: "prev_hash does not match previous row" };
      const expect = auditHash(prev, {
        occurredAt: r.occurredAt.toISOString(),
        actorUserId: r.actorUserId,
        actorRole: r.actorRole,
        action: r.action,
        subjectType: r.subjectType,
        subjectId: r.subjectId,
        data: r.data,
      });
      if (expect !== r.hash) return { ok: false, checked, brokenAtId: r.id, reason: "row content does not match its hash" };
      prev = r.hash;
      lastId = r.id;
      checked++;
    }
  }
  return { ok: true, checked };
}

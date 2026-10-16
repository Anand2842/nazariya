import Link from "next/link";
import { desc, eq, inArray, sql } from "drizzle-orm";
import { AuditVerify, CaseDecision, CheckDecision, FreshnessRun } from "@/components/admin/AdminControls";
import { CHECK_TYPES, REPORT_REASONS } from "@/lib/catalog";
import { db } from "@/server/db";
import { analyticsEvents, auditEvents, jobs, listings, moderationCases, reports, users, verificationChecks, verificationEvidence } from "@/server/schema";
import { requireAdmin } from "@/server/session";

export const dynamic = "force-dynamic";

export default async function Admin() {
  await requireAdmin();
  const queue = await db.select().from(verificationChecks).where(inArray(verificationChecks.status, ["needs_review", "pending"])).orderBy(desc(verificationChecks.createdAt));
  const evidence = queue.length ? await db.select().from(verificationEvidence).where(inArray(verificationEvidence.checkId, queue.map((q) => q.id))) : [];
  const userIds = queue.filter((q) => q.subjectType === "user").map((q) => q.subjectId);
  const names = userIds.length ? await db.select({ id: users.id, name: users.name }).from(users).where(inArray(users.id, userIds)) : [];
  const cases = await db.select().from(moderationCases).where(inArray(moderationCases.status, ["open", "awaiting_party"])).orderBy(desc(moderationCases.createdAt));
  const caseReports = cases.length ? await db.select().from(reports).where(inArray(reports.caseId, cases.map((c) => c.id))) : [];
  const caseListings = cases.filter((c) => c.listingId).length ? await db.select({ id: listings.id, title: listings.title, slug: listings.slug, status: listings.status }).from(listings).where(inArray(listings.id, cases.filter((c) => c.listingId).map((c) => c.listingId!))) : [];
  const dupListings = await db.execute(sql`select l.id, l.title, l.slug, l.status, l.property_id from listings l`);
  const jobStats = await db.select({ status: jobs.status, n: sql<number>`count(*)::int` }).from(jobs).groupBy(jobs.status);
  const failed = await db.select().from(jobs).where(inArray(jobs.status, ["dead", "failed"])).orderBy(desc(jobs.updatedAt)).limit(5);
  const listingStats = await db.select({ status: listings.status, n: sql<number>`count(*)::int` }).from(listings).groupBy(listings.status);
  const ev = await db.select({ name: analyticsEvents.name, n: sql<number>`count(*)::int` }).from(analyticsEvents).groupBy(analyticsEvents.name);
  const audit = await db.select().from(auditEvents).orderBy(desc(auditEvents.id)).limit(40);
  return (
    <div className="mx-auto max-w-6xl space-y-6 px-4 py-6" data-testid="admin">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-2xl font-extrabold">Admin</h1>
        <div className="flex flex-wrap gap-2"><FreshnessRun /><AuditVerify /></div>
      </div>
      <section className="grid gap-3 sm:grid-cols-3">
        <div className="card p-4 text-sm"><p className="label">Listings</p>{listingStats.map((s) => <p key={s.status}>{s.status}: <b>{s.n}</b></p>)}</div>
        <div className="card p-4 text-sm"><p className="label">Jobs</p>{jobStats.map((s) => <p key={s.status}>{s.status}: <b>{s.n}</b></p>)}{failed.map((f) => <p key={f.id} className="text-xs text-rose-600">#{f.id} {f.kind}: {f.lastError}</p>)}</div>
        <div className="card p-4 text-sm"><p className="label">Viewer analytics</p>{ev.map((s) => <p key={s.name}>{s.name}: <b>{s.n}</b></p>)}{!ev.length && <p className="muted">No events yet</p>}</div>
      </section>

      <section className="card p-4">
        <h2 className="section-title">Verification queue ({queue.length})</h2>
        <ul className="mt-2 space-y-3" data-testid="check-queue">
          {queue.map((c) => (
            <li key={c.id} className="rounded-xl border border-slate-200 p-3 text-sm">
              <p><b>{CHECK_TYPES[c.checkType]?.label ?? c.checkType}</b> · {c.subjectType} {c.subjectType === "user" ? names.find((n) => n.id === c.subjectId)?.name : c.subjectId.slice(0, 8)} · <span className="text-amber-700">{c.status.replace("_", " ")}</span></p>
              {c.reason && <p className="text-xs text-slate-500">Note: {c.reason}</p>}
              {Object.keys(c.data as object).length > 0 && <p className="text-xs text-slate-500">Data: {JSON.stringify(c.data)}</p>}
              <div className="mt-1 flex flex-wrap gap-2 text-xs">
                {evidence.filter((e) => e.checkId === c.id).map((e) => (
                  <a key={e.id} className="text-nazar underline" href={`/admin/evidence/${c.id}?e=${e.id}`} target="_blank">View evidence ({e.kind.replace("_", " ")})</a>
                ))}
              </div>
              <div className="mt-2"><CheckDecision checkId={c.id} /></div>
            </li>
          ))}
          {!queue.length && <li className="muted">Queue is empty.</li>}
        </ul>
      </section>

      <section className="card p-4">
        <h2 className="section-title">Moderation cases ({cases.length})</h2>
        <ul className="mt-2 space-y-3" data-testid="case-queue">
          {cases.map((c) => {
            const l = caseListings.find((x) => x.id === c.listingId);
            const subj = c.subject as Record<string, unknown>;
            const dup = c.kind === "duplicate" ? (dupListings as unknown as { id: string; title: string; slug: string; status: string; property_id: string }[]).filter((x) => x.property_id === subj.propertyA || x.property_id === subj.propertyB) : [];
            return (
              <li key={c.id} className="rounded-xl border border-slate-200 p-3 text-sm" data-testid="case">
                <p>
                  <span className={`chip mr-1 ${c.priority === "fraud" ? "bg-rose-100 text-rose-800" : c.priority === "safety" ? "bg-rose-600 text-white" : "bg-slate-100"}`}>{c.priority}</span>
                  <b className="capitalize">{c.kind}</b>{c.slaDueAt ? <span className="text-xs text-slate-500"> · SLA {c.slaDueAt.toLocaleString("en-IN")}</span> : null}
                </p>
                {l && <p className="mt-1">Listing: <Link className="text-nazar underline" href={`/l/${l.slug}`}>{l.title}</Link> ({l.status})</p>}
                {caseReports.filter((r) => r.caseId === c.id).map((r) => <p key={r.id} className="text-slate-600">Report: {REPORT_REASONS[r.reason] ?? r.reason}{r.details ? `: “${r.details}”` : ""}</p>)}
                {c.kind === "duplicate" && (
                  <div className="mt-1 text-slate-600">
                    <p>Score {String(subj.score)} · {subj.stolenPhotoPattern ? "⚠ identical photos at distant addresses (possible stolen photos)" : "possible duplicate"}</p>
                    <p className="text-xs">Signals: {JSON.stringify(subj.signals)}</p>
                    {dup.map((d) => <p key={d.id} className="text-xs">• <Link className="text-nazar underline" href={`/l/${d.slug}`}>{d.title}</Link> ({d.status})</p>)}
                  </div>
                )}
                {c.kind === "dispute" && <p className="text-slate-600">{JSON.stringify(subj)}</p>}
                <CaseDecision caseId={c.id} kind={c.kind} />
                {c.kind === "duplicate" && <p className="mt-1 text-[11px] text-slate-500">&quot;Suspend listing&quot; applies to the case listing. For duplicates, open the suspicious listing&apos;s report case to suspend it.</p>}
              </li>
            );
          })}
          {!cases.length && <li className="muted">No open cases.</li>}
        </ul>
      </section>

      <section className="card p-4">
        <h2 className="section-title">Audit log (latest 40, append-only, hash-chained)</h2>
        <div className="mt-2 overflow-x-auto">
          <table className="w-full min-w-[720px] text-xs" data-testid="audit-table">
            <tbody>
              {audit.map((a) => (
                <tr key={a.id} className="border-t border-slate-100">
                  <td className="py-1 pr-2 text-slate-400">#{a.id}</td>
                  <td className="pr-2">{a.occurredAt.toLocaleString("en-IN")}</td>
                  <td className="pr-2">{a.actorRole}</td>
                  <td className="pr-2 font-medium">{a.action}</td>
                  <td className="pr-2">{a.subjectType}:{a.subjectId.slice(0, 8)}</td>
                  <td className="font-mono text-slate-400">{a.hash.slice(0, 12)}…</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}

import { desc, eq, inArray, sql } from "drizzle-orm";
import { AuditVerify } from "@/components/admin/AuditVerify";
import { db } from "@/server/db";
import { auditEvents, jobs, mediaAssets, organizations, spaces, viewEvents } from "@/server/schema";
import { requireAdmin } from "@/server/session";

export const dynamic = "force-dynamic";

export default async function Admin() {
  await requireAdmin();
  const orgs = await db
    .select({ id: organizations.id, name: organizations.name, plan: organizations.plan, createdAt: organizations.createdAt, spaces: sql<number>`(select count(*)::int from spaces s where s.org_id = ${organizations.id})`, published: sql<number>`(select count(*)::int from spaces s where s.org_id = ${organizations.id} and s.status = 'published')` })
    .from(organizations)
    .orderBy(desc(organizations.createdAt));
  const jobStats = await db.select({ status: jobs.status, n: sql<number>`count(*)::int` }).from(jobs).groupBy(jobs.status);
  const failed = await db.select().from(jobs).where(inArray(jobs.status, ["dead"])).orderBy(desc(jobs.updatedAt)).limit(8);
  const storage = await db.select({ kind: mediaAssets.kind, n: sql<number>`count(*)::int`, bytes: sql<number>`coalesce(sum(${mediaAssets.bytes}),0)::bigint` }).from(mediaAssets).groupBy(mediaAssets.kind);
  const views = await db.select({ n: sql<number>`count(*)::int` }).from(viewEvents).where(eq(viewEvents.name, "tour_open"));
  const audit = await db.select().from(auditEvents).orderBy(desc(auditEvents.id)).limit(30);
  const [{ total }] = await db.select({ total: sql<number>`count(*)::int` }).from(spaces);
  return (
    <div className="mx-auto max-w-6xl space-y-6 px-4 py-6" data-testid="admin">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-2xl font-extrabold">Platform admin</h1>
        <AuditVerify />
      </div>
      <section className="grid gap-3 sm:grid-cols-4">
        <div className="card p-4"><p className="label">Workspaces</p><p className="text-2xl font-extrabold">{orgs.length}</p></div>
        <div className="card p-4"><p className="label">Spaces</p><p className="text-2xl font-extrabold">{total}</p></div>
        <div className="card p-4"><p className="label">Tour opens</p><p className="text-2xl font-extrabold">{views[0]?.n ?? 0}</p></div>
        <div className="card p-4 text-sm"><p className="label">Jobs</p>{jobStats.map((s) => <p key={s.status}>{s.status}: <b>{s.n}</b></p>)}</div>
      </section>
      {failed.length > 0 && <section className="card p-4 text-sm"><p className="section-title">Failed jobs</p>{failed.map((f) => <p key={f.id} className="text-rose-700">#{f.id} {f.kind}: {f.lastError}</p>)}</section>}
      <section className="card p-4">
        <p className="section-title">Workspaces</p>
        <table className="mt-2 w-full text-sm" data-testid="admin-orgs">
          <thead className="text-left text-xs uppercase text-slate-500"><tr><th>Name</th><th>Plan</th><th>Spaces</th><th>Published</th><th>Created</th></tr></thead>
          <tbody>{orgs.map((o) => <tr key={o.id} className="border-t border-slate-100"><td className="py-1">{o.name}</td><td>{o.plan}</td><td>{o.spaces}</td><td>{o.published}</td><td>{o.createdAt.toLocaleDateString("en-IN")}</td></tr>)}</tbody>
        </table>
      </section>
      <section className="card p-4 text-sm"><p className="section-title">Storage by type</p>{storage.map((s) => <p key={s.kind}>{s.kind}: {s.n} files, {(Number(s.bytes) / 1048576).toFixed(1)} MB (originals)</p>)}</section>
      <section className="card p-4">
        <p className="section-title">Audit log (latest 30, append-only, hash-chained)</p>
        <table className="mt-2 w-full text-xs"><tbody>{audit.map((a) => <tr key={a.id} className="border-t border-slate-100"><td className="py-1 pr-2 text-slate-400">#{a.id}</td><td className="pr-2">{a.occurredAt.toLocaleString("en-IN")}</td><td className="pr-2">{a.actorRole}</td><td className="pr-2 font-medium">{a.action}</td><td className="pr-2">{a.subjectType}:{a.subjectId.slice(0, 8)}</td><td className="font-mono text-slate-400">{a.hash.slice(0, 12)}…</td></tr>)}</tbody></table>
      </section>
    </div>
  );
}

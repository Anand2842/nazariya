// Postgres-backed job queue (transactional enqueue, FOR UPDATE SKIP LOCKED claiming).
import { sql } from "drizzle-orm";
import { db, type Exec } from "./db";
import { jobs } from "./schema";

export type JobKind = "media.process" | "scene.build_from_pano" | "capture.stitch_pano" | "capture.ar_room" | "recon.walkthrough" | "notify.deliver";

export async function enqueue(
  exec: Exec,
  kind: JobKind,
  payload: Record<string, unknown>,
  opts: { runAfter?: Date; maxAttempts?: number } = {},
) {
  const [row] = await exec
    .insert(jobs)
    .values({ kind, payload, runAfter: opts.runAfter ?? new Date(), maxAttempts: opts.maxAttempts ?? 3 })
    .returning({ id: jobs.id });
  return row.id;
}

export interface ClaimedJob {
  id: number;
  kind: JobKind;
  payload: Record<string, unknown>;
  attempts: number;
  max_attempts: number;
}

export async function claimJobs(workerId: string, limit = 1, kinds?: JobKind[]): Promise<ClaimedJob[]> {
  const kindFilter = kinds?.length ? sql`and kind in (${sql.join(kinds.map((k) => sql`${k}`), sql`, `)})` : sql``;
  const res = await db.execute(sql`
    update jobs set status = 'running', locked_by = ${workerId}, locked_at = now(), attempts = attempts + 1, updated_at = now()
    where id in (
      select id from jobs
      where status = 'queued' and run_after <= now() ${kindFilter}
      order by id
      for update skip locked
      limit ${limit}
    )
    returning id, kind, payload, attempts, max_attempts`);
  return res as unknown as ClaimedJob[];
}

export async function completeJob(id: number, result: Record<string, unknown> = {}) {
  await db.execute(sql`update jobs set status='done', result=${JSON.stringify(result)}::jsonb, locked_by=null, updated_at=now() where id=${id}`);
}

export async function failJob(job: ClaimedJob, error: unknown) {
  const msg = error instanceof Error ? error.message : String(error);
  const dead = job.attempts >= job.max_attempts;
  const backoffSec = Math.min(600, 10 * 2 ** job.attempts);
  await db.execute(sql`
    update jobs set status=${dead ? "dead" : "queued"}, last_error=${msg.slice(0, 2000)}, locked_by=null,
      run_after = now() + (${backoffSec} || ' seconds')::interval, updated_at=now()
    where id=${job.id}`);
  return dead;
}

/** Return jobs stuck in "running" (e.g. a crashed worker) to the queue. */
export async function recoverStaleJobs(olderThanMinutes = 15) {
  await db.execute(sql`
    update jobs set status='queued', locked_by=null, updated_at=now()
    where status='running' and locked_at < now() - (${olderThanMinutes} || ' minutes')::interval`);
}

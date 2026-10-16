// Background worker: processes media/3D jobs and delivers notifications.
// Usage: npm run worker            (loop)
//        npm run worker -- --drain (process everything queued, then exit; used by seed/tests)
import { hostname } from "node:os";
import { claimJobs, completeJob, failJob, recoverStaleJobs } from "../src/server/jobs";
import { deliverNotifications, handleJob, PermanentJobError } from "../src/server/pipeline/process";
import { closeDb } from "../src/server/db";

const workerId = `${hostname()}-${process.pid}`;
const drain = process.argv.includes("--drain");
let stopping = false;

process.on("SIGINT", () => (stopping = true));
process.on("SIGTERM", () => (stopping = true));

async function tick(): Promise<number> {
  const jobs = await claimJobs(workerId, 2);
  for (const job of jobs) {
    const t0 = Date.now();
    try {
      const result = await handleJob(job);
      await completeJob(job.id, result);
      console.log(`✓ job ${job.id} ${job.kind} (${Date.now() - t0} ms)`);
    } catch (e) {
      if (e instanceof PermanentJobError) job.attempts = job.max_attempts;
      const dead = await failJob(job, e);
      console.error(`✗ job ${job.id} ${job.kind}: ${(e as Error).message}${dead ? " [dead]" : " [will retry]"}`);
    }
  }
  return jobs.length;
}

async function main() {
  console.log(`worker ${workerId} started${drain ? " (drain mode)" : ""}`);
  await recoverStaleJobs();
  while (!stopping) {
    const n = await tick();
    await deliverNotifications((s) => console.log("  notify", s));
    if (drain && n === 0) break;
    if (n === 0) await new Promise((r) => setTimeout(r, 1000));
  }
  await closeDb();
  console.log("worker stopped");
}

main().catch(async (e) => {
  console.error(e);
  await closeDb();
  process.exit(1);
});

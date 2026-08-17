/**
 * Queue inspector. Shows exactly what's sitting in the pipeline queue right
 * now — job counts by state, plus the actual waiting/active job data. Use this
 * to get ground truth independent of log filtering: run it immediately after
 * clicking "Generate preview" to see whether the job actually landed in THIS
 * Redis instance.
 *
 *   $env:REDIS_URL="redis://…public…"; npm run queue:peek
 */
import "../lib/loadenv";
import { pipelineQueue } from "../lib/queue";
import { env } from "../lib/env";

async function main() {
  console.log("Inspecting queue on:", env.redisUrl.replace(/:\/\/.*@/, "://***@"));
  const q = pipelineQueue();

  const counts = await q.getJobCounts();
  console.log("\nJob counts:", JSON.stringify(counts));

  for (const state of ["waiting", "active", "delayed", "failed"] as const) {
    const jobs = await q.getJobs([state], 0, 9);
    if (jobs.length === 0) continue;
    console.log(`\n${state.toUpperCase()} (${jobs.length}):`);
    for (const j of jobs) {
      console.log(`  id=${j.id} stage=${j.data?.stage} project=${j.data?.projectId} attemptsMade=${j.attemptsMade}`);
      if (state === "failed") console.log(`    failedReason: ${j.failedReason}`);
    }
  }

  if (Object.values(counts).every((n) => n === 0)) {
    console.log("\n⚠ Queue is completely empty — no job exists here at all.");
    console.log("  If you just clicked Generate preview, this Redis is NOT the one web enqueues into.");
  }

  await q.close();
  process.exit(0);
}

main().catch((err) => {
  console.error("✗ queue:peek failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});

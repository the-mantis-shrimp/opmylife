/**
 * Queue reset. Obliterates the pipeline + maintenance queues (all jobs in every
 * state) for a clean slate. Only touches our two BullMQ queues — unlike a blind
 * Redis FLUSHALL.
 *
 *   npm run queue:clear
 *
 * Reads REDIS_URL from the environment. Railway's internal URL isn't reachable
 * from your laptop, so run this against the Redis PUBLIC url:
 *   Railway → Redis service → Connect tab → copy the public URL, then
 *   $env:REDIS_URL="redis://…public…"; npm run queue:clear   (PowerShell)
 */
import "../lib/loadenv";
import { pipelineQueue, maintenanceQueue, connection } from "../lib/queue";
import { env } from "../lib/env";

async function main() {
  console.log("Clearing queues on:", env.redisUrl.replace(/:\/\/.*@/, "://***@"));
  const pipeline = pipelineQueue();
  const maintenance = maintenanceQueue();

  const before = {
    pipeline: await pipeline.getJobCounts(),
    maintenance: await maintenance.getJobCounts(),
  };
  console.log("Before:", JSON.stringify(before));

  await pipeline.obliterate({ force: true });
  await maintenance.obliterate({ force: true });

  console.log("✓ Both queues obliterated. Restart the worker so it re-registers the TTL sweep.");
  await pipeline.close();
  await maintenance.close();
  connection().disconnect();
}

main().catch((err) => {
  console.error("✗ queue:clear failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});

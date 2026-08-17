/**
 * Worker entry — `npm run worker`. Same codebase as `web`, different start
 * command. Registers BullMQ processors that run the pipeline stages + ffmpeg
 * assembly. Long-running, no public domain (see docs/architecture.md).
 *
 * Two workers:
 *   • pipeline    — dispatches each stage job to runStage().
 *   • maintenance — periodic TTL sweeper that re-queues cleanup for any project
 *                   whose expires_at has elapsed (covers missed delayed jobs).
 */
import "../lib/loadenv";
import { Worker, Queue } from "bullmq";
import {
  PIPELINE_QUEUE,
  MAINTENANCE_QUEUE,
  connectionOpts,
  pipelineQueue,
  jobId,
  type PipelineJob,
} from "../lib/queue";
import { runStage } from "../pipeline";
import { sweepExpired } from "../pipeline/stages/cleanupTtl";
import { log } from "../lib/logger";

const PIPELINE_CONCURRENCY = Number(process.env.WORKER_CONCURRENCY ?? 5);
const SWEEP_EVERY_MS = 15 * 60_000; // every 15 min

async function main() {
  log.info("worker starting", { concurrency: PIPELINE_CONCURRENCY });

  // --- pipeline worker ---
  const pipelineWorker = new Worker<PipelineJob>(
    PIPELINE_QUEUE,
    async (job) => runStage(job.data),
    {
      connection: connectionOpts(),
      concurrency: PIPELINE_CONCURRENCY,
      // Redeploy resilience: when Railway force-kills the worker mid-stage (after
      // graceful close's grace period), the in-flight job's lock expires and it
      // becomes "stalled". These settings make it get picked back up by the new
      // worker and re-run, rather than being dropped. lockDuration is generous so
      // a long ffmpeg/model stage isn't falsely flagged while the worker is alive
      // (the lock auto-renews); maxStalledCount tolerates a couple of interruptions
      // (e.g. back-to-back deploys) before giving up. Stage retries are idempotent.
      lockDuration: 60_000,
      stalledInterval: 30_000,
      maxStalledCount: 3,
    },
  );
  pipelineWorker.on("failed", (job, err) =>
    log.error("pipeline job failed", { id: job?.id, stage: job?.data?.stage, err: err.message }),
  );
  pipelineWorker.on("completed", (job) =>
    log.info("pipeline job completed", { id: job.id, stage: job.data?.stage }),
  );

  // --- maintenance worker (TTL sweeper) ---
  const maintenanceWorker = new Worker(
    MAINTENANCE_QUEUE,
    async () => {
      const due = await sweepExpired();
      for (const projectId of due) {
        await pipelineQueue().add(
          "cleanup.ttl",
          { projectId, stage: "cleanup.ttl", renderKind: "final" } satisfies PipelineJob,
          { jobId: jobId({ projectId, stage: "cleanup.ttl", renderKind: "final" }) },
        );
      }
      if (due.length) log.info("ttl sweep queued cleanups", { count: due.length });
    },
    { connection: connectionOpts() },
  );
  maintenanceWorker.on("failed", (_job, err) => log.error("maintenance failed", { err: err.message }));

  // Repeatable sweep job (idempotent jobId via the scheduler).
  const maintenanceQ = new Queue(MAINTENANCE_QUEUE, { connection: connectionOpts() });
  await maintenanceQ.add("ttl.sweep", {}, { repeat: { every: SWEEP_EVERY_MS }, jobId: "ttl.sweep" });

  log.info("worker ready", { queues: [PIPELINE_QUEUE, MAINTENANCE_QUEUE] });

  // Graceful shutdown.
  const shutdown = async (sig: string) => {
    log.info("worker shutting down", { sig });
    await Promise.allSettled([pipelineWorker.close(), maintenanceWorker.close(), maintenanceQ.close()]);
    process.exit(0);
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

main().catch((err) => {
  log.error("worker crashed on boot", { err: err instanceof Error ? err.message : String(err) });
  process.exit(1);
});

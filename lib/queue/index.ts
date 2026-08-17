/**
 * BullMQ queue wiring. The queue ONLY schedules work — a job carries the minimal
 * descriptor and the worker reads everything else from Postgres (the source of
 * truth). See docs/architecture.md "Job model".
 *
 * Two queues:
 *   - pipeline: one job per stage, chained on success (and fanned out for shots)
 *   - maintenance: the TTL cleanup sweeper (repeatable)
 */
import { Queue, type ConnectionOptions } from "bullmq";
import IORedis from "ioredis";
import { env } from "../env";

export const PIPELINE_QUEUE = "pipeline";
export const MAINTENANCE_QUEUE = "maintenance";

export type StageName =
  | "ingest.validate"
  | "album.analyze"
  | "faces.cluster"
  | "characters.stylize"
  | "music.prepare"
  | "beat.detect"
  | "director.storyboard"
  | "shots.generate"
  | "titlecard.render"
  | "assembly.compose"
  | "encode.final"
  | "deliver"
  | "cleanup.ttl";

export type RenderKind = "preview" | "final";

/**
 * Minimal job descriptor. `shotIdx` is present only for per-shot fan-out jobs
 * dispatched by shots.generate. Everything else is read from the DB by row.
 */
export interface PipelineJob {
  projectId: string;
  stage: StageName;
  renderKind: RenderKind;
  attempt?: number;
  shotIdx?: number; // set for the per-shot generate job (fan-out)
  /**
   * Unique per SUBMIT. Threaded through every stage of one run so job ids are
   * unique across runs (a resubmit re-runs cleanly) while still deduping within
   * a run. Absent for scheduled maintenance jobs (cleanup.ttl), which dedup
   * globally per project on purpose.
   */
  runToken?: string;
}

// A single shared ioredis connection per process. maxRetriesPerRequest must be
// null for BullMQ blocking commands.
let _connection: IORedis | null = null;
export function connection(): IORedis {
  if (_connection) return _connection;
  _connection = new IORedis(env.redisUrl, { maxRetriesPerRequest: null });
  return _connection;
}

export function connectionOpts(): ConnectionOptions {
  return connection() as unknown as ConnectionOptions;
}

let _pipelineQueue: Queue<PipelineJob> | null = null;
export function pipelineQueue(): Queue<PipelineJob> {
  if (_pipelineQueue) return _pipelineQueue;
  _pipelineQueue = new Queue<PipelineJob>(PIPELINE_QUEUE, {
    connection: connectionOpts(),
    defaultJobOptions: {
      attempts: 3,
      backoff: { type: "exponential", delay: 2_000 },
      removeOnComplete: 1_000,
      removeOnFail: 5_000,
    },
  });
  return _pipelineQueue;
}

let _maintenanceQueue: Queue | null = null;
export function maintenanceQueue(): Queue {
  if (_maintenanceQueue) return _maintenanceQueue;
  _maintenanceQueue = new Queue(MAINTENANCE_QUEUE, { connection: connectionOpts() });
  return _maintenanceQueue;
}

/**
 * Job id: unique per RUN (via runToken) so a resubmit re-runs the whole pipeline
 * cleanly, while still deduping stage re-entry WITHIN a run. Jobs without a
 * runToken (scheduled cleanup.ttl) keep the plain per-project id.
 *
 * NEVER use ':' as the separator here. BullMQ only special-cases a custom id
 * containing ':' when it splits into EXACTLY 3 parts (legacy compat with old
 * repeatable-job ids like "repeat:hash:timestamp") — any other count throws
 * "Custom Id cannot contain :". Our original 3-segment id happened to satisfy
 * that by coincidence; adding runToken as a 4th segment broke it. Using '|'
 * sidesteps the rule entirely regardless of how many segments we join.
 */
export function jobId(job: PipelineJob): string {
  const parts = [job.projectId, job.renderKind];
  if (job.runToken) parts.push(job.runToken);
  parts.push(job.stage);
  if (job.shotIdx !== undefined) parts.push(`shot${job.shotIdx}`);
  return parts.join("|");
}

/** A fresh run token for a new submit. */
export function newRunToken(): string {
  return Math.random().toString(36).slice(2, 10);
}

/** Enqueue a pipeline stage. Called by API routes (to kick off) and by stages
 *  (to chain to the next stage / fan out). API routes do nothing heavy here. */
export async function enqueueStage(job: PipelineJob): Promise<void> {
  await pipelineQueue().add(job.stage, job, { jobId: jobId(job) });
}

/**
 * Remove all pipeline jobs belonging to a project (every render kind, stage, and
 * per-shot fan-out job) — used when a project is deleted to cease generation.
 * Waiting/delayed/failed jobs are removed outright; an actively-running stage
 * can't be force-removed mid-lock (BullMQ throws) so it's left to finish, but
 * with the project rows gone it errors out harmlessly and schedules nothing new.
 */
export async function removeProjectJobs(projectId: string): Promise<number> {
  const q = pipelineQueue();
  const jobs = await q.getJobs(
    ["waiting", "delayed", "paused", "prioritized", "active", "failed", "completed"],
    0,
    10_000,
  );
  let removed = 0;
  for (const j of jobs) {
    if (j?.data?.projectId !== projectId) continue;
    try {
      await j.remove();
      removed++;
    } catch {
      /* active/locked jobs can't be removed — they'll error out on deleted rows */
    }
  }
  return removed;
}

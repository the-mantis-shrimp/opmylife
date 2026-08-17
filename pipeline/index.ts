/**
 * Stage registry + dispatcher. The worker hands each BullMQ job here; runStage
 * wraps the handler with job_runs logging (durable status the UI reads) and
 * structured error capture (written to job_runs.error + projects.error).
 *
 * The DB is the source of truth — handlers read rows by the descriptor and write
 * outputs/status back, so stages are idempotent and re-runnable.
 */
import type { PipelineJob, StageName } from "../lib/queue";
import { makeContext } from "./context";
import { startJobRun, finishJobRun, setProjectStatus } from "../lib/projects";
import { log } from "../lib/logger";

import { ingestValidate } from "./stages/ingestValidate";
import { albumAnalyze } from "./stages/albumAnalyze";
import { facesCluster } from "./stages/facesCluster";
import { charactersStylize } from "./stages/charactersStylize";
import { musicPrepare } from "./stages/musicPrepare";
import { beatDetect } from "./stages/beatDetect";
import { directorStoryboard } from "./stages/directorStoryboard";
import { shotsGenerate } from "./stages/shotsGenerate";
import { titlecardRender } from "./stages/titlecardRender";
import { assemblyCompose } from "./stages/assemblyCompose";
import { encodeFinal } from "./stages/encodeFinal";
import { deliver } from "./stages/deliver";
import { cleanupTtl } from "./stages/cleanupTtl";

import type { StageContext } from "./context";

type Handler = (ctx: StageContext) => Promise<void>;

const HANDLERS: Record<StageName, Handler> = {
  "ingest.validate": ingestValidate,
  "album.analyze": albumAnalyze,
  "faces.cluster": facesCluster,
  "characters.stylize": charactersStylize,
  "music.prepare": musicPrepare,
  "beat.detect": beatDetect,
  "director.storyboard": directorStoryboard,
  "shots.generate": shotsGenerate,
  "titlecard.render": titlecardRender,
  "assembly.compose": assemblyCompose,
  "encode.final": encodeFinal,
  deliver: deliver,
  "cleanup.ttl": cleanupTtl,
};

/**
 * Run a single pipeline stage with durable logging. Per-shot fan-out jobs
 * (shots.generate with a shotIdx) are NOT logged as full stage runs to avoid one
 * job_runs row per shot — the shots table already tracks per-shot status.
 */
export async function runStage(job: PipelineJob): Promise<void> {
  const handler = HANDLERS[job.stage];
  if (!handler) throw new Error(`No handler registered for stage ${job.stage}`);

  const ctx = makeContext(job);
  const isPerShot = job.stage === "shots.generate" && job.shotIdx !== undefined;

  let runId: string | null = null;
  if (!isPerShot) {
    runId = await startJobRun(job.projectId, job.stage, ctx.attempt);
  }
  log.info(`stage start: ${job.stage}`, { projectId: job.projectId, renderKind: job.renderKind, shotIdx: job.shotIdx });

  try {
    await handler(ctx);
    if (runId) await finishJobRun(runId, "succeeded");
  } catch (err) {
    const detail = { message: err instanceof Error ? err.message : String(err), stage: job.stage };
    if (runId) await finishJobRun(runId, "failed", detail);
    // Surface failure on the project so the UI can show it; failed stages stop
    // forward progress. Skip for: cleanup.ttl (shouldn't flip a delivered project)
    // and per-shot retries under the cap (a single shot retrying is normal — the
    // join decides overall success). The shots table tracks per-shot status.
    if (job.stage !== "cleanup.ttl" && !isPerShot) {
      await setProjectStatus(job.projectId, "failed", detail).catch(() => {});
    }
    throw err; // let BullMQ apply retry/backoff
  }
}

export { HANDLERS };

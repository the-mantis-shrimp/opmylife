/**
 * Per-stage execution context. A BullMQ job carries only the descriptor
 * { projectId, stage, renderKind, attempt, shotIdx }; the stage reads everything
 * else from Postgres (the DB is the source of truth). This context bundles the
 * descriptor plus the enqueue helper used to chain to the next stage.
 */
import { enqueueStage, type PipelineJob, type StageName, type RenderKind } from "../lib/queue";

export interface StageContext {
  projectId: string;
  renderKind: RenderKind;
  attempt: number;
  shotIdx?: number;
  runToken?: string;
  /** Chain to the next stage (or fan out). API routes never call this — only stages. */
  enqueue: (next: Partial<PipelineJob> & { stage: StageName }) => Promise<void>;
}

export function makeContext(job: PipelineJob): StageContext {
  return {
    projectId: job.projectId,
    renderKind: job.renderKind,
    attempt: job.attempt ?? 1,
    shotIdx: job.shotIdx,
    runToken: job.runToken,
    enqueue: (next) =>
      enqueueStage({
        projectId: job.projectId,
        renderKind: job.renderKind,
        runToken: job.runToken, // carry the run token to every chained stage
        attempt: 1,
        ...next,
      }),
  };
}

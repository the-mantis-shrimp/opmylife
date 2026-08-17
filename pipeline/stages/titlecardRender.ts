/**
 * titlecard.render — render the project title DETERMINISTICALLY (SVG/Remotion).
 * RULE: never ask a video/image model to render readable typography — it garbles
 * text. Title text is always code-rendered. The SVG is the canonical artifact;
 * for the Phase-1 ffmpeg assembly we also rasterize a short title segment via
 * ffmpeg drawtext (still deterministic code rendering, not a model).
 *
 * Stored at a deterministic key so assembly can find it without a new table.
 */
import { queryOne } from "../../lib/db";
import { putObject } from "../../lib/storage";
import { ffmpegAvailable, runFfmpeg, workDir, readFile, join } from "../../lib/media";
import { aspectDims } from "../../lib/projects";
import { log } from "../../lib/logger";
import type { StageContext } from "../context";

export function titleCardKey(projectId: string, ext: string): string {
  return `projects/${projectId}/titlecard/card.${ext}`;
}

export async function titlecardRender(ctx: StageContext): Promise<void> {
  const project = await queryOne<{ title: string; title_card_text: string | null; aspect_ratio: string }>(
    `SELECT title, title_card_text, aspect_ratio FROM projects WHERE id = $1`,
    [ctx.projectId],
  );
  // The user-set title-card text overrides the project title (falls back to it).
  const title = ((project?.title_card_text || project?.title) ?? "Untitled").slice(0, 60);
  const { w, h } = aspectDims(project?.aspect_ratio);
  const titleFont = Math.round(Math.min(w, h) * 0.11);
  const subFont = Math.round(Math.min(w, h) * 0.038);

  // Canonical deterministic artifact: an SVG title card, at the project aspect.
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">
  <rect width="${w}" height="${h}" fill="#0b1020"/>
  <text x="${w / 2}" y="${h / 2}" font-family="sans-serif" font-size="${titleFont}" font-weight="700"
        fill="#ffffff" text-anchor="middle" dominant-baseline="middle">${escapeXml(title)}</text>
  <text x="${w / 2}" y="${h / 2 + titleFont}" font-family="sans-serif" font-size="${subFont}" fill="#4f8cff"
        text-anchor="middle">an animated opening</text>
</svg>`;
  await putObject(titleCardKey(ctx.projectId, "svg"), Buffer.from(svg, "utf8"), "image/svg+xml");

  // Optional 2s title video segment for ffmpeg assembly, at the project aspect.
  if (await ffmpegAvailable()) {
    const { dir, cleanup } = await workDir();
    try {
      const out = join(dir, "title.mp4");
      const safe = title.replace(/[:\\']/g, " ");
      await runFfmpeg([
        "-f", "lavfi", "-i", `color=c=0x0b1020:s=${w}x${h}:d=2:r=24`,
        "-vf", `drawtext=text='${safe}':fontcolor=white:fontsize=${titleFont}:x=(w-text_w)/2:y=(h-text_h)/2`,
        "-pix_fmt", "yuv420p", out,
      ]);
      await putObject(titleCardKey(ctx.projectId, "mp4"), await readFile(out), "video/mp4");
    } finally {
      await cleanup();
    }
  }
  log.info("titlecard.render ok", { projectId: ctx.projectId });

  await ctx.enqueue({ stage: "assembly.compose" });
}

function escapeXml(s: string): string {
  return s.replace(/[<>&'"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '"': "&quot;" }[c]!));
}

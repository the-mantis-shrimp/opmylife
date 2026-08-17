/**
 * Vision LLM diagnostic. Exercises the live vision integration end-to-end
 * WITHOUT running the pipeline: a tiny storyboard request against the real
 * Claude API using the exact same code path as director.storyboard.
 *
 *   VISION_MODE=live npm run vision:check       (or set it in .env.local)
 *
 * Needs VISION_LLM_KEY. Costs a fraction of a cent. Prints the planned shots
 * or the precise API error (bad key, model access, etc.).
 */
import "../lib/loadenv";
import { env } from "../lib/env";
import { directStoryboardAlbumToLife } from "../lib/models/vision";

async function main() {
  console.log("Vision config:");
  console.log("  mode :", env.visionMode);
  console.log("  model:", env.visionLlmModel);
  console.log("  key  :", env.visionLlmKey ? `set (len ${env.visionLlmKey.length})` : "(empty)");

  if (env.visionMode !== "live") {
    console.log("\nVISION_MODE is not 'live' — this check exercises the stub path only.");
  }

  const beat = {
    bpm: 120,
    durationMs: 30_000,
    beats: Array.from({ length: 61 }, (_, i) => i * 500),
    sections: [
      { label: "intro", startMs: 0 },
      { label: "verse", startMs: 8_000 },
      { label: "drop", startMs: 20_000 },
    ],
  };
  const analysis = {
    summary: "A small test album of two friends hiking at golden hour.",
    mood: "warm, adventurous",
    palette: ["#f4a261", "#2a9d8f"],
    perAsset: {},
  };

  try {
    // One shot per PHOTO now — 4 test photos, each with an owning character + description.
    const photos = [
      { idx: 0, label: "Alex", description: "Alex smiling on a mountain ridge at sunset." },
      { idx: 1, label: "Sam", description: "Sam laughing mid-stride on the trail." },
      { idx: 2, label: "Alex", description: "Alex sitting by a campfire at night." },
      { idx: 3, label: "Sam", description: "Sam and Alex both in frame, high-fiving at the summit." },
    ];
    const plan = await directStoryboardAlbumToLife(photos, beat, analysis);
    console.log(`\n✓ Storyboard OK: ${plan.shots.length} shots (should equal ${photos.length} photos), title card @ ${plan.titleCardAtMs}ms`);
    for (const s of plan.shots) {
      console.log(`  #${s.idx} ${s.shotType} (${s.motion})`);
    }
  } catch (err) {
    console.error("\n✗ Vision check failed:");
    console.error(" ", err instanceof Error ? err.message : err);
    process.exitCode = 1;
  }
}

main();

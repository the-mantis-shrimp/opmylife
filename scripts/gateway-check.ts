/**
 * Gateway (fal.ai) diagnostic. Validates MODEL_GATEWAY_KEY and the configured
 * model routes without running the pipeline.
 *
 *   GATEWAY_MODE=live npm run gateway:check              # image stylize only (~$0.05)
 *   GATEWAY_CHECK_VIDEO=1 GATEWAY_MODE=live npm run gateway:check
 *                                                        # + one 5s preview-route video (~$0.25-0.50)
 *
 * Uses a tiny generated test image, so no project/photos are needed. Prints the
 * stored R2 keys on success or the precise fal error.
 */
import "../lib/loadenv";
import { env } from "../lib/env";
import { putObject } from "../lib/storage";
import { stylizeCharacter, generateShot } from "../lib/models/gateway";

// 1x1 red PNG (expanded server-side by the model; enough to validate the route/auth)
const TEST_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

async function main() {
  console.log("Gateway config:");
  console.log("  mode           :", env.gatewayMode);
  console.log("  key            :", env.modelGatewayKey ? `set (len ${env.modelGatewayKey.length})` : "(empty)");
  console.log("  IMAGE_MODEL    :", env.imageModel);
  console.log("  I2V preview    :", env.i2vModelPreview);
  console.log("  I2V final      :", env.i2vModelFinal);

  if (env.gatewayMode !== "live") {
    console.log("\nGATEWAY_MODE is not 'live' — exercising the stub path only.");
  }

  const projectId = "00000000-0000-0000-0000-00000000diag";
  try {
    const srcKey = `projects/${projectId}/photos/diag.png`;
    await putObject(srcKey, TEST_PNG, "image/png");

    console.log("\n→ stylizeCharacter …");
    const styled = await stylizeCharacter({
      projectId,
      characterId: "diag-character",
      label: "Diag",
      sourceKeys: [srcKey],
      style: "anime",
    });
    console.log(`✓ stylize OK → ${styled.refKey} (model ${styled.styleMeta.model})`);

    if (process.env.GATEWAY_CHECK_VIDEO === "1") {
      console.log("\n→ generateShot (preview route — this spends real money) …");
      const clip = await generateShot({
        projectId,
        characterId: "diag-character",
        characterLabel: "Diag",
        durationMs: 1000,
        shotType: "close-up",
        motion: "slow push-in",
        refKey: styled.refKey,
        renderKind: "preview",
        style: "anime",
      });
      console.log(`✓ i2v OK → ${clip.clipKey}`);
    } else {
      console.log("\n(skipped video generation — set GATEWAY_CHECK_VIDEO=1 to test the i2v route)");
    }
    console.log("\nNote: diagnostic objects live under projects/" + projectId + "/ — delete at will.");
  } catch (err) {
    console.error("\n✗ Gateway check failed:");
    console.error(" ", err instanceof Error ? err.message : err);
    process.exitCode = 1;
  }
}

main();

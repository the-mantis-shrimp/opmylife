/**
 * characters.stylize — build the stylized reference image(s), mode-dependent:
 *
 *   album-to-life: stylize EACH photo individually (preserving that photo's
 *     outfit/pose/background) while anchoring the FACE to the person's first
 *     photo — so attire varies shot-to-shot but identity stays consistent.
 *     Writes assets.ref_r2_key per photo.
 *   animate-me: ONE shared reference per person, reused across every shot for
 *     maximum identity consistency. Writes characters.ref_r2_key.
 *
 * Idempotent: only fills refs that are missing.
 */
import { query, queryOne } from "../../lib/db";
import { stylizeCharacter } from "../../lib/models/gateway";
import { setProjectStatus, isOpStyle, isOpMode, IMAGE_MODELS, DEFAULT_IMAGE_MODEL, getStyleRefKeys } from "../../lib/projects";
import { log } from "../../lib/logger";
import type { StageContext } from "../context";

interface CharacterRow { id: string; label: string | null; source_asset_ids: string[]; ref_r2_key: string | null }

export async function charactersStylize(ctx: StageContext): Promise<void> {
  await setProjectStatus(ctx.projectId, "styling");

  const proj = await queryOne<{ style: string; mode: string; image_model: string }>(
    `SELECT style, mode, image_model FROM projects WHERE id = $1`,
    [ctx.projectId],
  );
  const style = isOpStyle(proj?.style) ? proj.style : "original";
  const mode = isOpMode(proj?.mode) ? proj.mode : "album-to-life";
  const modelEndpoint = IMAGE_MODELS[proj?.image_model ?? DEFAULT_IMAGE_MODEL]?.endpoint ?? null;
  // Optional user-supplied style references — applied to every stylization.
  const styleRefKeys = await getStyleRefKeys(ctx.projectId);

  const characters = await query<CharacterRow>(
    `SELECT id, label, source_asset_ids, ref_r2_key FROM characters WHERE project_id = $1 ORDER BY created_at`,
    [ctx.projectId],
  );
  if (characters.length === 0) {
    throw new Error("characters.stylize: no characters to stylize (cluster + manual path both empty).");
  }

  if (mode === "animate-me") {
    // One shared reference per person.
    for (const ch of characters) {
      if (ch.ref_r2_key) continue;
      const keys = await query<{ r2_key: string }>(`SELECT r2_key FROM assets WHERE id = ANY($1::uuid[])`, [ch.source_asset_ids]);
      const result = await stylizeCharacter({
        projectId: ctx.projectId,
        characterId: ch.id,
        label: ch.label ?? "Character",
        sourceKeys: keys.map((k) => k.r2_key),
        style,
        modelEndpoint,
        styleRefKeys,
      });
      await query(`UPDATE characters SET ref_r2_key = $2, style_meta = $3 WHERE id = $1`, [
        ch.id,
        result.refKey,
        JSON.stringify(result.styleMeta),
      ]);
    }
    log.info("characters.stylize ok (animate-me)", { projectId: ctx.projectId, characters: characters.length });
    await ctx.enqueue({ stage: "music.prepare" });
    return;
  }

  // album-to-life: EVERY validated photo becomes a shot, so every photo needs a
  // stylized reference — including landscape/scenery photos that belong to no
  // character (otherwise their shot has no refKey and shots.generate throws).
  //
  // Owned photos anchor their FACE to the person's first photo (identity stays
  // consistent as attire varies). Orphan photos (no person) are stylized as
  // scenery with no face anchor.
  const anchorByAsset = new Map<string, string>();
  const labelByAsset = new Map<string, { characterId: string; label: string }>();
  for (const ch of characters) {
    const owned = await query<{ id: string; r2_key: string }>(
      `SELECT id, r2_key FROM assets WHERE id = ANY($1::uuid[]) AND kind = 'photo' ORDER BY position, created_at`,
      [ch.source_asset_ids],
    );
    const anchorKey = owned[0]?.r2_key;
    for (const p of owned) {
      if (anchorKey) anchorByAsset.set(p.id, anchorKey);
      labelByAsset.set(p.id, { characterId: ch.id, label: ch.label ?? "Character" });
    }
  }

  const allPhotos = await query<{ id: string; r2_key: string; ref_r2_key: string | null }>(
    `SELECT id, r2_key, ref_r2_key FROM assets
       WHERE project_id = $1 AND kind = 'photo' AND validated = true
       ORDER BY position, created_at`,
    [ctx.projectId],
  );

  let styled = 0;
  for (const photo of allPhotos) {
    if (photo.ref_r2_key) continue; // already stylized
    const owner = labelByAsset.get(photo.id);
    const result = await stylizeCharacter({
      projectId: ctx.projectId,
      characterId: owner?.characterId ?? "scene",
      label: owner?.label ?? "the scene",
      sourceKeys: [photo.r2_key],
      style,
      anchorKey: anchorByAsset.get(photo.id), // undefined for orphan/landscape photos
      preserveContent: true,
      modelEndpoint,
      styleRefKeys,
    });
    await query(`UPDATE assets SET ref_r2_key = $2, style_meta = $3 WHERE id = $1`, [
      photo.id,
      result.refKey,
      JSON.stringify(result.styleMeta),
    ]);
    styled++;
  }
  log.info("characters.stylize ok (album-to-life)", {
    projectId: ctx.projectId,
    photosStyled: styled,
    total: allPhotos.length,
  });

  await ctx.enqueue({ stage: "music.prepare" });
}

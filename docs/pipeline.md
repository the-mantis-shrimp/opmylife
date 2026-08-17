# Pipeline

The render pipeline, stage by stage. Each stage is a BullMQ job processed in `worker`. A stage reads its inputs from Postgres/R2, does its work, writes outputs + status back, and enqueues the next stage. Stages are **idempotent** — re-entry must not duplicate rows or double-charge.

Order:

```
ingest.validate → album.analyze → faces.cluster* → characters.stylize
→ music.prepare + beat.detect → director.storyboard → shots.generate
→ titlecard.render → assembly.compose → encode.final + deliver → cleanup.ttl
```

\* `faces.cluster` runs **only with biometric consent**; otherwise the manual-tagging path fills the same `characters` rows and everything downstream is identical.

Each stage below: **trigger → reads → does → writes → next**, plus failure handling.

---

## ingest.validate
- **Trigger:** user finishes uploading and submits the project.
- **Reads:** `assets` (photos, optional music) from R2.
- **Does:** validate format/size/count; basic content safety check; reject unusable files with actionable errors.
- **Writes:** `assets.validated = true`; `projects.status = 'ingesting'→'analyzing'`.
- **Next:** `album.analyze`. **Fail:** mark stage failed, surface which files and why; do not proceed.

## album.analyze
- **Reads:** validated photos.
- **Does:** Vision LLM pass — describe people, scenes, mood, aesthetic; produce hints used later by stylize + director.
- **Writes:** `assets.meta` annotations (and/or a project-level analysis blob).
- **Next:** `faces.cluster` if consent granted, else skip straight to the manual path feeding `characters.stylize`.

## faces.cluster  *(consent-gated)*
- **Trigger:** only if the latest `consents` row for `kind='biometric'` is `granted=true`.
- **Does:** cluster faces across photos into distinct people.
- **Writes:** `characters` rows (one per person) with `source_asset_ids`; `projects.identity_path='cluster'`.
- **Skip path:** no consent → stage status `skipped`; the **manual-tagging** UI (collected earlier) has already written `characters` rows with `identity_path='manual'`. Downstream cannot tell the difference.
- **Never** run face processing without a granted biometric consent row. This is the single most important rule in the pipeline.

## characters.stylize
- **Reads:** `characters` + their source photos + project `style` + `mode`.
- **Does (mode-dependent):**
  - **animate-me:** one shared reference per person (in the chosen `style`), reused across every shot → maximum identity consistency. Writes `characters.ref_r2_key`.
  - **album-to-life:** stylizes **each photo individually**, preserving that photo's outfit/pose/background while **anchoring the face** to the person's first photo — so attire varies shot-to-shot but identity stays consistent. Writes `assets.ref_r2_key` per photo.
  - `original` style skips the model call in both modes and uses the source photo(s) directly.
- **Writes:** `ref_r2_key` + `style_meta` (prompt/seed/model). Idempotent: only fills refs that are missing.
- **Next:** `music.prepare`.

## title card + video model (project settings)
- **Title card** (`titlecard.render` + `assembly.compose`): the title text is `projects.title_card_text` (falls back to `projects.title`). The `projects.title_transition` controls how it joins the first shot — `cut` (hard), `fade-in` (from black), or `fade-over` (ffmpeg `xfade` crossfade into the first shot).
- **Video model** (`shots.generate`): `projects.video_model` selects the i2v endpoint from `lib/projects` `VIDEO_MODELS` (Kling 2.1 / Kling v3 Pro / Veo 3.1), or `auto` = the env-configured route.
- **Re-roll:** re-submitting a render_kind first clears its prior `shots` / `renders` / `storyboards` (keeping stylized references), so a fresh generation runs instead of reusing existing clips.

## music.prepare + beat.detect
- **Reads:** `music_tracks` (generated default via Suno/Udio, or uploaded if the user opted in and accepted liability) — including the user's **trim window** (`trim_start_ms`/`trim_end_ms`).
- **Does:** ensure the full track exists and **probe its real duration** (real songs aren't authored to ~90s); resolve + clamp the OP **window** (`lib/music`, 15–120s); **cut that start→stop window** into a working OP audio file (`opAudioKey`); then detect **real** BPM, beat timestamps, and section boundaries **over the trimmed window** (onset-energy + autocorrelation DSP on the decoded PCM — `lib/beat`, no external API) — this is the grid everything cuts to.
- **Writes:** `music_tracks.duration_ms` (full length), `trim_start_ms`/`trim_end_ms` (resolved window), `bpm`, `beat_grid` (over the window). The trimmed OP audio at `opAudioKey` is what `assembly.compose` muxes.
- **Next:** `director.storyboard`.

## director.storyboard — two modes (`projects.mode`)
Which mode is selected changes how the shot list is built. Both write `storyboards.plan` + `shots` rows for the active `render_kind` and hand off to `shots.generate`. Cuts always align to real beat timestamps (code-enforced), and each shot uses its owning character's **shared** `characters.ref_r2_key` (consistent identity).

- **`album-to-life`:** **one shot per uploaded photo, used exactly once, in upload order — no clip reuse.** The vision LLM only chooses the *creative* fields per shot (shot type, motion); exact timing is computed in code from the beat grid (cuts snapped to actual beats, or evenly divided if there are fewer beats than photos), and shot count always equals photo count. `reused_from` is always `NULL`.
  > **Deviation from `CLAUDE.md`'s "prefer clip reuse" cost control** — by explicit product decision this mode uses every photo once and repeats none, roughly **doubling** shot-generation spend vs. reuse. Flagged, not silently dropped.
- **`animate-me`:** the director plans a beat-driven shot list of variable length (12–24 shots) where characters can appear and **be reused** across cuts (honoring the reuse cost control), optionally guided by the user's free-text `direction`. `shots.reused_from` is set where the director repeats a clip.

## shots.generate  *(fan-out)*
- **Does:** enqueue **one job per shot**. Each shot job calls the i2v gateway (Kling-class default, routed per shot) using its character's `ref_r2_key` to keep identity stable. Shots with `reused_from` (animate-me) copy the referenced clip instead of regenerating.
- **Writes:** per shot — `shots.status`, `shots.clip_r2_key`, `shots.attempts`.
- **Cost controls (enforce):**
  - **Cap attempts per shot** (`shots.attempts`); after the cap, fail the shot rather than burning budget.
  - **Clip reuse** via `shots.reused_from` — used in `animate-me`; not used in `album-to-life` (by product decision).
- **Join:** a barrier waits until all shots for the active `render_kind` are `succeeded` (or capped-failed) before `assembly.compose`.

## titlecard.render
- **Does:** render the project title + any credits **deterministically** via Remotion/SVG.
- **Rule:** **never** ask a video/image model to render readable kanji/typography — it garbles text. Title text is code-rendered, always.
- **Writes:** a title-card asset key for assembly.

## assembly.compose
- **Reads:** shot clips + title card + prepared music + beat grid.
- **Does:** ffmpeg/Remotion assembly — lay clips on the beat grid, drop in the title card, sync to audio. CPU-only (no GPU on our compute).
- **Writes:** a composed timeline / intermediate.
- **Next:** `encode.final`.

## encode.final + deliver  *(the charge point)*
- **Preview path:** cheap model upstream, **low-res, watermarked, free**. Produces `renders(kind='preview', watermarked=true, charged=false)`. **No ledger entry.**
- **Final path:** full-res, clean. **This is the only place credits are charged.** In one transaction: check `renders.charged` is false → write `credit_ledger` `charge_final` (negative `delta`) → set `renders.charged=true`, `watermarked=false`, `r2_key`. Never charge for drafts, previews, or internal retries.
- **Deliver:** upload final MP4 to R2, expose a download/share link; set `projects.status='ready'`.
- **Next:** schedule `cleanup.ttl`.

## cleanup.ttl  *(server-side, scheduled)*
- **Trigger:** scheduled after render completes (and/or a sweeper scanning `projects.expires_at`). **Never** tied to browser close — renders outlive the session.
- **Does:** delete inputs/outputs from R2 per the lifecycle promise; mark `projects.status='expired'`.
- This backs the privacy promise; see `privacy-and-consent.md`.

---

## Cross-cutting rules

- **DB is source of truth**; the queue only schedules. A job carries `{projectId, stage, attempt}` and reads the rest.
- **Idempotent re-entry** via `job_runs` status + natural keys (`shots UNIQUE(project_id,render_kind,idx)`, `renders UNIQUE(project_id,kind)`).
- **Errors** are written to `job_runs.error` / `projects.error` as structured JSON the UI surfaces; failed stages stop forward progress.
- **Preview vs final** reuse the same stages with different model routing and the watermark/charge behavior above.

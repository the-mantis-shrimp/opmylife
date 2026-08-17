-- ai-anime-op schema — the build-doc schema (see docs/data-model.md).
-- The DB is the SOURCE OF TRUTH; the queue only schedules work. Every pipeline
-- stage reads inputs from here and writes outputs/status back so stages are
-- idempotent and re-runnable. This file is applied by `npm run migrate`.
--
-- Safe to re-run: every CREATE is guarded so migration is idempotent.

CREATE EXTENSION IF NOT EXISTS pgcrypto;  -- gen_random_uuid()

-- ──────────────────────────────────────────────────────────────────────────
-- Enums
-- ──────────────────────────────────────────────────────────────────────────
DO $$ BEGIN
  CREATE TYPE project_status AS ENUM (
    'draft', 'ingesting', 'analyzing', 'styling', 'storyboarding',
    'generating', 'assembling', 'encoding', 'ready', 'failed', 'expired'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE stage_name AS ENUM (
    'ingest.validate', 'album.analyze', 'faces.cluster', 'characters.stylize',
    'music.prepare', 'beat.detect', 'director.storyboard', 'shots.generate',
    'titlecard.render', 'assembly.compose', 'encode.final', 'deliver', 'cleanup.ttl'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE stage_status AS ENUM ('pending', 'running', 'succeeded', 'failed', 'skipped');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE asset_kind AS ENUM ('photo', 'music_upload');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE identity_path AS ENUM ('cluster', 'manual');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE render_kind AS ENUM ('preview', 'final');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE music_source AS ENUM ('generated', 'uploaded');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE ledger_reason AS ENUM ('grant', 'purchase', 'charge_final', 'refund', 'adjust');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ──────────────────────────────────────────────────────────────────────────
-- Tables
-- ──────────────────────────────────────────────────────────────────────────

-- users: mirror of Clerk identity; everything keys to our own users.id.
-- preview_count is a DURABLE lifetime counter for the free-preview cap (Redis
-- would reset on flush and hand out free previews).
CREATE TABLE IF NOT EXISTS users (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  clerk_id      text UNIQUE NOT NULL,
  email         text,
  preview_count int NOT NULL DEFAULT 0,
  created_at    timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE users ADD COLUMN IF NOT EXISTS preview_count int NOT NULL DEFAULT 0;

-- projects: one generation = one project.
CREATE TABLE IF NOT EXISTS projects (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title          text NOT NULL,
  status         project_status NOT NULL DEFAULT 'draft',
  identity_path  identity_path,
  music_source   music_source,
  style          text NOT NULL DEFAULT 'original', -- 'original' | 'pixar' (3D cartoon) | 'anime' | 'fantasy' | 'reference'
  mode           text NOT NULL DEFAULT 'album-to-life', -- 'album-to-life' | 'animate-me'
  direction      text,                           -- free-text creative direction (animate-me only)
  title_card_text text,                          -- title card text (falls back to `title`)
  title_transition text NOT NULL DEFAULT 'none',  -- 'none' (no title card) | 'cut' | 'fade-in' | 'fade-over'
  video_model    text NOT NULL DEFAULT 'kling-3-pro',    -- i2v model key (see lib/projects VIDEO_MODELS)
  image_model    text NOT NULL DEFAULT 'nano-banana-pro', -- stylization model key (see lib/projects IMAGE_MODELS)
  aspect_ratio   text NOT NULL DEFAULT 'portrait', -- 'portrait' (9:16) | 'landscape' (16:9)
  silent_length_ms int NOT NULL DEFAULT 30000,   -- video length when there's no music (silent)
  expires_at     timestamptz,
  error          jsonb,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_projects_user_id ON projects (user_id);
CREATE INDEX IF NOT EXISTS idx_projects_status ON projects (status);
CREATE INDEX IF NOT EXISTS idx_projects_expires_at ON projects (expires_at);
-- Upgrade path for existing databases (no-op on fresh ones):
ALTER TABLE projects ADD COLUMN IF NOT EXISTS style text NOT NULL DEFAULT 'original';
ALTER TABLE projects ALTER COLUMN style SET DEFAULT 'original';
ALTER TABLE projects ADD COLUMN IF NOT EXISTS mode text NOT NULL DEFAULT 'album-to-life';
ALTER TABLE projects ADD COLUMN IF NOT EXISTS direction text;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS title_card_text text;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS title_transition text NOT NULL DEFAULT 'none';
ALTER TABLE projects ALTER COLUMN title_transition SET DEFAULT 'none'; -- new projects: no title card by default
ALTER TABLE projects ADD COLUMN IF NOT EXISTS video_model text NOT NULL DEFAULT 'kling-3-pro';
ALTER TABLE projects ADD COLUMN IF NOT EXISTS image_model text NOT NULL DEFAULT 'nano-banana-pro';
-- The old 'auto' sentinel was removed (the UI now lists concrete models); point the
-- column defaults and any legacy rows at the real default models.
ALTER TABLE projects ALTER COLUMN video_model SET DEFAULT 'kling-3-pro';
ALTER TABLE projects ALTER COLUMN image_model SET DEFAULT 'nano-banana-pro';
UPDATE projects SET video_model = 'kling-3-pro' WHERE video_model = 'auto';
UPDATE projects SET image_model = 'nano-banana-pro' WHERE image_model = 'auto';
ALTER TABLE projects ADD COLUMN IF NOT EXISTS aspect_ratio text NOT NULL DEFAULT 'portrait';
ALTER TABLE projects ADD COLUMN IF NOT EXISTS silent_length_ms int NOT NULL DEFAULT 30000;

-- consents: VERSIONED, APPEND-ONLY. Biometric consent is its own row, distinct
-- from ToS. Never update in place — a changed decision is a new row.
CREATE TABLE IF NOT EXISTS consents (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id     uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  user_id        uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind           text NOT NULL,            -- 'biometric' | 'tos' | 'music_liability'
  granted        boolean NOT NULL,
  policy_version text NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_consents_project_kind ON consents (project_id, kind, created_at DESC);

-- assets: uploaded inputs (photos, optional music). Bytes live in R2; row holds key + meta.
CREATE TABLE IF NOT EXISTS assets (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id  uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  kind        asset_kind NOT NULL,
  r2_key      text NOT NULL,
  mime        text,
  bytes       bigint,
  width       int,
  height      int,
  position    int NOT NULL DEFAULT 0,          -- user-controlled display order
  validated   boolean NOT NULL DEFAULT false,
  ref_r2_key  text,                            -- album-to-life: this photo's stylized reference
  style_meta  jsonb,                           -- prompt/seed/model for this photo's stylization
  meta        jsonb,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_assets_project_kind ON assets (project_id, kind);
-- Upgrade path for existing databases (no-op on fresh ones):
ALTER TABLE assets ADD COLUMN IF NOT EXISTS position int NOT NULL DEFAULT 0;
ALTER TABLE assets ADD COLUMN IF NOT EXISTS ref_r2_key text;
ALTER TABLE assets ADD COLUMN IF NOT EXISTS style_meta jsonb;

-- style_refs: OPTIONAL user-supplied style reference images (up to 3). They guide
-- characters.stylize ("make it look like THIS") — the art style to match, on top
-- of the chosen style preset. Kept separate from `assets` (they're not album
-- content). Deleted with the project prefix by cleanup.ttl.
CREATE TABLE IF NOT EXISTS style_refs (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id  uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  r2_key      text NOT NULL,
  mime        text,
  bytes       bigint,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_style_refs_project ON style_refs (project_id);

-- characters: the stylized cast. Same columns whether derived from face clusters
-- (consent path) or manual tags (no-consent path).
CREATE TABLE IF NOT EXISTS characters (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id       uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  label            text,
  source_asset_ids uuid[] NOT NULL,
  ref_r2_key       text,
  style_meta       jsonb,
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_characters_project ON characters (project_id);

-- music_tracks: chosen track (generated or uploaded) + beat analysis.
-- duration_ms is the FULL track length; trim_start_ms/trim_end_ms select the OP
-- window cut from it (real songs aren't authored to end at ~90s). The effective
-- OP length = trim_end_ms - trim_start_ms (see lib/music).
CREATE TABLE IF NOT EXISTS music_tracks (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id    uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  source        music_source NOT NULL,
  r2_key        text NOT NULL,                  -- full track (used by the UI scrubber)
  duration_ms   int,                            -- full track duration
  trim_start_ms int NOT NULL DEFAULT 0,         -- OP window start within the track
  trim_end_ms   int,                            -- OP window end (null → defaulted in music.prepare)
  bpm           numeric,
  beat_grid     jsonb,                          -- computed over the trimmed window
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_music_tracks_project ON music_tracks (project_id);
-- Upgrade path for existing databases (no-op on fresh ones):
ALTER TABLE music_tracks ADD COLUMN IF NOT EXISTS trim_start_ms int NOT NULL DEFAULT 0;
ALTER TABLE music_tracks ADD COLUMN IF NOT EXISTS trim_end_ms int;

-- storyboards: director output — timed shot list cut to the beat grid.
CREATE TABLE IF NOT EXISTS storyboards (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id  uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  plan        jsonb NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_storyboards_project ON storyboards (project_id);

-- shots: one row per shot. UNIQUE(project_id, render_kind, idx) makes generation
-- idempotent and ordering deterministic.
CREATE TABLE IF NOT EXISTS shots (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id    uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  idx           int NOT NULL,
  render_kind   render_kind NOT NULL,
  character_id  uuid REFERENCES characters(id),
  start_ms      int NOT NULL,
  end_ms        int NOT NULL,
  prompt        jsonb NOT NULL,
  status        stage_status NOT NULL DEFAULT 'pending',
  attempts      int NOT NULL DEFAULT 0,
  clip_r2_key   text,
  error         jsonb,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, render_kind, idx)
);
CREATE INDEX IF NOT EXISTS idx_shots_project_kind_status ON shots (project_id, render_kind, status);
-- Clip reuse was removed (animate-me now composes a fresh scene per shot); drop
-- the now-unused column on existing databases.
ALTER TABLE shots DROP COLUMN IF EXISTS reused_from;

-- renders: composed outputs. UNIQUE(project_id, kind) — one preview, one final.
CREATE TABLE IF NOT EXISTS renders (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id   uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  kind         render_kind NOT NULL,
  r2_key       text,
  watermarked  boolean NOT NULL,
  duration_ms  int,
  charged      boolean NOT NULL DEFAULT false,
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, kind)
);

-- render_history: APPEND-ONLY archive of every completed render. Snapshotted at
-- the deliver stage to a VERSIONED key so a re-roll (which overwrites the live
-- render key) never destroys a result the user liked. View + download only.
CREATE TABLE IF NOT EXISTS render_history (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id    uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  kind          render_kind NOT NULL,
  r2_key        text NOT NULL,                   -- immutable, playable deliverable
  watermarked   boolean NOT NULL DEFAULT false,
  hd            boolean NOT NULL DEFAULT false,
  width         int,
  height        int,
  duration_ms   int,
  charged       boolean NOT NULL DEFAULT false,
  label         text,
  run_token     text,                            -- dedup: one snapshot per delivery run
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_render_history_project ON render_history (project_id, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS uniq_render_history_run
  ON render_history (project_id, kind, run_token) WHERE run_token IS NOT NULL;

-- job_runs: per-stage execution log — durable status the UI reads + retry audit trail.
CREATE TABLE IF NOT EXISTS job_runs (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id   uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  stage        stage_name NOT NULL,
  status       stage_status NOT NULL DEFAULT 'pending',
  attempt      int NOT NULL DEFAULT 1,
  started_at   timestamptz,
  finished_at  timestamptz,
  error        jsonb,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_job_runs_project_stage ON job_runs (project_id, stage, created_at DESC);

-- credit_ledger: APPEND-ONLY. Balance = sum(delta). The only generation-tied
-- negative entry is charge_final, written transactionally with renders.charged=true.
CREATE TABLE IF NOT EXISTS credit_ledger (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  project_id  uuid REFERENCES projects(id) ON DELETE SET NULL,
  delta       int NOT NULL,
  reason      ledger_reason NOT NULL,
  stripe_ref  text,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_credit_ledger_user ON credit_ledger (user_id, created_at DESC);
-- A user's stub starting grant is seeded exactly once; this partial unique index
-- enforces "one grant per user" so re-running onboarding never double-grants.
CREATE UNIQUE INDEX IF NOT EXISTS uniq_credit_grant_per_user
  ON credit_ledger (user_id) WHERE reason = 'grant';
-- A Stripe purchase/refund grants exactly once even if the webhook retries
-- (Stripe delivers at-least-once) — dedup on the Stripe session/event id.
CREATE UNIQUE INDEX IF NOT EXISTS uniq_credit_ledger_stripe_ref
  ON credit_ledger (stripe_ref) WHERE stripe_ref IS NOT NULL;

-- ── Trust & safety ──────────────────────────────────────────────────────────
-- moderation_flags: a CSAM scan hit. Durable evidence record. asset_id/user_id
-- are NOT FKs so the record survives even if rows are otherwise touched — a
-- flagged project is under legal hold and won't be deleted anyway.
CREATE TABLE IF NOT EXISTS moderation_flags (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id      uuid,
  asset_id        uuid,
  user_id         uuid,
  provider        text NOT NULL,
  score           numeric,
  known_match     boolean NOT NULL DEFAULT false,   -- true = matched a known hash (vs classifier)
  detail          jsonb,
  status          text NOT NULL DEFAULT 'open',      -- open | pending_manual | reported | cleared
  ncmec_report_id text,
  reported_at     timestamptz,
  reviewed_at     timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_moderation_flags_status ON moderation_flags (status, created_at DESC);

-- legal_hold: a flagged project is EXEMPT from all deletion (TTL, sweeper, user
-- delete) so the content is preserved for the reporting/retention window.
ALTER TABLE projects ADD COLUMN IF NOT EXISTS legal_hold boolean NOT NULL DEFAULT false;

/**
 * Side-effect module: load environment files for the standalone Node entrypoints
 * (`worker`, `migrate`) which — unlike Next.js — don't auto-load .env files.
 * Import this FIRST, before any module that reads process.env (e.g. lib/env).
 * In Railway, real env vars are already set and these files simply won't exist.
 */
import { config } from "dotenv";

config({ path: ".env.local" });
config(); // .env fallback; dotenv never overrides already-set vars

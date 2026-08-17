/**
 * Demo-gallery items. Videos live in the dedicated public R2 bucket
 * (GALLERY_ASSET_BASE_URL served publicly; GALLERY_BUCKET is its name) — see
 * docs/gallery-assets.md. TITLES are derived from the filename, so naming a file
 * `sample_New-Years-Abroad.mp4` shows as "New Years Abroad".
 *
 * When GALLERY_BUCKET is set we LIST it (drop a file in → it appears); otherwise
 * we fall back to the code list below.
 */
import { env } from "./env";
import { listBucketKeys } from "./storage";
import { log } from "./logger";

export interface GalleryItem {
  title: string;
  slug: string;
  src?: string;
  poster?: string;
}

/** URL-safe anchor id derived from the title, shared by the homepage + gallery. */
export function gallerySlug(title: string): string {
  return title.replace(/[^a-z0-9]+/gi, "-").replace(/^-+|-+$/g, "").toLowerCase();
}

// Fallback filenames used when GALLERY_BUCKET isn't set (edit as needed).
const FALLBACK_FILES = [
  "sample_Summer-Arc.mp4",
  "sample_Best-Friends.mp4",
  "sample_Road-Trip.mp4",
  "sample_Graduation.mp4",
];

/** "sample_New-Years-Abroad.mp4" → "New Years Abroad". */
export function titleFromFile(filename: string): string {
  return filename
    .replace(/\.[^.]+$/, "") // drop extension
    .replace(/^sample[_-]/i, "") // drop a leading "sample_" / "sample-"
    .replace(/[_-]+/g, " ") // separators → spaces
    .replace(/\s+/g, " ")
    .trim();
}

async function listVideoFiles(): Promise<string[]> {
  if (env.galleryBucket) {
    try {
      const keys = await listBucketKeys(env.galleryBucket);
      const videos = keys.filter((k) => /\.(mp4|webm|mov)$/i.test(k)).sort();
      if (videos.length) return videos;
    } catch (err) {
      log.warn("gallery: bucket list failed, using fallback list", { err: err instanceof Error ? err.message : String(err) });
    }
  }
  return FALLBACK_FILES;
}

/** Resolve the sample list to public URLs + derived titles. */
export async function galleryItems(): Promise<GalleryItem[]> {
  const base = env.galleryAssetBaseUrl.replace(/\/+$/, "");
  const files = await listVideoFiles();
  return files.map((file) => ({
    title: titleFromFile(file),
    slug: gallerySlug(titleFromFile(file)),
    src: base ? `${base}/${file}` : undefined,
    // Poster = same name with a .jpg extension, if you upload one alongside.
    poster: base ? `${base}/${file.replace(/\.[^.]+$/, ".jpg")}` : undefined,
  }));
}

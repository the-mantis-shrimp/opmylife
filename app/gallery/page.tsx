import { galleryItems } from "../../lib/gallery";
import { getLang, t } from "../../lib/i18n";
import { GalleryGrid } from "./GalleryGrid";

// Re-list the bucket on each request so newly-uploaded videos appear without a
// redeploy (otherwise this page is statically prerendered at build time).
export const dynamic = "force-dynamic";

export const metadata = {
  title: "Gallery — OPmylife",
  description: "A look at the kind of beat-synced animated albums you can make.",
};

export default async function Gallery() {
  const lang = getLang();
  const items = await galleryItems();
  return (
    <div>
      <h1>{t(lang, "gallery.h1")}</h1>
      <p className="muted">{t(lang, "gallery.intro")}</p>

      <GalleryGrid items={items} />

      <p className="small muted" style={{ marginTop: 20 }}>{t(lang, "gallery.note")}</p>

      <div className="cta-band" style={{ marginTop: 28 }}>
        <h2>{t(lang, "gallery.makeOwn")}</h2>
        <a href="/dashboard" className="btn-cta">
          {t(lang, "cta.getStarted")}
        </a>
      </div>
    </div>
  );
}

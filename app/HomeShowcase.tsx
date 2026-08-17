"use client";

import { useEffect, useMemo, useState } from "react";
import type { GalleryItem } from "../lib/gallery";

const MAX_PORTRAIT = 4;
const MAX_LANDSCAPE = 2;

type Orientation = "portrait" | "landscape";

/**
 * Homepage showcase: 4 vertical videos on top, 2 horizontal below.
 *
 * Gallery items carry no orientation metadata and we can't probe remote video
 * dimensions on the server, so we detect it in the browser: load each clip's
 * metadata offscreen (cheap — header only), read videoWidth/Height, then render
 * only the chosen 4 portrait + 2 landscape as autoplaying tiles. A single grid
 * with portrait tiles spanning one column and landscape tiles spanning two lays
 * them out as 4-over-2 via normal grid flow.
 */
export function HomeShowcase({ items }: { items: GalleryItem[] }) {
  const withSrc = useMemo(() => items.filter((it): it is GalleryItem & { src: string } => !!it.src), [items]);
  const [orient, setOrient] = useState<Record<string, Orientation>>({});

  useEffect(() => {
    if (withSrc.length === 0) return;
    const probes: HTMLVideoElement[] = [];
    for (const it of withSrc) {
      const src = it.src;
      const v = document.createElement("video");
      v.preload = "metadata";
      v.muted = true;
      v.onloadedmetadata = () =>
        setOrient((o) => (o[src] ? o : { ...o, [src]: v.videoHeight > v.videoWidth ? "portrait" : "landscape" }));
      v.src = src;
      probes.push(v);
    }
    return () => {
      for (const v of probes) {
        v.removeAttribute("src");
        v.load();
      }
    };
  }, [withSrc]);

  // No bucket configured (no playable src) → gradient placeholders so the section
  // isn't empty in local/dev previews.
  if (withSrc.length === 0) {
    const ph = items.slice(0, MAX_PORTRAIT + MAX_LANDSCAPE);
    return (
      <div className="showcase">
        {ph.map((it, i) => (
          <a key={it.title} href={`/gallery#${it.slug}`} className={`op-card${i >= MAX_PORTRAIT ? " wide" : ""}`}>
            <div className={`op-poster grad-${i % 4}`}>
              <span className="op-play">▶</span>
            </div>
            <span className="op-title">{it.title}</span>
          </a>
        ))}
      </div>
    );
  }

  const portrait = withSrc.filter((it) => orient[it.src] === "portrait").slice(0, MAX_PORTRAIT);
  const landscape = withSrc.filter((it) => orient[it.src] === "landscape").slice(0, MAX_LANDSCAPE);

  return (
    <div className="showcase">
      {portrait.map((it) => (
        <Tile key={it.src} item={it} />
      ))}
      {landscape.map((it) => (
        <Tile key={it.src} item={it} wide />
      ))}
    </div>
  );
}

function Tile({ item, wide }: { item: GalleryItem & { src: string }; wide?: boolean }) {
  return (
    <a href={`/gallery#${item.slug}`} className={`op-card${wide ? " wide" : ""}`}>
      {/* preload="auto" buffers video data up front (not just the header) so the
          tile can start playing sooner. The poster shows instantly meanwhile. */}
      <video src={item.src} poster={item.poster} muted loop playsInline autoPlay preload="auto" />
      <span className="op-title">{item.title}</span>
    </a>
  );
}

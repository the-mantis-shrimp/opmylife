"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { SyntheticEvent } from "react";
import type { GalleryItem } from "../../lib/gallery";

/**
 * Click-to-play gallery. Videos don't autoplay; playing one pauses the others.
 * Portrait clips go in the standard grid; landscape (widescreen) clips get their
 * OWN wider section so they aren't shrunk into a portrait-sized cell. Orientation
 * is detected in the browser (no metadata on the items). A `#<slug>` deep link
 * (e.g. from a homepage tile) scrolls that card in and plays it.
 */
export function GalleryGrid({ items }: { items: GalleryItem[] }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [orient, setOrient] = useState<Record<string, "portrait" | "landscape">>({});

  useEffect(() => {
    const probes: HTMLVideoElement[] = [];
    for (const it of items) {
      if (!it.src) continue;
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
  }, [items]);

  function pauseOthers(e: SyntheticEvent<HTMLVideoElement>) {
    const playing = e.currentTarget;
    containerRef.current?.querySelectorAll("video").forEach((v) => {
      if (v !== playing) v.pause();
    });
  }

  useEffect(() => {
    const slug = decodeURIComponent(window.location.hash.replace(/^#/, ""));
    if (!slug) return;
    const card = document.getElementById(slug);
    if (!card) return;
    card.scrollIntoView({ behavior: "smooth", block: "center" });
    const video = card.querySelector("video");
    if (video) {
      video.muted = true;
      video.play().catch(() => {});
    }
  }, [items, orient]);

  // Landscape → its own section; everything else (portrait or not-yet-classified)
  // stays in the main grid so nothing is hidden while orientation resolves.
  const landscape = useMemo(() => items.filter((s) => s.src && orient[s.src] === "landscape"), [items, orient]);
  const portrait = useMemo(() => items.filter((s) => !(s.src && orient[s.src] === "landscape")), [items, orient]);

  const card = (s: GalleryItem, i: number) => (
    <div key={s.title} id={s.slug} className="gallery-card">
      <div className="gallery-meta">
        <strong>{s.title}</strong>
      </div>
      {s.src ? (
        <video
          className="gallery-media"
          src={s.src}
          poster={s.poster}
          controls
          playsInline
          preload="metadata"
          onPlay={pauseOthers}
        />
      ) : (
        <div className={`gallery-poster grad-${i % 4}`}>
          <span className="op-play">▶</span>
        </div>
      )}
    </div>
  );

  return (
    <div ref={containerRef}>
      <div className="gallery-grid">{portrait.map(card)}</div>
      {landscape.length > 0 && (
        <>
          <h2 className="section-title" style={{ textAlign: "left", margin: "34px 0 0" }}>
            Widescreen
          </h2>
          <div className="gallery-grid gallery-grid-wide">{landscape.map(card)}</div>
        </>
      )}
    </div>
  );
}

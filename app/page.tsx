import { auth } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";
import { SignedIn, SignedOut, SignInButton, SignUpButton } from "@clerk/nextjs";
import { env } from "../lib/env";
import { galleryItems } from "../lib/gallery";
import { getLang, t, type Lang } from "../lib/i18n";
import { HomeShowcase } from "./HomeShowcase";

// Re-read the gallery bucket + auth per request (not statically prerendered).
export const dynamic = "force-dynamic";

export const metadata = {
  title: "OPmylife — your life, animated",
  description: "Drop in your photos and a song. Get a beat-synced animated opening where you're the main character.",
};

function Cta({ lang }: { lang: Lang }) {
  if (!env.clerk.configured) {
    return (
      <a href="/dashboard" className="btn-cta">
        {t(lang, "home.getStarted")}
      </a>
    );
  }
  return (
    <>
      <SignedOut>
        <SignUpButton mode="modal">
          <button className="btn-cta">{t(lang, "home.signup")}</button>
        </SignUpButton>
        <SignInButton mode="modal">
          <button className="btn-cta ghost">{t(lang, "home.login")}</button>
        </SignInButton>
      </SignedOut>
      <SignedIn>
        <a href="/dashboard" className="btn-cta">
          {t(lang, "home.toProjects")}
        </a>
      </SignedIn>
    </>
  );
}

export default async function Home() {
  // Signed-in users skip the marketing page and go straight to their projects.
  if (env.clerk.configured && auth().userId) redirect("/dashboard");

  const lang = getLang();
  const items = (await galleryItems()).slice(0, 12);

  return (
    <div className="landing">
      <section className="hero">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src="/logo.png"
          alt="OPmylife"
          style={{ display: "block", margin: "0 auto 16px", maxWidth: 200, width: "60%", height: "auto" }}
        />
        <h1>
          {t(lang, "home.h1a")}
          <span className="grad">{t(lang, "home.h1b")}</span>.
        </h1>
        <p className="hero-sub">{t(lang, "home.sub")}</p>
        <div className="hero-cta">
          <Cta lang={lang} />
        </div>
        <p className="hero-note">{t(lang, "home.note")}</p>
      </section>

      <section>
        <div className="row spread" style={{ alignItems: "baseline" }}>
          <h2 className="section-title" style={{ margin: 0 }}>
            {t(lang, "home.sectionTitle")}
          </h2>
          <a href="/gallery" className="small">
            {t(lang, "home.seeGallery")}
          </a>
        </div>
        <HomeShowcase items={items} />
      </section>

      <section className="cta-band">
        <h2>{t(lang, "home.ctaBand")}</h2>
        <div className="hero-cta">
          <Cta lang={lang} />
        </div>
      </section>
    </div>
  );
}

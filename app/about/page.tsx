import { LEGAL } from "../../lib/legal";
import { getLang, t } from "../../lib/i18n";

export const metadata = {
  title: "About — OPmylife",
  description: "Why we built an app that turns your photos into a beat-synced animated opening.",
};

export default function About() {
  const lang = getLang();
  return (
    <div style={{ maxWidth: 720 }}>
      <h1>{t(lang, "about.about")} {LEGAL.appName}</h1>
      <p className="muted">{t(lang, "about.tagline")}</p>

      <h2>{t(lang, "about.whatH")}</h2>
      <p>{t(lang, "about.whatP")}</p>

      <h2>{t(lang, "about.opH")}</h2>
      <p>{t(lang, "about.opP")}</p>

      <h2>{t(lang, "about.aiH")}</h2>
      <p>{t(lang, "about.aiP")}</p>

      <h2>{t(lang, "about.privacyH")}</h2>
      <p>
        {t(lang, "about.privacyP")} {t(lang, "about.privacyLinks")}{" "}
        <a href="/legal/privacy">{t(lang, "footer.privacy")}</a> {t(lang, "about.and")}{" "}
        <a href="/legal/terms">{t(lang, "footer.terms")}</a>.
      </p>

      <div className="cta-band" style={{ marginTop: 28 }}>
        <h2>{t(lang, "about.ctaH")}</h2>
        <a href="/dashboard" className="btn-cta">
          {t(lang, "cta.getStarted")}
        </a>
      </div>
    </div>
  );
}

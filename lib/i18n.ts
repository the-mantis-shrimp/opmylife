/**
 * Lightweight i18n for the PUBLIC/marketing pages (server components). The chosen
 * language lives in a `lang` cookie set by the topbar toggle; server components
 * read it with getLang() and translate via t(lang, key). Falls back to English
 * for any missing key. (The app-builder screens are not yet translated — they're
 * client-heavy; this system extends to them incrementally.)
 */
import { cookies } from "next/headers";

export type Lang = "en" | "es";
export const LANGS: readonly Lang[] = ["en", "es"] as const;
export const LANG_LABELS: Record<Lang, string> = { en: "English", es: "Español" };

/** Read the selected language from the `lang` cookie (default English). */
export function getLang(): Lang {
  const v = cookies().get("lang")?.value;
  return v === "es" ? "es" : "en";
}

type Entry = { en: string; es: string };

const DICT: Record<string, Entry> = {
  // nav + footer + auth (layout)
  "nav.dashboard": { en: "Dashboard", es: "Panel" },
  "nav.gallery": { en: "Gallery", es: "Galería" },
  "nav.about": { en: "About", es: "Acerca de" },
  "footer.terms": { en: "Terms", es: "Términos" },
  "footer.privacy": { en: "Privacy", es: "Privacidad" },
  "footer.support": { en: "Support", es: "Soporte" },
  "auth.logout": { en: "Log out", es: "Cerrar sesión" },
  "auth.signin": { en: "Sign in", es: "Iniciar sesión" },

  // home
  "home.h1a": { en: "Your life, ", es: "Tu vida, " },
  "home.h1b": { en: "animated", es: "animada" },
  "home.sub": {
    en: "Drop in your photos and a song. Get a beat-synced animated OP where you're the main character.",
    es: "Sube tus fotos y una canción. Obtén una apertura animada sincronizada al ritmo donde tú eres el protagonista.",
  },
  "home.signup": { en: "Sign up free", es: "Regístrate gratis" },
  "home.login": { en: "Log in", es: "Inicia sesión" },
  "home.toProjects": { en: "Go to your projects →", es: "Ir a tus proyectos →" },
  "home.getStarted": { en: "Get started — it's free →", es: "Empieza — es gratis →" },
  "home.note": { en: "Free preview · no card required", es: "Vista previa gratis · sin tarjeta" },
  "home.sectionTitle": { en: "Albums come to life", es: "Los álbumes cobran vida" },
  "home.seeGallery": { en: "See the gallery →", es: "Ver la galería →" },
  "home.ctaBand": { en: "Ready to be the main character?", es: "¿Listo para ser el protagonista?" },

  // gallery
  "gallery.h1": { en: "Gallery", es: "Galería" },
  "gallery.intro": {
    en: "A taste of what you can make — beat-synced animated albums from your own photos and music. Press play on any one.",
    es: "Una muestra de lo que puedes crear: álbumes animados sincronizados al ritmo, hechos con tus propias fotos y música. Dale al play en cualquiera.",
  },
  "gallery.note": {
    en: "These are sample concepts. Your own renders stay private and auto-delete after 72 hours — they're never shown here.",
    es: "Estos son conceptos de ejemplo. Tus propios vídeos permanecen privados y se eliminan automáticamente tras 72 horas; nunca se muestran aquí.",
  },
  "gallery.makeOwn": { en: "Make your own", es: "Crea el tuyo" },
  "cta.getStarted": { en: "Get started →", es: "Empieza →" },

  // about
  "about.about": { en: "About", es: "Acerca de" },
  "about.tagline": { en: "Everyone deserves an opening sequence.", es: "Todos merecen una secuencia de apertura." },
  "about.whatH": { en: "What we make", es: "Lo que creamos" },
  "about.whatP": {
    en: "OPmylife turns a handful of your photos and a song into a beat-synced animated opening (OP) — the kind that plays at the start of your favorite show, except you and your friends are the cast. Upload, pick a style, and our pipeline stylizes everyone into animation, storyboards the shots, and cuts them to the beat.",
    es: "OPmylife convierte unas cuantas de tus fotos y una canción en una apertura animada (OP) sincronizada al ritmo — como la que suena al inicio de tu serie favorita, salvo que tú y tus amigos son el elenco. Sube tus fotos, elige un estilo, y nuestra tecnología los convierte a todos en animación, planifica las tomas y las corta al ritmo.",
  },
  "about.opH": { en: "What's an OP?", es: "¿Qué es un OP?" },
  "about.opP": {
    en: "“OP” is short for opening — the stylized title sequence that plays at the start of an episode. Anime made the format iconic: 60–90 seconds of fast, punchy shots of the cast, cut precisely to a theme song, made to hype you up before the story begins. We make you one of your own, starring you and the people you love.",
    es: "“OP” es la abreviatura de opening (apertura): la secuencia de títulos estilizada que suena al inicio de un episodio. El anime hizo icónico el formato: 60–90 segundos de tomas rápidas y contundentes del elenco, cortadas con precisión a una canción, hechas para emocionarte antes de que empiece la historia. Te hacemos una propia, protagonizada por ti y las personas que quieres.",
  },
  "about.aiH": { en: "On AI & animation", es: "Sobre la IA y la animación" },
  "about.aiP": {
    en: "We love animation and the artists who make it — and we're not here to replace them. A hand-crafted opening from a real studio is a work of art, and nothing we generate competes with that. But the honest truth is that kind of work is expensive and out of reach for almost everyone. OPmylife uses AI to make the fun part — seeing you and your friends as the cast of your own opening — available to everyone, not just people who can commission a studio. Think of it as a party trick and a keepsake, not a replacement for the real craft.",
    es: "Amamos la animación y a los artistas que la crean — y no estamos aquí para reemplazarlos. Una apertura hecha a mano por un estudio real es una obra de arte, y nada de lo que generamos compite con eso. Pero la verdad es que ese tipo de trabajo es caro y está fuera del alcance de casi todos. OPmylife usa IA para que la parte divertida — verte a ti y a tus amigos como el elenco de tu propia apertura — esté al alcance de todos, no solo de quienes pueden contratar un estudio. Piénsalo como un truco de fiesta y un recuerdo, no como un sustituto del oficio real.",
  },
  "about.privacyH": { en: "Your content, your call", es: "Tu contenido, tu decisión" },
  "about.privacyP": {
    en: "Privacy is built into the product, not bolted on. Face grouping only happens with your explicit, separate consent — otherwise you tag people yourself and no face processing occurs. Your photos and videos are encrypted at rest and auto-deleted about 72 hours after a render, on a server-side schedule. We're not end-to-end encrypted (your content has to reach the AI providers to be processed), and we're upfront about that.",
    es: "La privacidad viene integrada en el producto, no añadida a última hora. El agrupamiento de rostros solo ocurre con tu consentimiento explícito y por separado; de lo contrario, tú etiquetas a las personas y no se procesa ningún rostro. Tus fotos y vídeos se cifran en reposo y se eliminan automáticamente unas 72 horas después de un render, según un calendario del lado del servidor. No usamos cifrado de extremo a extremo (tu contenido debe llegar a los proveedores de IA para procesarse), y lo decimos con claridad.",
  },
  "about.privacyLinks": { en: "See our", es: "Consulta nuestra" },
  "about.and": { en: "and", es: "y" },
  "about.ctaH": { en: "Be the main character", es: "Sé el protagonista" },
};

/** Translate a key for the given language (English fallback). */
export function t(lang: Lang, key: string): string {
  const e = DICT[key];
  if (!e) return key;
  return e[lang] ?? e.en;
}

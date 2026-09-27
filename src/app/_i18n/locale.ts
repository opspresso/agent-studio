/**
 * Supported languages and request negotiation. Locale is a cookie preference,
 * preserving the route tree and sign-in paths. Both server resolution and the
 * browser toggle use this dependency-free contract.
 */
import { parseList } from "@/shared/parseList";

export const LOCALES = ["en", "ko"] as const;

export type Locale = (typeof LOCALES)[number];

/**
 * What a reader gets before they have chosen, and the fallback for a cookie
 * that no longer parses. English rather than the browser's preference as the
 * *final* answer: `negotiateLocale` still reads `Accept-Language` first, and
 * this is only what is left when it matches nothing.
 */
export const DEFAULT_LOCALE: Locale = "en";

/** Namespaced like the session cookie so a shared dev host cannot collide. */
export const LOCALE_COOKIE = "agent-studio-locale";

/** A year — the choice is a preference, not a session fact. */
export const LOCALE_COOKIE_MAX_AGE = 60 * 60 * 24 * 365;

export function isLocale(value: string | undefined | null): value is Locale {
  return value !== undefined && value !== null && (LOCALES as readonly string[]).includes(value);
}

/**
 * The first supported language an `Accept-Language` header asks for, by
 * descending `q`.
 *
 * Only the primary subtag is compared, so `ko-KR` matches `ko`. Quality values
 * are parsed rather than assumed ordered: browsers do send them in order, but a
 * proxy that rewrites the header is not obliged to, and reading the numbers is
 * cheaper than discovering it did not.
 *
 * The comma split is `parseList`'s, which owns it — its lowercasing is right
 * here too, since a language tag is case-insensitive by definition.
 */
export function negotiateLocale(header: string | null | undefined): Locale {
  if (!header) {
    return DEFAULT_LOCALE;
  }

  const ranked = parseList(header)
    .map((entry) => {
      const [range = "", ...params] = entry.split(";");
      const q = params
        .map((param) => /^\s*q=([0-9.]+)\s*$/.exec(param.trim()))
        .find((match) => match !== null);
      return { tag: range.trim().split("-")[0] ?? "", q: q ? Number(q[1]) : 1 };
    })
    .filter((entry) => entry.tag !== "" && Number.isFinite(entry.q) && entry.q > 0)
    .sort((a, b) => b.q - a.q);

  for (const entry of ranked) {
    if (isLocale(entry.tag)) {
      return entry.tag;
    }
  }
  return DEFAULT_LOCALE;
}

/** What the toggle shows for each language — in that language, as is customary. */
export const LOCALE_LABELS: Record<Locale, string> = {
  en: "English",
  ko: "한국어",
};

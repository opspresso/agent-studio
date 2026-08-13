"use client";

/**
 * The active language, handed to the client tree by the root layout.
 *
 * Only the locale crosses the boundary — the catalogues are imported on both
 * sides (`translate.ts` says why), so this provider carries a two-character
 * string rather than 500 messages.
 *
 * There is no loading state and no mismatch to avoid: the server resolved the
 * cookie before rendering, so the first client render already agrees with the
 * HTML. That is the difference between this and `ThemeToggle`, whose preference
 * lives only in `localStorage` and has to wait for mount.
 */
import { createContext, useContext, useMemo } from "react";
import { DEFAULT_LOCALE, type Locale } from "./locale";
import { translator, type Translate } from "./translate";

const LocaleContext = createContext<Locale>(DEFAULT_LOCALE);

export function I18nProvider({
  locale,
  children,
}: {
  locale: Locale;
  children: React.ReactNode;
}) {
  return <LocaleContext.Provider value={locale}>{children}</LocaleContext.Provider>;
}

/** The active language — for the toggle, and for date and number formatting. */
export function useLocale(): Locale {
  return useContext(LocaleContext);
}

/**
 * `const t = useT()` — the translate function for the active language.
 *
 * Memoised on the locale so a component that lists `t` in a dependency array
 * does not re-run its effect on every render.
 */
export function useT(): Translate {
  const locale = useLocale();
  return useMemo(() => translator(locale), [locale]);
}

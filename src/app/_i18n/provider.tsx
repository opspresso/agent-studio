"use client";

/**
 * The root layout supplies the resolved locale and service name before render,
 * keeping initial server and client copy aligned. Catalogues stay in the shared
 * translator; only these settings cross the server/client boundary.
 */
import { createContext, useContext, useMemo } from "react";
import { DEFAULT_LOCALE, type Locale } from "./locale";
import { DEFAULT_SERVICE_NAME } from "@/shared/branding";
import { translator, type Translate } from "./translate";

const I18nContext = createContext({ locale: DEFAULT_LOCALE as Locale, serviceName: DEFAULT_SERVICE_NAME });

export function I18nProvider({
  locale,
  serviceName = DEFAULT_SERVICE_NAME,
  children,
}: {
  locale: Locale;
  serviceName?: string;
  children: React.ReactNode;
}) {
  return <I18nContext.Provider value={{ locale, serviceName }}>{children}</I18nContext.Provider>;
}

/** The active language — for the toggle, and for date and number formatting. */
export function useLocale(): Locale {
  return useContext(I18nContext).locale;
}

/**
 * `const t = useT()` — the translate function for the active language.
 *
 * Memoised on the locale so a component that lists `t` in a dependency array
 * does not re-run its effect on every render.
 */
export function useT(): Translate {
  const { locale, serviceName } = useContext(I18nContext);
  return useMemo(() => translator(locale, serviceName), [locale, serviceName]);
}

/**
 * Resolving the request's language on the server.
 *
 * Split from `translate.ts` because this is the only file in `_i18n` that
 * imports `next/headers`, and a client component that imported it would fail at
 * build time rather than at the layer test. The catalogue, the translator and
 * the locale type stay importable from anywhere.
 *
 * Reading `headers()` opts the tree into dynamic rendering. That costs nothing
 * here: the root layout already resolves a per-viewer session, so no route in
 * this console was prerendered to begin with (see `src/app/layout.tsx`).
 */
import { cookies, headers } from "next/headers";
import { isLocale, negotiateLocale, LOCALE_COOKIE, type Locale } from "./locale";
import { translator, type Translate } from "./translate";
import { getServiceBranding } from "@/lib/runtime-settings";

/**
 * The cookie if it names a language we speak, otherwise what the browser asked
 * for, otherwise English.
 *
 * The order matters: an explicit choice outranks `Accept-Language` forever,
 * which is what makes the toggle feel like a setting rather than a hint that
 * the next browser update can overrule.
 */
export async function resolveLocale(): Promise<Locale> {
  const stored = (await cookies()).get(LOCALE_COOKIE)?.value;
  if (isLocale(stored)) {
    return stored;
  }
  return negotiateLocale((await headers()).get("accept-language"));
}

/** `const t = await getT()` — the translator, for a server component. */
export async function getT(): Promise<Translate> {
  return translator(await resolveLocale(), (await getServiceBranding()).name);
}

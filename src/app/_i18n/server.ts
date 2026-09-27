/**
 * Server-only locale resolution. Keep next/headers here so clients can import
 * the pure translator and locale contracts without server dependencies.
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

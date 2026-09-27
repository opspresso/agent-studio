/**
 * Shared server/client translation and interpolation. Both catalogues are
 * statically imported; the root passes locale and branding rather than
 * serializing message data for each page.
 */
import type { Locale } from "./locale";
import { DEFAULT_SERVICE_NAME } from "@/shared/branding";
import { en, type MessageKey, type Messages } from "./messages/en";
import { ko } from "./messages/ko";

const CATALOGUES: Record<Locale, Messages> = { en, ko };

/** Values a message can interpolate. Dates and money arrive pre-formatted. */
export type MessageVars = Record<string, string | number>;

/**
 * `Hello {name}` + `{ name: "Bruce" }` → `Hello Bruce`.
 *
 * An unfilled placeholder is left as written rather than replaced with an empty
 * string: `{count} runs` reaching a page as `{count} runs` is a visible bug
 * report, and as ` runs` it is a sentence that looks finished and is wrong.
 */
function interpolate(template: string, vars: MessageVars | undefined): string {
  if (vars === undefined) {
    return template;
  }
  return template.replace(/\{(\w+)\}/g, (whole, name: string) =>
    name in vars ? String(vars[name]) : whole,
  );
}

export type Translate = (key: MessageKey, vars?: MessageVars) => string;

/**
 * The translator for one language.
 *
 * A missing key falls back to English rather than rendering the key itself,
 * which only matters for a catalogue edited by hand between releases — the
 * types make it unreachable through the compiler.
 */
export function translator(locale: Locale, serviceName = DEFAULT_SERVICE_NAME): Translate {
  const catalogue = CATALOGUES[locale];
  return (key, vars) => interpolate(catalogue[key] ?? en[key], { serviceName, ...vars });
}

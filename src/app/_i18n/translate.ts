/**
 * Turning a key into the string a reader sees.
 *
 * A plain function rather than a hook, because a server component cannot call a
 * hook and five pages plus the root layout are server components. `provider.tsx`
 * wraps this for the client; `server.ts` calls it directly. One implementation
 * either way, so the two sides cannot drift on how a placeholder is filled.
 *
 * Both catalogues are imported statically, which puts roughly 10KB gzipped of
 * the other language in the browser bundle. The alternative — shipping only the
 * active one — means serialising the catalogue through the server component
 * boundary on every navigation, and this console has two languages, not twenty.
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

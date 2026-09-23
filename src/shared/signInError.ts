/**
 * Why a sign-in was refused, as it travels from `lib/auth.ts` to `/login`.
 *
 * Better Auth carries a refusal to the browser as a query parameter built from
 * the thrown error's *message*: the OAuth callback lifts it into `result.error`
 * and joins its words with underscores. The message is therefore a wire format
 * rather than prose. A sentence written there lands in the address bar and can
 * expose deployment policy to the person who was rejected.
 *
 * So the wire carries a code with no spaces in it, and the words a person reads
 * are chosen here instead of sent.
 */
import { DEFAULT_SERVICE_NAME } from "./branding";

export const EMAIL_DOMAIN_NOT_ALLOWED = "EMAIL_DOMAIN_NOT_ALLOWED";

const MESSAGES: Record<string, string> = {
  [EMAIL_DOMAIN_NOT_ALLOWED]:
    "Your account isn't allowed to access {serviceName}. Contact your administrator if you think this is a mistake.",
};

/**
 * Everything else. Deliberately says nothing about the deployment: the codes
 * Better Auth raises on its own (a cancelled consent screen, a stale callback)
 * differ in ways only a server log can act on.
 */
const GENERIC =
  "Sign-in did not complete. Try again, or contact your administrator if it keeps happening.";

/**
 * Directory provider identities shared by server registration and sign-in
 * buttons. The client cannot import the server auth module.
 */
export const OIDC_PROVIDER_ID = "oidc";
export const KEYCLOAK_PROVIDER_ID = "keycloak";

/**
 * Copy for the `error` parameter `/login` was handed, or `undefined` when there
 * is nothing to report.
 *
 * An unrecognised value collapses to one generic line **rather than being
 * echoed**. The parameter is server text, and a deployment redirected before
 * this mapping existed can still send a whole sentence naming its domains —
 * rendering it back is the disclosure the code above exists to prevent.
 */
export function signInErrorMessage(code: string | undefined, serviceName = DEFAULT_SERVICE_NAME): string | undefined {
  if (!code) {
    return undefined;
  }
  // Own keys only: `?error=constructor` would otherwise find
  // `Object.prototype.constructor` and print a function's source where the
  // generic line belongs — the address bar is where this value comes from.
  const message = Object.hasOwn(MESSAGES, code) ? MESSAGES[code] : undefined;
  return message?.replace("{serviceName}", serviceName) ?? GENERIC;
}

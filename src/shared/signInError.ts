/**
 * Why a sign-in was refused, as it travels from `lib/auth.ts` to `/login`.
 *
 * Better Auth carries a refusal to the browser as a query parameter built from
 * the thrown error's *message*: the OAuth callback lifts it into `result.error`
 * and joins its words with underscores. The message is therefore a wire format
 * rather than prose — a sentence written there lands in the address bar, which
 * is how the deployment's allowed-domain list used to reach whoever had just
 * been turned away.
 *
 * So the wire carries a code with no spaces in it, and the words a person reads
 * are chosen here instead of sent.
 */
export const EMAIL_DOMAIN_NOT_ALLOWED = "EMAIL_DOMAIN_NOT_ALLOWED";

const MESSAGES: Record<string, string> = {
  [EMAIL_DOMAIN_NOT_ALLOWED]:
    "Your Google account isn't allowed to access AgentDure. Contact your administrator if you think this is a mistake.",
};

/**
 * Everything else. Deliberately says nothing about the deployment: the codes
 * Better Auth raises on its own (a cancelled consent screen, a stale callback)
 * differ in ways only a server log can act on.
 */
const GENERIC =
  "Sign-in did not complete. Try again, or contact your administrator if it keeps happening.";

/**
 * Copy for the `error` parameter `/login` was handed, or `undefined` when there
 * is nothing to report.
 *
 * An unrecognised value collapses to one generic line **rather than being
 * echoed**. The parameter is server text, and a deployment redirected before
 * this mapping existed can still send a whole sentence naming its domains —
 * rendering it back is the disclosure the code above exists to prevent.
 */
export function signInErrorMessage(code: string | undefined): string | undefined {
  if (!code) {
    return undefined;
  }
  return MESSAGES[code] ?? GENERIC;
}

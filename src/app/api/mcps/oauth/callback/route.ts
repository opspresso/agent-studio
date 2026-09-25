import { mcpAuthUseCases } from "@/lib/container";
import { withAuth } from "@/lib/session";
import { AppError } from "@/application/errors";

type CallbackOutcome = { ok: true; agent: string; server: string } | { ok: false; error: string };

/**
 * A small self-closing page rather than JSON: the authorization server redirects
 * the *browser* here, so whoever lands on it is a person, not the console's
 * fetch. It reports back to the opener and closes, leaving the console to
 * refresh — and still reads sensibly if it was opened in a plain tab.
 */
function resultPage(outcome: CallbackOutcome): Response {
  const message = outcome.ok
    ? `Connected ${outcome.server} to ${outcome.agent}. You can close this window.`
    : `Connection failed: ${outcome.error}`;
  const body = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>MCP authorization</title></head>
<body style="font:14px system-ui;padding:2rem;color:#333">
<p>${escapeHtml(message)}</p>
<script>
  try { window.opener && window.opener.postMessage(${scriptJson(outcome)}, window.location.origin); } catch (e) {}
  if (window.opener) { setTimeout(function () { window.close(); }, 1200); }
</script>
</body></html>`;
  return new Response(body, {
    // 200 either way: the status describes serving this page, and the browser
    // shows the body regardless. The outcome is in the message and the postMessage.
    status: 200,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      // Nothing here should be cached — it carries a one-time result.
      "Cache-Control": "no-store",
    },
  });
}

/**
 * The outcome as a JS string literal that cannot end the `<script>` carrying it.
 *
 * `JSON.stringify` escapes nothing HTML cares about: `</script>` survives it
 * intact, and an HTML parser ends the element right there — everything after it
 * is markup, chosen by whoever wrote the string. And this string is the
 * authorization server's: `abandonAuthorization` relays `error_description`
 * verbatim once the redirect is attributable, which is the whole point of
 * attributing it.
 *
 * The `<p>` above has been escaped since this file was written, so the value was
 * known to be untrusted; one value reached two sinks and only one of them was
 * defended. Escaping `<` covers the closing tag and any `<!--` the parser would
 * otherwise treat as a comment; U+2028/2029 go with it because JSON leaves them
 * bare and a script parser reads them as line terminators.
 *
 * The escapes decode back to the same characters at runtime, so the message the
 * opener receives is unchanged.
 */
export function scriptJson(outcome: CallbackOutcome): string {
  return JSON.stringify(JSON.stringify(outcome))
    .replaceAll("<", "\\u003c")
    .replaceAll("\u2028", "\\u2028")
    .replaceAll("\u2029", "\\u2029");
}

function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (char) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char] ?? char,
  );
}

/**
 * The authorization server's redirect target.
 *
 * `withAuth` is what makes the identity check possible: the browser arrives with
 * its session cookie, so the user who started the flow can be compared to the
 * one finishing it.
 */
export const GET = withAuth(async (user, request: Request) => {
  const url = new URL(request.url);
  const state = url.searchParams.get("state");
  const code = url.searchParams.get("code");
  const providerError = url.searchParams.get("error");
  // RFC 9207. Read from the query exactly as it arrived: the comparison this
  // feeds is a literal one, so any tidying here would defeat it.
  const iss = url.searchParams.get("iss") ?? undefined;

  if (providerError) {
    if (!state) {
      // Nothing ties this to an authorization this app started, so there is
      // nothing to attribute the provider's text to — and a redirect anyone can
      // craft must not get to put words on this page.
      return resultPage({ ok: false, error: "The provider's redirect was missing state." });
    }
    try {
      const { error } = await mcpAuthUseCases.abandonAuthorization({
        state,
        userEmail: user.email,
        error: providerError,
        errorDescription: url.searchParams.get("error_description") ?? undefined,
        iss,
      });
      return resultPage({ ok: false, error });
    } catch (error) {
      return resultPage({
        ok: false,
        error:
          error instanceof AppError ? error.message : "The authorization could not be completed.",
      });
    }
  }
  if (!state || !code) {
    return resultPage({ ok: false, error: "The provider's redirect was missing state or code." });
  }
  try {
    const { agentName, serverName } = await mcpAuthUseCases.completeAuthorization({
      state,
      code,
      userEmail: user.email,
      iss,
    });
    return resultPage({ ok: true, agent: agentName, server: serverName });
  } catch (error) {
    // Message only — an AppError here is a rejected state, a lost ownership or
    // an issuer that did not match, all of which the person in front of the
    // browser needs to read.
    return resultPage({
      ok: false,
      error: error instanceof AppError ? error.message : "The authorization could not be completed.",
    });
  }
});

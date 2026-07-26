import { mcpAuthUseCases } from "@/lib/container";
import { withAuth } from "@/lib/session";
import { AppError } from "@/application/errors";

type CallbackOutcome = { ok: true; project: string; server: string } | { ok: false; error: string };

/**
 * A small self-closing page rather than JSON: the authorization server redirects
 * the *browser* here, so whoever lands on it is a person, not the console's
 * fetch. It reports back to the opener and closes, leaving the console to
 * refresh — and still reads sensibly if it was opened in a plain tab.
 */
function resultPage(outcome: CallbackOutcome): Response {
  const message = outcome.ok
    ? `Connected ${outcome.server} to ${outcome.project}. You can close this window.`
    : `Connection failed: ${outcome.error}`;
  const body = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>MCP authorization</title></head>
<body style="font:14px system-ui;padding:2rem;color:#333">
<p>${escapeHtml(message)}</p>
<script>
  try { window.opener && window.opener.postMessage(${JSON.stringify(JSON.stringify(outcome))}, window.location.origin); } catch (e) {}
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

  if (providerError) {
    const description = url.searchParams.get("error_description");
    return resultPage({ ok: false, error: description ?? providerError });
  }
  if (!state || !code) {
    return resultPage({ ok: false, error: "The provider's redirect was missing state or code." });
  }
  try {
    const { projectName, serverName } = await mcpAuthUseCases.completeAuthorization({
      state,
      code,
      userEmail: user.email,
    });
    return resultPage({ ok: true, project: projectName, server: serverName });
  } catch (error) {
    // Message only — an AppError here is a rejected state or a lost ownership,
    // both of which the person in front of the browser needs to read.
    return resultPage({
      ok: false,
      error: error instanceof AppError ? error.message : "The authorization could not be completed.",
    });
  }
});

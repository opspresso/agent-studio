import { ValidationError } from "@/application/errors";
import type { InlineView } from "@/domain/artifact/types";
import { withAuth } from "@/lib/session";
import { artifactUseCases } from "@/lib/container";
import { apiError } from "@/app/api/_lib/http";
import { viewPage } from "./_lib/viewPage";

type RouteContext = { params: Promise<{ artifactId: string }> };

/**
 * The sandbox an artifact runs in.
 *
 * `sandbox` is the whole point of serving this here rather than signing an
 * object URL: it puts the document on an opaque origin, so the page cannot read
 * this app's cookies, storage or DOM — and unlike an iframe's `sandbox`
 * attribute it holds when the same address is opened as a top-level tab, which
 * is the case an attribute cannot reach.
 *
 * `default-src 'none'` then means the page loads nothing from anywhere.
 * Everything it needs is in the file — which is what the skill that writes
 * these is told, so this header is the rule being enforced rather than assumed.
 * A remote image is refused with everything else, and that is not an oversight:
 * a picture fetched from an address the model chose reports to that host that
 * the page was opened, and by whom.
 *
 * **What none of this stops is the HTML view leaving.** A sandboxed *top-level*
 * document may navigate itself — the sandbox flags do not apply when the source
 * and target browsing context are the same, and CSP has no shipping directive
 * that restricts it — so a script this page runs can set `location` and take
 * the document's own text with it. That is inherent to running the author's
 * script at all, and the author is a model (which can be prompt-injected) or
 * whichever MCP server returned the bytes. Only the *containment* is claimed
 * here: the page cannot reach the console's cookies, storage or DOM, and
 * cannot load a subresource. Do not write down that it cannot call out.
 */
const BASE_POLICY = [
  "default-src 'none'",
  "style-src 'unsafe-inline'",
  "img-src data:",
  "font-src data:",
  "form-action 'none'",
  "base-uri 'none'",
  // Only this app may frame it. The sandbox already denies a framing page
  // anything to read — an opaque origin has nothing it shares — so this is
  // about the page being *presented* as something it is not, and `'self'`
  // rather than `'none'` because the same address is what an in-console
  // preview would embed.
  "frame-ancestors 'self'",
];

/**
 * One kind is granted scripts and the rest are not, and the line is real rather
 * than tidy.
 *
 * An HTML artifact is served as it was written, so it gets `allow-scripts`: a
 * report's table sorting and scroll-spy are the reason anyone opens it rather
 * than downloading it, and an opaque origin is what makes granting that cheap.
 * Every other kind is a page *this app built* from the bytes — Markdown through
 * a renderer that turns raw HTML into text, a CSV into a table, an SVG into an
 * `<img>` that by specification runs nothing. None of them has a script to run,
 * so none is given the grant. That puts the guarantee in the browser rather
 * than in a renderer's escaping continuing to behave on the next bump.
 */
function sandboxPolicy(view: InlineView): string {
  return view === "html"
    ? ["sandbox allow-scripts", ...BASE_POLICY, "script-src 'unsafe-inline'"].join("; ")
    : ["sandbox", ...BASE_POLICY].join("; ");
}

/**
 * What every response from this route carries, whatever its status.
 *
 * `next.config.ts` no longer covers this address — it had to stop, because a
 * header declared there replaces the one a route sets and the sandbox was
 * being replaced. The cost of that exclusion is that **nothing else puts these
 * back**, and only the success path was setting them: a 401, the 404 when no
 * storage is configured, and every `apiError` left with no `nosniff` and no
 * framing rule at all, on bodies that interpolate a model's or an MCP server's
 * own strings.
 */
const BASE_HEADERS = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
} as const;

/** The console's framing rule, for the responses that are not the artifact. */
const ERROR_HEADERS = {
  ...BASE_HEADERS,
  "Content-Security-Policy": "frame-ancestors 'none'",
  "X-Frame-Options": "DENY",
} as const;

/** An error response with the headers the config rule used to add. */
function withErrorHeaders(response: Response): Response {
  for (const [key, value] of Object.entries(ERROR_HEADERS)) {
    response.headers.set(key, value);
  }
  return response;
}

/**
 * The type this response is served as.
 *
 * `text/html` in every case — a rendered kind became a page, and the one kind
 * served as it was written is HTML already. The charset is said rather than
 * left to the document, because a browser given a bare `text/html` falls back
 * to a `<meta>` or to a locale guess, which is how Korean text arrives as
 * mojibake. A stored mime that names its own charset keeps it: `isInlineViewable`
 * admits `text/html; charset=euc-kr` on purpose, and answering that row with
 * `utf-8` would guarantee the mojibake the header is here to prevent. Only a
 * well-formed token is passed through — the value comes from an MCP server.
 */
function contentType(mimeType: string, view: InlineView): string {
  if (view !== "html") {
    return "text/html; charset=utf-8";
  }
  const declared = /;\s*charset\s*=\s*"?([A-Za-z0-9._-]+)"?/.exec(mimeType)?.[1];
  return `text/html; charset=${declared ?? "utf-8"}`;
}

/**
 * Render one artifact in a browser.
 *
 * The only route that answers with an artifact's bytes instead of an address.
 * Reading is what a signed URL is for and this is not a second way to do it:
 * `readForView` refuses anything but the kinds worth a sandbox, so what comes
 * back here is a page, and the headers below are the terms it runs under.
 *
 * `nosniff` matters more than usual: without it a browser may sniff bytes we
 * declared as text into something else, and the whole safety argument is
 * written against the type we said it was.
 */
const handler = withAuth(async (user, _request: Request, ctx: RouteContext) => {
  if (!artifactUseCases) {
    return Response.json({ error: "Artifact storage is not configured" }, { status: 404 });
  }
  const { artifactId } = await ctx.params;
  try {
    const { artifact, bytes, view } = await artifactUseCases.readForView(artifactId, user.email);
    let body: BodyInit;
    if (view === "html") {
      body = bytes as BodyInit;
    } else {
      const page = viewPage(view, bytes, artifact.filename);
      if (page === null) {
        throw new ValidationError(`${artifact.filename ?? "That file"} is not readable as text`);
      }
      body = page;
    }
    return new Response(body, {
      headers: {
        "Content-Type": contentType(artifact.mimeType, view),
        "Content-Security-Policy": sandboxPolicy(view),
        ...BASE_HEADERS,
        // Not `immutable` like the object itself: this response carries one
        // reader's permission, and a shared cache holding it would answer the
        // next reader with it.
        "Cache-Control": "private, no-store",
      },
    });
  } catch (error) {
    return apiError(error);
  }
});

/**
 * The headers are put on every answer here, not on each `return`.
 *
 * The 401 is the reason: it comes from `withAuth`, above this handler, so no
 * amount of care inside it reaches that response. Anything that is not the
 * artifact gets the console's rule; the artifact keeps the sandbox it set.
 */
export const GET = async (request: Request, ctx: RouteContext): Promise<Response> => {
  const response = await handler(request, ctx);
  return response.status === 200 ? response : withErrorHeaders(response);
};

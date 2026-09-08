import { ValidationError } from "@/application/errors";
import { withAuth } from "@/lib/session";
import { artifactUseCases } from "@/lib/container";
import { apiError } from "@/app/api/_lib/http";
import { viewPage } from "./_lib/viewPage";
import { ARTIFACT_VIEW_POLICY, INTERACTIVE_HTML_VIEW_POLICY, ARTIFACT_VIEW_PERMISSIONS } from "./_lib/htmlSafety";
import { interactiveHtml } from "./_lib/interactiveHtml";
import { getT } from "@/app/_i18n/server";

type RouteContext = { params: Promise<{ artifactId: string }> };

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

/** An error response with the same headers as the console framing rule. */
function withErrorHeaders(response: Response): Response {
  for (const [key, value] of Object.entries(ERROR_HEADERS)) {
    response.headers.set(key, value);
  }
  return response;
}

/**
 * The type this response is served as.
 *
 * Every kind is now a UTF-8 page. Stored HTML is decoded from its declared
 * charset before isolating, and every other view is built from validated
 * UTF-8 text. Saying the charset keeps Korean text independent of browser
 * guesses or a removed `<meta>` element.
 */
const CONTENT_TYPE = "text/html; charset=utf-8";

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
    let body: BodyInit | null;
    if (view === "html") {
      body = interactiveHtml(bytes, artifact.mimeType, artifact.filename, await getT());
    } else {
      body = viewPage(view, bytes, artifact.filename);
    }
    if (body === null) {
      throw new ValidationError(`${artifact.filename ?? "That file"} is not readable as text`);
    }
    return new Response(body, {
      headers: {
        "Content-Type": CONTENT_TYPE,
        "Content-Security-Policy": view === "html" ? INTERACTIVE_HTML_VIEW_POLICY : ARTIFACT_VIEW_POLICY,
        "Permissions-Policy": ARTIFACT_VIEW_PERMISSIONS,
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

import { ValidationError } from "@/application/errors";
import { withAuth } from "@/lib/session";
import { artifactUseCases } from "@/lib/container";
import { apiError } from "@/app/api/_lib/http";
import { viewPage } from "./_lib/viewPage";
import { ARTIFACT_VIEW_POLICY, INTERACTIVE_HTML_VIEW_POLICY, ARTIFACT_VIEW_PERMISSIONS } from "./_lib/htmlSafety";
import { interactiveHtml } from "./_lib/interactiveHtml";
import { getT } from "@/app/_i18n/server";

type RouteContext = { params: Promise<{ artifactId: string }> };

/** The route owns these headers because next.config.ts excludes artifact views. */
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

/** The generated response is UTF-8 even when stored HTML uses another charset. */
const CONTENT_TYPE = "text/html; charset=utf-8";

/** Render supported artifacts after a session permission check; nosniff preserves the declared type. */
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
        // Every request must recheck the reader's permission.
        "Cache-Control": "private, no-store",
      },
    });
  } catch (error) {
    return apiError(error);
  }
});

/** Cover auth and error responses too; successful views keep their own sandbox policy. */
export const GET = async (request: Request, ctx: RouteContext): Promise<Response> => {
  const response = await handler(request, ctx);
  return response.status === 200 ? response : withErrorHeaders(response);
};

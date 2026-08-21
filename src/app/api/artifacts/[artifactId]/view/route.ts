import { ValidationError } from "@/application/errors";
import type { InlineView } from "@/domain/artifact/types";
import { withAuth } from "@/lib/session";
import { artifactUseCases } from "@/lib/container";
import { apiError } from "@/app/api/_lib/http";
import { markdownPage } from "./_lib/markdownPage";

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
 * `default-src 'none'` then means the page cannot call home. Everything it
 * needs is in the file — which is what the skill that writes these is told, so
 * this header is the rule being enforced rather than assumed. A remote image is
 * refused with everything else, and that is not an oversight: a picture fetched
 * from an address the model chose reports to that host that the page was
 * opened, and by whom.
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
 * The two views are not held to the same policy, and the difference is real
 * rather than tidy.
 *
 * An HTML artifact is served as it was written, so it gets `allow-scripts`: a
 * report's table sorting and scroll-spy are the reason anyone opens it rather
 * than downloading it, and an opaque origin is what makes granting that cheap.
 * A Markdown artifact is *rendered here* by a renderer that turns raw HTML into
 * text — it has no script to run, so it is refused the grant. That puts the
 * guarantee in the browser rather than in the renderer's escaping continuing to
 * behave on the next dependency bump.
 */
function sandboxPolicy(view: InlineView): string {
  return view === "html"
    ? ["sandbox allow-scripts", ...BASE_POLICY, "script-src 'unsafe-inline'"].join("; ")
    : ["sandbox", ...BASE_POLICY].join("; ");
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
export const GET = withAuth(async (user, _request: Request, ctx: RouteContext) => {
  if (!artifactUseCases) {
    return Response.json({ error: "Artifact storage is not configured" }, { status: 404 });
  }
  const { artifactId } = await ctx.params;
  try {
    const { artifact, bytes, view } = await artifactUseCases.readForView(artifactId, user.email);
    let body: BodyInit;
    if (view === "markdown") {
      const page = markdownPage(bytes, artifact.filename);
      if (page === null) {
        throw new ValidationError(`${artifact.filename ?? "That file"} is not readable as text`);
      }
      body = page;
    } else {
      body = bytes as BodyInit;
    }
    return new Response(body, {
      headers: {
        // A constant, not the row's mime. This route answers with HTML in both
        // cases — Markdown because it was rendered into a page, HTML because
        // that is what it was — so nothing about the response type is read back
        // off a stored string that may carry a charset of its own. Saying the
        // charset is what settles it: a browser handed a bare `text/html` falls
        // back to the document's `<meta>`, or to a locale guess when it has
        // none, which is how Korean text arrives as mojibake.
        "Content-Type": "text/html; charset=utf-8",
        "Content-Security-Policy": sandboxPolicy(view),
        "X-Content-Type-Options": "nosniff",
        "Referrer-Policy": "no-referrer",
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

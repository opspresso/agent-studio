import { baseMimeType } from "@/domain/artifact/types";
import { withAuth } from "@/lib/session";
import { artifactUseCases } from "@/lib/container";
import { apiError } from "@/app/api/_lib/http";

type RouteContext = { params: Promise<{ artifactId: string }> };

/**
 * The sandbox an artifact's markup runs in.
 *
 * `sandbox` is the whole point of serving this here rather than signing an
 * object URL: it puts the document on an opaque origin, so the page cannot read
 * this app's cookies, storage or DOM — and unlike an iframe's `sandbox`
 * attribute it holds when the same address is opened as a top-level tab, which
 * is the case an attribute cannot reach. `allow-scripts` is granted because a
 * report's table sorting and scroll-spy are the reason anyone views it rather
 * than downloading it; an opaque origin is what makes granting it cheap.
 *
 * `default-src 'none'` then means the page cannot call home. Everything it
 * needs is in the file — which is what the skill that writes these is told, so
 * this header is the rule being enforced rather than assumed.
 */
const SANDBOX_POLICY = [
  "sandbox allow-scripts",
  "default-src 'none'",
  "style-src 'unsafe-inline'",
  "script-src 'unsafe-inline'",
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
].join("; ");

/**
 * Render one artifact in a browser.
 *
 * The only route that answers with an artifact's bytes instead of an address.
 * Reading is what a signed URL is for and this is not a second way to do it:
 * `readForView` refuses anything but the types worth a sandbox, so what comes
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
    const { artifact, bytes } = await artifactUseCases.readForView(artifactId, user.email);
    return new Response(bytes as BodyInit, {
      headers: {
        // The *base* type, not the stored string: a row written by an MCP tool
        // may carry a charset of its own, and `text/html; charset=euc-kr;
        // charset=utf-8` is read by the first one — which is Korean text
        // arriving as mojibake through the header meant to prevent it. A
        // browser handed a bare `text/html` falls back to the document's own
        // `<meta>`, or to a locale guess when it has none, so saying it here
        // is what settles it.
        "Content-Type": `${baseMimeType(artifact.mimeType)}; charset=utf-8`,
        "Content-Security-Policy": SANDBOX_POLICY,
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

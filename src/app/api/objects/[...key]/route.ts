import { ObjectNotFoundError } from "@/domain/artifact/objectStore";
import { baseMimeType } from "@/domain/artifact/types";
import { proxiedObjects } from "@/lib/container";
import { apiError } from "@/app/api/_lib/http";

type RouteContext = { params: Promise<{ key: string[] }> };

/**
 * What every response from this route carries.
 *
 * `next.config.ts` leaves this address alone — a header declared there
 * replaces the one a route sets, and the sandbox below is the point — so
 * nothing else puts these back, on the refusals included.
 */
const BASE_HEADERS = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "X-Frame-Options": "DENY",
} as const;

/** The console's framing rule, for the responses that are not the object. */
const ERROR_HEADERS = {
  ...BASE_HEADERS,
  "Content-Security-Policy": "frame-ancestors 'none'",
} as const;

/**
 * The terms a stored object is served under on this origin.
 *
 * A pre-signed URL put the bytes on the store's origin; this route puts them
 * on the console's. For anything a browser would render as a document — an
 * HTML artifact, an SVG, a text file with markup in it — that is the
 * difference between a page that can read the console's cookies and storage
 * and one that cannot, so those are served under `sandbox` on an opaque
 * origin, exactly as `/view` serves them. A raster image and a PDF run
 * nothing at this origin — the PDF viewer's own script is the browser's, not
 * the document's — and a PDF under `sandbox` is one some viewers refuse to
 * draw, so those two keep the console's framing rule and nothing more.
 */
function policyFor(mimeType: string): string {
  const base = baseMimeType(mimeType);
  const rendersWithoutScript =
    (base.startsWith("image/") && base !== "image/svg+xml") || base === "application/pdf";
  return rendersWithoutScript
    ? "frame-ancestors 'none'"
    : "sandbox; default-src 'none'; frame-ancestors 'none'";
}

function refuse(status: number, error: string): Response {
  return Response.json({ error }, { status, headers: ERROR_HEADERS });
}

/**
 * A stored object, served by this app.
 *
 * The address the `proxied` access mode hands out, for a deployment whose
 * store is reachable by the app and nothing else. **No session is required,
 * and that is the contract rather than an omission**: the holders of one of
 * these addresses are an `<img>` tag, a Slack message, and a model provider
 * fetching a replayed image mid-run, none of which has a cookie to present.
 * The token is the credential — an HMAC this deployment minted over the key,
 * the expiry and the filename — and its lifetime is whatever the signer asked
 * for, chosen per reader in `src/application/artifact/urlTtl.ts`. A bad or
 * expired token is a 403; an object that is no longer there is a 404; the
 * cache lifetime a reader is allowed is bounded by the token's own. The read
 * is capped at `MAX_PROXIED_OBJECT_BYTES`, the most any stored object can be.
 */
const handler = async (request: Request, ctx: RouteContext): Promise<Response> => {
  if (!proxiedObjects) {
    return refuse(404, "Artifact storage is not configured");
  }
  const { key: segments } = await ctx.params;
  const key = segments.join("/");
  const query = new URL(request.url).searchParams;
  const exp = Number(query.get("exp"));
  const sig = query.get("sig") ?? "";
  const downloadAs = query.get("dl") || undefined;
  const now = Math.floor(Date.now() / 1000);
  if (!proxiedObjects.verify({ key, exp, downloadAs }, sig, now)) {
    return refuse(403, "This link is invalid or has expired");
  }
  try {
    const { bytes, mimeType } = await proxiedObjects.read(key);
    return new Response(bytes as BodyInit, {
      headers: {
        ...BASE_HEADERS,
        "Content-Type": mimeType,
        "Content-Length": String(bytes.byteLength),
        "Content-Security-Policy": policyFor(mimeType),
        // `private`: the response carries one link's permission, and a shared
        // cache holding it would answer the next reader with it. The age is
        // the token's remaining life, never longer.
        "Cache-Control": `private, max-age=${Math.max(0, exp - now)}`,
        // RFC 5987, so a Korean filename survives the trip — the same header
        // the S3 adapter signs into a pre-signed request.
        ...(downloadAs
          ? {
              "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(downloadAs)}`,
            }
          : {}),
      },
    });
  } catch (error) {
    if (error instanceof ObjectNotFoundError) {
      return refuse(404, "That object is no longer stored");
    }
    const response = apiError(error, request);
    for (const [name, value] of Object.entries(ERROR_HEADERS)) {
      response.headers.set(name, value);
    }
    return response;
  }
};

export const GET = handler;

import { clientMetadataDocument } from "@/application/mcp/mcpAuthUseCases";
import { getPublicBaseUrl } from "@/lib/runtime-settings";
import { isSlug } from "@/shared/slug";

type RouteContext = { params: Promise<{ project: string }> };

/**
 * A project's OAuth Client ID Metadata Document (CIMD).
 *
 * **Deliberately unauthenticated**, which is the one thing to know before
 * changing it: the reader is an authorization server resolving a `client_id`
 * that is a URL, not a person and not the console. It arrives with no session
 * and from wherever the provider runs, so `withAuth` here would mean every
 * authorization fails with the server unable to say why.
 *
 * Nothing here is a secret. The document states what this deployment is and
 * where it may be redirected back to — the same facts dynamic registration used
 * to send in a POST body — and the flow's defence is PKCE plus that fixed
 * redirect URI, never the document being private.
 *
 * The project is **not** looked up. A public endpoint that reads the database
 * per request invites unauthenticated traffic into it, and answering 404 for an
 * unknown name would leak which projects exist to anyone who asks. A document
 * for a project that does not exist is inert: the authorization it could start
 * lands at the callback, which finds no connection for it and stops there.
 */
export async function GET(_request: Request, ctx: RouteContext): Promise<Response> {
  const { project } = await ctx.params;
  // The name is echoed into the document, and the document's `client_id` must
  // equal the URL it was fetched from. Anything that is not a slug could not
  // have been a project here, and would put an arbitrary string in both.
  if (!isSlug(project)) {
    return new Response("Not found", { status: 404 });
  }
  const base = await getPublicBaseUrl();
  if (!base) {
    // Without a configured address there is no correct `client_id` to state, and
    // guessing one from this request would publish a document that authorizes a
    // redirect to whatever host asked for it.
    return new Response("A public base URL is not configured", { status: 503 });
  }
  return Response.json(clientMetadataDocument(base, project), {
    headers: {
      // Servers are told to cache these by HTTP headers. Short, because the
      // document changes when the deployment's own address does, and an
      // authorization server holding a stale redirect URI refuses every
      // authorization until it expires.
      "Cache-Control": "public, max-age=300",
    },
  });
}

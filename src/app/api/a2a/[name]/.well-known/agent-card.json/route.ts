import { AgentCard, A2A_PROTOCOL_VERSION, A2A_VERSION_HEADER } from "@a2a-js/sdk";
import { a2aExposureDeps } from "@/lib/container";
import { resolveExposedProject } from "@/application/a2a/exposure";
import { isProjectPrivate } from "@/domain/project/access";
import { a2aSurfaceEnabled } from "@/app/api/a2a/_lib/auth";

type RouteContext = { params: Promise<{ name: string }> };

/**
 * Public A2A Agent Card for a published project. Serving the card without
 * authentication follows the A2A convention; execution on the JSON-RPC
 * endpoint is what the keys protect. The A2A handshake starts here, so a
 * client-key-only deployment must serve the card too — a 503 would stop a
 * standard client before it ever reached JSON-RPC.
 */
export async function GET(request: Request, ctx: RouteContext): Promise<Response> {
  if (!(await a2aSurfaceEnabled())) {
    return Response.json({ error: "A2A is not configured" }, { status: 503 });
  }
  const { name } = await ctx.params;
  const exposed = await resolveExposedProject(a2aExposureDeps, name);
  // A private project has no public card: this route carries no credential at
  // all, so "the credential itself is access" — what exempts the key-gated
  // JSON-RPC endpoint from the visibility gate — does not apply here. The same
  // 404 as an unpublished project, so the card's absence says nothing.
  if (!exposed || isProjectPrivate(exposed.project)) {
    return Response.json({ error: "Project not found or has no published version" }, { status: 404 });
  }
  const requestedVersion = request.headers.get(A2A_VERSION_HEADER);
  if (requestedVersion && requestedVersion !== A2A_PROTOCOL_VERSION) {
    return Response.json(
      { error: `A2A version ${requestedVersion} is not supported` },
      { status: 400, headers: { Vary: A2A_VERSION_HEADER } },
    );
  }
  return Response.json(AgentCard.toJSON(exposed.card), {
    headers: { Vary: A2A_VERSION_HEADER },
  });
}

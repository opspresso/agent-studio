import { a2aExposureDeps } from "@/lib/container";
import { resolveExposedProject } from "@/application/a2a/exposure";
import { a2aSurfaceEnabled } from "@/app/api/a2a/_lib/auth";

type RouteContext = { params: Promise<{ name: string }> };

/**
 * Public A2A Agent Card for a published project. Serving the card without
 * authentication follows the A2A convention; execution on the JSON-RPC
 * endpoint is what the keys protect. The A2A handshake starts here, so a
 * client-key-only deployment must serve the card too — a 503 would stop a
 * standard client before it ever reached JSON-RPC.
 */
export async function GET(_request: Request, ctx: RouteContext): Promise<Response> {
  if (!(await a2aSurfaceEnabled())) {
    return Response.json({ error: "A2A is not configured" }, { status: 503 });
  }
  const { name } = await ctx.params;
  const exposed = await resolveExposedProject(a2aExposureDeps, name);
  if (!exposed) {
    return Response.json({ error: "Project not found or has no published version" }, { status: 404 });
  }
  return Response.json(exposed.card);
}

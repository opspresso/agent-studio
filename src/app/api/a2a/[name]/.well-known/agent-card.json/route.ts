import { withMachineTenant } from "@/app/api/_lib/http";
import { a2aExposureDeps } from "@/lib/container";
import { resolveExposedProject } from "@/application/a2a/exposure";
import { getA2aApiKey } from "@/lib/runtime-settings";

type RouteContext = { params: Promise<{ name: string }> };

/**
 * Public A2A Agent Card for a published project. Serving the card without
 * authentication follows the A2A convention; execution on the JSON-RPC
 * endpoint is what the shared key protects.
 *
 * Scoped like the JSON-RPC endpoint beside it, and for the same reason: the
 * project it names is a tenant's row. Without the scope a workspace's agent is
 * executable — the sibling route takes `X-Tenant` — but undiscoverable, because
 * the card lookup would run in the default tenant and 404. Discovering an agent
 * by its card is the protocol's normal entry point, so that is the whole agent
 * being unreachable.
 */
export async function GET(request: Request, ctx: RouteContext): Promise<Response> {
  return withMachineTenant(request, async () => {
    if (!(await getA2aApiKey())) {
      return Response.json({ error: "A2A is not configured" }, { status: 503 });
    }
    const { name } = await ctx.params;
    const exposed = await resolveExposedProject(a2aExposureDeps, name);
    if (!exposed) {
      return Response.json(
        { error: "Project not found or has no published version" },
        { status: 404 },
      );
    }
    return Response.json(exposed.card);
  });
}

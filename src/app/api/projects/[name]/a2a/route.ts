import type { AgentCard } from "@a2a-js/sdk";
import { a2aExposureDeps } from "@/lib/container";
import { describeProjectA2a } from "@/application/a2a/exposure";
import { a2aSurfaceEnabled } from "@/app/api/a2a/_lib/auth";
import { withAuth } from "@/lib/session";

type RouteContext = { params: Promise<{ name: string }> };

export interface ProjectA2aView {
  /** The inbound surface is on: a shared key or at least one client key. */
  enabled: boolean;
  published: boolean;
  cardUrl: string | null;
  /** The Agent Card that this project publishes, or null with no published version. */
  card: AgentCard | null;
}

export const GET = withAuth(async (_user, _request: Request, ctx: RouteContext) => {
  const { name } = await ctx.params;
  const enabled = await a2aSurfaceEnabled();
  const view = await describeProjectA2a(a2aExposureDeps, name, enabled);
  if (!view) {
    return Response.json({ error: "Project not found" }, { status: 404 });
  }
  return Response.json({ enabled, ...view } satisfies ProjectA2aView);
});

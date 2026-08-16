import { withMemberAuth } from "@/lib/session";
import { apiError } from "@/app/api/_lib/http";
import { pluginUseCases } from "@/lib/container";
import { isPluginName } from "@/domain/plugin/types";

/**
 * One installed plugin. Validated with the spec's own name rule — NOT the
 * registry slug, which would 404 every plugin with a period in its name.
 */
export const GET = withMemberAuth(async (_user, _request: Request, ctx: { params: Promise<{ name: string }> }) => {
  const { name } = await ctx.params;
  if (!isPluginName(name)) {
    return Response.json({ error: "Invalid plugin name" }, { status: 400 });
  }
  try {
    return Response.json(await pluginUseCases.get(name));
  } catch (error) {
    return apiError(error);
  }
});

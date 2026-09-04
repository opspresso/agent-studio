import { withMemberAuth } from "@/lib/session";
import { apiError } from "@/app/api/_lib/http";
import { pluginUseCases } from "@/lib/container";
import { config } from "@/lib/config";
import { isPluginName } from "@/domain/plugin/types";
import type { Plugin } from "@/domain/plugin/types";

export type PluginResponse = Plugin & { repositoryUrl: string | null };

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
    const plugin = await pluginUseCases.get(name);
    const githubWebUrl = config.githubWebUrl;
    const response = {
      ...plugin,
      repositoryUrl: githubWebUrl ? `${githubWebUrl}/${plugin.repo}` : null,
    } satisfies PluginResponse;
    return Response.json(response);
  } catch (error) {
    return apiError(error);
  }
});

import type { SourceReferenceDeps } from "@/application/audio/sourceReferences";
import type { ExecutionDeps } from "@/application/execution/deps";
import { buildMcpTools, closeMcp, type McpToolDeps } from "@/application/execution/mcpTools";
import type { RegisterMcpSource } from "@/application/audio/mapMcpSource";
import { AudioJobStepError } from "@/application/audio/processJob";

export function createMcpSourceRefresher(deps: McpToolDeps & Pick<ExecutionDeps, "versions">): NonNullable<SourceReferenceDeps["refresh"]> {
  return async (job, recipe, signal) => {
    const check = async () => {
      const version = await deps.versions.get(job.projectName, recipe.versionName);
      const server = await deps.mcps.get(recipe.serverName);
      const binding = version?.mcpList.find((entry) => entry.name === recipe.serverName);
      if (!version || !server || !binding || !recipe.mapping.refreshArgument ||
        await deps.sourceRefreshIdentity?.({ version, server, binding }) !== recipe.identity) {
        throw new AudioJobStepError("source_connection_changed", false);
      }
      return { version, binding };
    };
    const { version, binding } = await check();
    let refreshed: Parameters<RegisterMcpSource>[0] | undefined;
    // Project before the model-facing result cap; a large provider response may
    // otherwise lose the closing JSON delimiter. This callback persists nothing.
    const client = await buildMcpTools({ ...deps, registerMcpSource: async (source) => {
      refreshed = source;
      return { sourceRef: "refresh", filename: source.filename, mimeType: source.mimeType };
    } }, { ...version,
      mcpList: [{ ...binding, tools: [recipe.mapping.tool], sourceOutputs: [{ ...recipe.mapping, refreshArgument: undefined }] }] }, signal,
    { actor: job.actor, userEmail: job.userEmail });
    try {
      const alias = client.aliasFor?.(recipe.serverName, recipe.mapping.tool);
      if (!alias || !client.callMcpTool || !job.sourceIdentity) throw new AudioJobStepError("source_refresh_unavailable", false);
      const argument = recipe.mapping.refreshArgument!;
      const parameters = client.mcpTools.find((tool) => tool.function.name === alias)?.function.parameters as
        { properties?: Record<string, { type?: string }> } | undefined;
      const numericId = ["number", "integer"].includes(parameters?.properties?.[argument]?.type ?? "");
      const itemId = numericId ? Number(job.sourceIdentity.itemId) : job.sourceIdentity.itemId;
      if (numericId && (!Number.isSafeInteger(itemId) || String(itemId) !== job.sourceIdentity.itemId)) {
        throw new AudioJobStepError("source_refresh_argument_invalid", false);
      }
      const result = await client.callMcpTool(alias, { [argument]: itemId });
      await check();
      if (result.text.startsWith("Error:")) throw new AudioJobStepError("source_refresh_failed", true);
      if (!refreshed) throw new AudioJobStepError("source_refresh_response_invalid", false);
      return refreshed;
    } finally { await closeMcp(client.close); }
  };
}

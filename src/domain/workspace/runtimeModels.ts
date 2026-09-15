import { modelType, type ModelConfig } from "../llm/models";
import type { ProviderChannelConfig } from "../settings/types";
import { WORKSPACE_RUNTIMES, type WorkspaceRuntime, type WorkspaceModelRuntime } from "./types";

export const WORKSPACE_MODEL_RUNTIMES = WORKSPACE_RUNTIMES.filter((runtime): runtime is Exclude<WorkspaceRuntime, "command"> => runtime !== "command");
export type { WorkspaceModelRuntime, WorkspaceRuntimeModels } from "./types";

/** Native CLI protocol support, separate from the agent's chat model selection. */
export function workspaceRuntimeModelCompatible(runtime: WorkspaceModelRuntime, model: ModelConfig): boolean {
  if (modelType(model) !== "text" || !model.capabilities.tools) return false;
  if (runtime === "claude") return model.provider === "anthropic";
  if (runtime === "codex") return ["openai", "openrouter", "selfhosted"].includes(model.provider);
  return ["openai", "openrouter", "selfhosted", "google", "xai"].includes(model.provider);
}

export function workspaceModelChannel(model: ModelConfig, channels: readonly ProviderChannelConfig[]): ProviderChannelConfig | undefined {
  return channels.find(channel => channel.name === model.provider && channel.auth === "bearer" && !!channel.apiKey);
}

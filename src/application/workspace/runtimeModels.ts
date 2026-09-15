import { getModelConfig, getVisibleModels } from "@/domain/llm/models";
import type { SettingsRepository } from "@/domain/settings/repository";
import type { ProviderChannelConfig } from "@/domain/settings/types";
import { WORKSPACE_MODEL_RUNTIMES, workspaceModelChannel, workspaceRuntimeModelCompatible, type WorkspaceModelRuntime, type WorkspaceRuntimeModels } from "@/domain/workspace/runtimeModels";
import type { WorkspaceRuntime } from "@/domain/workspace/types";
import { ValidationError } from "@/application/errors";
import { auditTarget, recordAudit } from "@/application/audit/recordAudit";

interface RuntimeModelsDeps {
  repository: SettingsRepository;
  channels(): Promise<ProviderChannelConfig[]>;
  invalidate(): void;
  now(): Date;
}
export interface WorkspaceRuntimeModelsView {
  selections: WorkspaceRuntimeModels;
  options: Record<WorkspaceModelRuntime, { value: string; label: string }[]>;
  available: WorkspaceRuntime[];
}
export function createWorkspaceRuntimeModelUseCases(deps: RuntimeModelsDeps) {
  async function view(): Promise<WorkspaceRuntimeModelsView> {
    const [settings, channels] = await Promise.all([deps.repository.get(), deps.channels()]);
    const selections = settings?.workspaceModels ?? {};
    const options = {} as WorkspaceRuntimeModelsView["options"];
    const available: WorkspaceRuntime[] = ["command"];
    for (const runtime of WORKSPACE_MODEL_RUNTIMES) {
      options[runtime] = getVisibleModels().filter(model => !model.hidden && !settings?.hiddenModels?.includes(model.id) && workspaceRuntimeModelCompatible(runtime, model) && workspaceModelChannel(model, channels))
        .map(model => ({ value: model.id, label: `${model.displayName} (${model.provider})` }));
      const model = selections[runtime] ? getModelConfig(selections[runtime]!) : undefined;
      // Hiding removes an option but does not revoke a saved model.
      if (model && workspaceRuntimeModelCompatible(runtime, model) && workspaceModelChannel(model, channels)) available.push(runtime);
    }
    return { selections, options, available };
  }
  return {
    getView: view,
    async select(runtime: WorkspaceModelRuntime, modelId: string | null, actorEmail: string) {
      if (!WORKSPACE_MODEL_RUNTIMES.includes(runtime)) throw new ValidationError("Invalid Workspace model runtime");
      if (modelId !== null && !(await view()).options[runtime].some(model => model.value === modelId)) throw new ValidationError("Workspace model must support this runtime and have a configured API key channel");
      await deps.repository.update(current => {
        const workspaceModels = { ...current?.workspaceModels };
        if (modelId === null) delete workspaceModels[runtime]; else workspaceModels[runtime] = modelId;
        return { ...current, workspaceModels, updatedAt: deps.now().toISOString() };
      });
      deps.invalidate();
      await recordAudit({ actorEmail, action: "settings.update", target: auditTarget("workspace-model", runtime), detail: modelId ?? "disabled" }, deps.now());
      return view();
    },
  };
}

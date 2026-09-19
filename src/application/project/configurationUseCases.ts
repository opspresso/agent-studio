import type { AgentConfiguration, McpBinding, Project } from "@/domain/project/types";
import type { ProjectRepository } from "@/domain/project/repository";
import type { SecretCipher } from "@/domain/security/secretCipher";
import { agentMcpHeadersContext } from "@/domain/security/secretContext";
import { ConflictError, ValidationError } from "@/application/errors";
import { nextUpdatedAt } from "@/shared/nextUpdatedAt";
import { assertProjectAccessible, assertProjectWritable } from "./projectUseCases";
import { persistProjectUpdate } from "./projectUpdate";
import { resolveMcpBindings } from "./mcpBindingSettings";
import {
  assertModelSupports, assertProjectModelType, assertReferencesExist,
  assertSubagentProjectsAccessible, assertUniqueReferences, assertValidImageModel,
  warnUnknownCatalogModel, type AgentConfigurationInput, type ConfigurationRefRepos,
} from "./configurationPolicy";

export type { AgentConfigurationInput } from "./configurationPolicy";

/** Execution uses the settings read with its Project; there is no publication lookup. */
export function requireAgentConfiguration(project: Project): AgentConfiguration {
  if (!project.configuration) throw new ValidationError(`Agent "${project.name}" is not configured`);
  return project.configuration;
}

export interface AgentConfigurationView {
  configuration: AgentConfiguration | null;
  /** The project snapshot the editor must echo when replacing its settings. */
  updatedAt: string;
}

export interface PutAgentConfigurationInput extends AgentConfigurationInput {
  expectedUpdatedAt: string;
}

export interface ConfigurationDeps {
  projects: ProjectRepository;
  refs: ConfigurationRefRepos;
  cipher: SecretCipher;
}

/** Whitelist current settings and mask credentials before producing a response. */
export function toAgentConfigurationView(cipher: SecretCipher, project: Project): AgentConfigurationView {
  const configuration = project.configuration;
  return {
    updatedAt: project.updatedAt,
    configuration: configuration ? {
      projectName: project.name,
      systemPrompt: configuration.systemPrompt,
      model: configuration.model,
      ...(configuration.fallbackModel ? { fallbackModel: configuration.fallbackModel } : {}),
      parameters: configuration.parameters,
      mcpList: configuration.mcpList.map(({ headerTarget: _target, headers, ...binding }) => ({
        ...binding,
        ...(headers ? { headers: cipher.maskHeaderOverrides(headers, agentMcpHeadersContext(project.name, binding.name)) } : {}),
      })),
      skillList: configuration.skillList,
      subagentList: configuration.subagentList,
      ...(configuration.maxTurn === undefined ? {} : { maxTurn: configuration.maxTurn }),
    } : null,
  };
}

export async function putAgentConfiguration(
  deps: ConfigurationDeps, name: string, input: PutAgentConfigurationInput, userEmail: string,
): Promise<AgentConfigurationView> {
  const project = await assertProjectWritable(deps.projects, name, userEmail);
  if (input.expectedUpdatedAt !== project.updatedAt) {
    throw new ConflictError(`Project "${name}" was modified by another request`);
  }
  assertValidImageModel(input.parameters);
  assertModelSupports(project, input.model, input.parameters);
  if (input.fallbackModel) assertProjectModelType(project, input.fallbackModel);
  warnUnknownCatalogModel(name, input.model);
  assertUniqueReferences(input);
  await assertReferencesExist(deps.refs, input, project.configuration);
  await assertSubagentProjectsAccessible(deps.refs, input, userEmail, project.configuration);
  const configuration: AgentConfiguration = {
    projectName: name,
    systemPrompt: input.systemPrompt,
    model: input.model,
    ...(input.fallbackModel ? { fallbackModel: input.fallbackModel } : {}),
    parameters: structuredClone(input.parameters),
    mcpList: await resolveMcpBindings(deps.cipher, deps.refs.mcps, input.mcpList,
      project.configuration?.mcpList ?? [], (server) => agentMcpHeadersContext(name, server)),
    skillList: [...input.skillList],
    subagentList: input.subagentList.map(ref => ({ ...ref })),
    ...(input.maxTurn === undefined ? {} : { maxTurn: input.maxTurn }),
  };
  const updated = { ...project, configuration, updatedAt: nextUpdatedAt(project.updatedAt) };
  await persistProjectUpdate(deps.projects, updated, project.updatedAt);
  return toAgentConfigurationView(deps.cipher, updated);
}

export interface ConfigurationUseCases {
  getView(name: string, userEmail: string): Promise<AgentConfigurationView>;
  put(name: string, input: PutAgentConfigurationInput, userEmail: string): Promise<AgentConfigurationView>;
  resolveDraftBindings(name: string, bindings: McpBinding[], userEmail: string): Promise<McpBinding[]>;
}

export function createConfigurationUseCases(deps: ConfigurationDeps): ConfigurationUseCases {
  return {
    getView: async (name, email) => toAgentConfigurationView(deps.cipher,
      await assertProjectAccessible(deps.projects, name, email)),
    put: (name, input, email) => putAgentConfiguration(deps, name, input, email),
    async resolveDraftBindings(name, bindings, email) {
      const project = await assertProjectAccessible(deps.projects, name, email);
      return resolveMcpBindings(deps.cipher, deps.refs.mcps, bindings,
        project.configuration?.mcpList ?? [], (server) => agentMcpHeadersContext(name, server));
    },
  };
}

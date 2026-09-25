import type { AgentConfiguration, McpBinding, Agent } from "@/domain/agent/types";
import type { AgentRepository } from "@/domain/agent/repository";
import type { SecretCipher } from "@/domain/security/secretCipher";
import { agentMcpHeadersContext } from "@/domain/security/secretContext";
import { ConflictError, ValidationError } from "@/application/errors";
import { nextUpdatedAt } from "@/shared/nextUpdatedAt";
import { assertAgentAccessible, assertAgentWritable } from "./agentUseCases";
import { persistAgentUpdate } from "./agentUpdate";
import { resolveMcpBindings } from "./mcpBindingSettings";
import {
  assertModelSupports, assertAgentModelType, assertReferencesExist,
  assertSubavailableAgentsAccessible, assertUniqueReferences, assertValidImageModel,
  warnUnknownCatalogModel, type AgentConfigurationInput, type ConfigurationRefRepos,
} from "./configurationPolicy";

export type { AgentConfigurationInput } from "./configurationPolicy";

/** Execution uses the settings read with its Agent; there is no publication lookup. */
export function requireAgentConfiguration(agent: Agent): AgentConfiguration {
  if (!agent.configuration) throw new ValidationError(`Agent "${agent.name}" is not configured`);
  return agent.configuration;
}

export interface AgentConfigurationView {
  configuration: AgentConfiguration | null;
  /** The agent snapshot the editor must echo when replacing its settings. */
  updatedAt: string;
}

export interface PutAgentConfigurationInput extends AgentConfigurationInput {
  expectedUpdatedAt: string;
}

export interface ConfigurationDeps {
  agents: AgentRepository;
  refs: ConfigurationRefRepos;
  cipher: SecretCipher;
}

/** Whitelist current settings and mask credentials before producing a response. */
export function toAgentConfigurationView(cipher: SecretCipher, agent: Agent): AgentConfigurationView {
  const configuration = agent.configuration;
  return {
    updatedAt: agent.updatedAt,
    configuration: configuration ? {
      agentName: agent.name,
      systemPrompt: configuration.systemPrompt,
      model: configuration.model,
      ...(configuration.fallbackModel ? { fallbackModel: configuration.fallbackModel } : {}),
      parameters: configuration.parameters,
      mcpList: configuration.mcpList.map(({ headerTarget: _target, headers, ...binding }) => ({
        ...binding,
        ...(headers ? { headers: cipher.maskHeaderOverrides(headers, agentMcpHeadersContext(agent.name, binding.name)) } : {}),
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
  const agent = await assertAgentWritable(deps.agents, name, userEmail);
  if (input.expectedUpdatedAt !== agent.updatedAt) {
    throw new ConflictError(`Agent "${name}" was modified by another request`);
  }
  assertValidImageModel(input.parameters);
  assertModelSupports(input.model, input.parameters);
  if (input.fallbackModel) assertAgentModelType(input.fallbackModel);
  warnUnknownCatalogModel(name, input.model);
  assertUniqueReferences(input);
  await assertReferencesExist(deps.refs, input, agent.configuration);
  await assertSubavailableAgentsAccessible(deps.refs, input, userEmail, agent.configuration);
  const configuration: AgentConfiguration = {
    agentName: name,
    systemPrompt: input.systemPrompt,
    model: input.model,
    ...(input.fallbackModel ? { fallbackModel: input.fallbackModel } : {}),
    parameters: structuredClone(input.parameters),
    mcpList: await resolveMcpBindings(deps.cipher, deps.refs.mcps, input.mcpList,
      agent.configuration?.mcpList ?? [], (server) => agentMcpHeadersContext(name, server)),
    skillList: [...input.skillList],
    subagentList: input.subagentList.map(ref => ({ ...ref })),
    ...(input.maxTurn === undefined ? {} : { maxTurn: input.maxTurn }),
  };
  const updated = { ...agent, configuration, updatedAt: nextUpdatedAt(agent.updatedAt) };
  await persistAgentUpdate(deps.agents, updated, agent.updatedAt);
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
      await assertAgentAccessible(deps.agents, name, email)),
    put: (name, input, email) => putAgentConfiguration(deps, name, input, email),
    async resolveDraftBindings(name, bindings, email) {
      const agent = await assertAgentAccessible(deps.agents, name, email);
      return resolveMcpBindings(deps.cipher, deps.refs.mcps, bindings,
        agent.configuration?.mcpList ?? [], (server) => agentMcpHeadersContext(name, server));
    },
  };
}

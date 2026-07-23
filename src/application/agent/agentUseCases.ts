import type { ExternalAgentRepository } from "@/domain/agent/repository";
import type { AgentProtocol, ExternalAgent } from "@/domain/agent/types";
import { NotFoundError } from "@/application/errors";
import {
  assertAllowedUrl,
  createRegistryUseCases,
  type RegistryUseCases,
} from "@/application/registry/registryUseCases";
import { sendA2aMessage } from "@/infrastructure/a2a/client";
import { assertPublicUrl, SsrfError } from "@/infrastructure/net/ssrfGuard";
import {
  decryptHeadersForOutbound,
  encryptHeaders,
  maskHeaders,
  mergeHeaderUpdate,
} from "@/infrastructure/crypto/secretEncryption";
import { sendAgentMessage, type SendMessageResult } from "@/infrastructure/agent/agentClient";

export interface CreateAgentInput {
  name: string;
  url: string;
  protocol?: AgentProtocol;
  description: string;
  headers: Record<string, string>;
}

export interface UpdateAgentInput {
  url?: string;
  protocol?: AgentProtocol;
  description?: string;
  headers?: Record<string, string>;
}

export interface AgentUseCases
  extends RegistryUseCases<ExternalAgent, CreateAgentInput, UpdateAgentInput> {
  /** Sends one message with decrypted headers. Throws {@link NotFoundError} when the agent does not exist. */
  sendMessage(name: string, message: string): Promise<SendMessageResult>;
}

/** Client-safe projection: encrypted header values are replaced with a mask. */
function masked(agent: ExternalAgent): ExternalAgent {
  return { ...agent, headers: maskHeaders(agent.headers) };
}

export function createAgentUseCases(repo: ExternalAgentRepository): AgentUseCases {
  const registry = createRegistryUseCases<ExternalAgent, CreateAgentInput, UpdateAgentInput>({
    label: "External agent",
    repo,
    view: masked,
    async build(input, now) {
      await assertAllowedUrl(input.url);
      return {
        name: input.name,
        url: input.url,
        ...(input.protocol ? { protocol: input.protocol } : {}),
        description: input.description,
        headers: encryptHeaders(input.headers),
        createdAt: now,
        updatedAt: now,
      };
    },
    async apply(existing, patch, now) {
      if (patch.url !== undefined) {
        await assertAllowedUrl(patch.url);
      }
      return {
        ...existing,
        url: patch.url ?? existing.url,
        protocol: patch.protocol ?? existing.protocol,
        description: patch.description ?? existing.description,
        headers:
          patch.headers !== undefined
            ? mergeHeaderUpdate(existing.headers, patch.headers)
            : existing.headers,
        updatedAt: now,
      };
    },
  });

  return {
    ...registry,

    async sendMessage(name, message) {
      const existing = await repo.get(name);
      if (!existing) {
        throw new NotFoundError(`External agent not found: ${name}`);
      }
      try {
        await assertPublicUrl(existing.url);
      } catch (error) {
        return { ok: false, error: error instanceof SsrfError ? error.message : "Blocked URL" };
      }
      const headers = decryptHeadersForOutbound(existing.headers);
      if ((existing.protocol ?? "openai") === "a2a") {
        return sendA2aMessage(existing.url, headers, message);
      }
      return sendAgentMessage(existing.url, headers, message);
    },
  };
}

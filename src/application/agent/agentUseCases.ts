import type { ExternalAgentRepository } from "@/domain/agent/repository";
import type { AgentProtocol, ExternalAgent } from "@/domain/agent/types";
import { NotFoundError } from "@/application/errors";
import {
  assertAllowedUrl,
  createRegistryUseCases,
  type RegistryUseCases,
} from "@/application/registry/registryUseCases";
import { sendA2aMessage } from "@/infrastructure/a2a/client";
import { BlockedUrlError, type UrlPolicy } from "@/domain/security/urlPolicy";
import type { SecretCipher } from "@/domain/security/secretCipher";
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
function masked(cipher: SecretCipher, agent: ExternalAgent): ExternalAgent {
  return { ...agent, headers: cipher.maskHeaders(agent.headers) };
}

export function createAgentUseCases(
  repo: ExternalAgentRepository,
  cipher: SecretCipher,
  policy: UrlPolicy,
): AgentUseCases {
  const registry = createRegistryUseCases<ExternalAgent, CreateAgentInput, UpdateAgentInput>({
    label: "External agent",
    repo,
    view: (agent) => masked(cipher, agent),
    async build(input, now) {
      await assertAllowedUrl(policy, input.url);
      return {
        name: input.name,
        url: input.url,
        ...(input.protocol ? { protocol: input.protocol } : {}),
        description: input.description,
        headers: cipher.encryptHeaders(input.headers),
        createdAt: now,
        updatedAt: now,
      };
    },
    async apply(existing, patch, now) {
      if (patch.url !== undefined) {
        await assertAllowedUrl(policy, patch.url);
      }
      return {
        ...existing,
        url: patch.url ?? existing.url,
        protocol: patch.protocol ?? existing.protocol,
        description: patch.description ?? existing.description,
        headers:
          patch.headers !== undefined
            ? cipher.mergeHeaderUpdate(existing.headers, patch.headers)
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
        await policy.assertAllowed(existing.url);
      } catch (error) {
        return { ok: false, error: error instanceof BlockedUrlError ? error.message : "Blocked URL" };
      }
      const headers = cipher.decryptHeadersForOutbound(existing.headers);
      if ((existing.protocol ?? "openai") === "a2a") {
        return sendA2aMessage(existing.url, headers, message);
      }
      return sendAgentMessage(existing.url, headers, message);
    },
  };
}

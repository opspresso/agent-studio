import type { ExternalAgentRepository } from "@/domain/agent/repository";
import type { AgentProtocol, ExternalAgent } from "@/domain/agent/types";
import { sendA2aMessage } from "@/infrastructure/a2a/client";
import { assertPublicUrl, SsrfError } from "@/infrastructure/net/ssrfGuard";
import {
  decryptHeadersForOutbound,
  encryptHeaders,
  maskHeaders,
  mergeHeaderUpdate,
} from "@/infrastructure/crypto/secretEncryption";
import { sendAgentMessage, type SendMessageResult } from "./agentClient";

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

export interface AgentUseCases {
  list(): Promise<ExternalAgent[]>;
  get(name: string): Promise<ExternalAgent | null>;
  /** Returns the created agent (headers masked), or `null` if the name already exists. */
  create(input: CreateAgentInput): Promise<ExternalAgent | null>;
  /** Returns the updated agent (headers masked), or `null` if none exists. */
  update(name: string, patch: UpdateAgentInput): Promise<ExternalAgent | null>;
  /** Returns `true` when an agent was deleted, `false` when none existed. */
  remove(name: string): Promise<boolean>;
  /** Sends one message with decrypted headers. `null` when the agent does not exist. */
  sendMessage(name: string, message: string): Promise<SendMessageResult | null>;
}

/** Client-safe projection: encrypted header values are replaced with a mask. */
function masked(agent: ExternalAgent): ExternalAgent {
  return { ...agent, headers: maskHeaders(agent.headers) };
}

export function createAgentUseCases(repo: ExternalAgentRepository): AgentUseCases {
  async function resolveForDispatch(
    name: string,
  ): Promise<{ url: string; protocol: AgentProtocol; headers: Record<string, string> } | null> {
    const existing = await repo.get(name);
    if (!existing) {
      return null;
    }
    return {
      url: existing.url,
      protocol: existing.protocol ?? "openai",
      headers: decryptHeadersForOutbound(existing.headers),
    };
  }

  return {
    async list() {
      return (await repo.list()).map(masked);
    },

    async get(name) {
      const existing = await repo.get(name);
      return existing ? masked(existing) : null;
    },

    async create(input) {
      await assertPublicUrl(input.url);
      const existing = await repo.get(input.name);
      if (existing) {
        return null;
      }
      const now = new Date().toISOString();
      const agent: ExternalAgent = {
        name: input.name,
        url: input.url,
        ...(input.protocol ? { protocol: input.protocol } : {}),
        description: input.description,
        headers: encryptHeaders(input.headers),
        createdAt: now,
        updatedAt: now,
      };
      await repo.put(agent);
      return masked(agent);
    },

    async update(name, patch) {
      const existing = await repo.get(name);
      if (!existing) {
        return null;
      }
      if (patch.url !== undefined) {
        await assertPublicUrl(patch.url);
      }
      const headers =
        patch.headers !== undefined
          ? mergeHeaderUpdate(existing.headers, patch.headers)
          : existing.headers;
      const updated: ExternalAgent = {
        ...existing,
        url: patch.url ?? existing.url,
        protocol: patch.protocol ?? existing.protocol,
        description: patch.description ?? existing.description,
        headers,
        updatedAt: new Date().toISOString(),
      };
      await repo.put(updated);
      return masked(updated);
    },

    async remove(name) {
      const existing = await repo.get(name);
      if (!existing) {
        return false;
      }
      await repo.delete(name);
      return true;
    },

    async sendMessage(name, message) {
      const config = await resolveForDispatch(name);
      if (!config) {
        return null;
      }
      try {
        await assertPublicUrl(config.url);
      } catch (error) {
        return { ok: false, error: error instanceof SsrfError ? error.message : "Blocked URL" };
      }
      if (config.protocol === "a2a") {
        return sendA2aMessage(config.url, config.headers, message);
      }
      return sendAgentMessage(config.url, config.headers, message);
    },
  };
}

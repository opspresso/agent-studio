import type { McpRepository } from "@/domain/mcp/repository";
import type { McpServer } from "@/domain/mcp/types";
import {
  decryptHeadersForOutbound,
  encryptHeaders,
  maskHeaders,
  mergeHeaderUpdate,
} from "@/lib/secret-encryption";
import { assertPublicUrl, SsrfError } from "@/infrastructure/net/ssrfGuard";
import { listMcpTools, type ListToolsResult } from "./mcpClient";

export interface CreateMcpInput {
  name: string;
  url: string;
  description?: string;
  headers: Record<string, string>;
}

export interface UpdateMcpInput {
  url?: string;
  description?: string;
  headers?: Record<string, string>;
}

export interface McpUseCases {
  list(): Promise<McpServer[]>;
  get(name: string): Promise<McpServer | null>;
  /** Returns the created server (headers masked), or `null` if the name already exists. */
  create(input: CreateMcpInput): Promise<McpServer | null>;
  /** Returns the updated server (headers masked), or `null` if none exists. */
  update(name: string, patch: UpdateMcpInput): Promise<McpServer | null>;
  /** Returns `true` when a server was deleted, `false` when none existed. */
  remove(name: string): Promise<boolean>;
  /** Connects to the server with decrypted headers. `null` when the server does not exist. */
  testConnection(name: string): Promise<ListToolsResult | null>;
}

/** Client-safe projection: encrypted header values are replaced with a mask. */
function masked(server: McpServer): McpServer {
  return { ...server, headers: maskHeaders(server.headers) };
}

export function createMcpUseCases(repo: McpRepository): McpUseCases {
  async function resolveForDispatch(
    name: string,
  ): Promise<{ url: string; headers: Record<string, string> } | null> {
    const existing = await repo.get(name);
    if (!existing) {
      return null;
    }
    return { url: existing.url, headers: decryptHeadersForOutbound(existing.headers) };
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
      const server: McpServer = {
        name: input.name,
        url: input.url,
        description: input.description,
        headers: encryptHeaders(input.headers),
        createdAt: now,
        updatedAt: now,
      };
      await repo.put(server);
      return masked(server);
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
      const updated: McpServer = {
        ...existing,
        url: patch.url ?? existing.url,
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

    async testConnection(name) {
      const config = await resolveForDispatch(name);
      if (!config) {
        return null;
      }
      try {
        await assertPublicUrl(config.url);
      } catch (error) {
        return { ok: false, error: error instanceof SsrfError ? error.message : "Blocked URL" };
      }
      return listMcpTools(config.url, config.headers);
    },
  };
}

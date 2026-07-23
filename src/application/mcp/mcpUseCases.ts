import type { McpRepository } from "@/domain/mcp/repository";
import type { McpServer } from "@/domain/mcp/types";
import { NotFoundError } from "@/application/errors";
import {
  assertAllowedUrl,
  createRegistryUseCases,
  type RegistryUseCases,
} from "@/application/registry/registryUseCases";
import {
  decryptHeadersForOutbound,
  encryptHeaders,
  maskHeaders,
  mergeHeaderUpdate,
} from "@/infrastructure/crypto/secretEncryption";
import { assertPublicUrl, SsrfError } from "@/infrastructure/net/ssrfGuard";
import { listMcpTools, type ListToolsResult } from "@/infrastructure/mcp/mcpClient";

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

export interface McpUseCases extends RegistryUseCases<McpServer, CreateMcpInput, UpdateMcpInput> {
  /** Connects with decrypted headers. Throws {@link NotFoundError} when the server does not exist. */
  testConnection(name: string): Promise<ListToolsResult>;
}

/** Client-safe projection: encrypted header values are replaced with a mask. */
function masked(server: McpServer): McpServer {
  return { ...server, headers: maskHeaders(server.headers) };
}

export function createMcpUseCases(repo: McpRepository): McpUseCases {
  const registry = createRegistryUseCases<McpServer, CreateMcpInput, UpdateMcpInput>({
    label: "MCP server",
    repo,
    view: masked,
    async build(input, now) {
      await assertAllowedUrl(input.url);
      return {
        name: input.name,
        url: input.url,
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

    async testConnection(name) {
      const existing = await repo.get(name);
      if (!existing) {
        throw new NotFoundError(`MCP server not found: ${name}`);
      }
      try {
        await assertPublicUrl(existing.url);
      } catch (error) {
        return { ok: false, error: error instanceof SsrfError ? error.message : "Blocked URL" };
      }
      return listMcpTools(existing.url, decryptHeadersForOutbound(existing.headers));
    },
  };
}

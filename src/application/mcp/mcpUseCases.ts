import type { McpRepository } from "@/domain/mcp/repository";
import { isManagedLoopback, type McpServer } from "@/domain/mcp/types";
import { NotFoundError, ValidationError } from "@/application/errors";
import {
  assertAllowedUrl,
  createRegistryUseCases,
  type RegistryUseCases,
} from "@/application/registry/registryUseCases";
import type { SecretCipher } from "@/domain/security/secretCipher";
import { BlockedUrlError, type UrlPolicy } from "@/domain/security/urlPolicy";
import type { ListToolsResult, McpToolProbe } from "@/domain/mcp/toolProbe";
import { log } from "@/shared/logger";

export interface CreateMcpInput {
  name: string;
  url: string;
  description?: string;
  content?: string;
  headers: Record<string, string>;
}

export interface UpdateMcpInput {
  url?: string;
  description?: string;
  content?: string;
  headers?: Record<string, string>;
}

export interface McpUseCases extends RegistryUseCases<McpServer, CreateMcpInput, UpdateMcpInput> {
  /** Connects with decrypted headers. Throws {@link NotFoundError} when the server does not exist. */
  testConnection(name: string): Promise<ListToolsResult>;
}

/** Client-safe projection: encrypted secret values are replaced with a mask. */
function masked(cipher: SecretCipher, server: McpServer): McpServer {
  return {
    ...server,
    headers: cipher.maskHeaders(server.headers),
    ...(server.environment
      ? { environment: cipher.maskHeaders(server.environment) }
      : {}),
  };
}

export function createMcpUseCases(
  repo: McpRepository,
  cipher: SecretCipher,
  policy: UrlPolicy,
  probe: McpToolProbe,
): McpUseCases {
  const registry = createRegistryUseCases<McpServer, CreateMcpInput, UpdateMcpInput>({
    label: "MCP server",
    repo,
    view: (server) => masked(cipher, server),
    async build(input, now) {
      await assertAllowedUrl(policy, input.url);
      return {
        name: input.name,
        url: input.url,
        description: input.description,
        content: input.content,
        headers: cipher.encryptHeaders(input.headers),
        createdAt: now,
        updatedAt: now,
      };
    },
    async apply(existing, patch, now) {
      // A managed entry's address is the whole basis for trusting it: it was
      // recorded after the provisioner bound the port, not typed by anyone. An
      // edit that could move it would turn "we started this" back into "someone
      // said so", which is exactly the claim the loopback bypass must not rest
      // on. Managed rows are changed by the provisioner, not through here.
      if (existing.runtime === "managed" && patch.url !== undefined && patch.url !== existing.url) {
        throw new ValidationError(
          `MCP server "${existing.name}" is managed: its address is set when the container starts and cannot be edited.`,
        );
      }
      // A managed entry's address is loopback by construction, was vetted when
      // the provisioner reported it, and cannot have moved — the check above
      // refuses that. Re-running the public-URL guard over it fails the save of
      // every *other* field, which is how editing a managed server's headers
      // became impossible.
      if (patch.url !== undefined && !isManagedLoopback(existing)) {
        await assertAllowedUrl(policy, patch.url);
      }
      // The OAuth block was read out of the *old* address's well-known
      // documents: its `resource` names that server, and its endpoints belong to
      // whichever authorization server vouched for it. Carrying it across a move
      // would leave the entry describing a server it no longer points at — and
      // every project's stored token is bound by RFC 8707 to that stale
      // `resource` while being sent to the new address. Dropped instead, which
      // is the state a never-discovered entry is already in: the entry keeps
      // working on its own headers, and an admin re-runs Discover to get an
      // `auth` block that describes where it points now.
      const movedAddress = patch.url !== undefined && patch.url !== existing.url;
      const { auth: discarded, ...withoutAuth } = existing;
      const updated: McpServer = {
        ...(movedAddress ? withoutAuth : existing),
        url: patch.url ?? existing.url,
        description: patch.description ?? existing.description,
        content: patch.content ?? existing.content,
        headers:
          patch.headers !== undefined
            ? cipher.mergeHeaderUpdate(existing.headers, patch.headers)
            : existing.headers,
        updatedAt: now,
      };
      if (movedAddress && discarded) {
        log.warn(
          "mcp",
          `'${existing.name}' moved to ${updated.url}; its OAuth configuration was dropped and must be rediscovered`,
        );
      }
      // A new url or new credentials can mean a different tool list, so an
      // operator fixing a server must not have to wait out the discovery TTL on
      // the instance they are working against.
      probe.invalidateDiscovery(existing.url);
      probe.invalidateDiscovery(updated.url);
      return updated;
    },
  });

  return {
    ...registry,

    async testConnection(name) {
      const existing = await repo.get(name);
      if (!existing) {
        throw new NotFoundError(`MCP server not found: ${name}`);
      }
      // Same decision as the run path, from the same predicate: the console's
      // own test must reach what a run can, or a managed server looks broken in
      // the one place an operator checks it.
      const loopback = isManagedLoopback(existing);
      if (!loopback) {
        try {
          await policy.assertAllowed(existing.url);
        } catch (error) {
          return { ok: false, error: error instanceof BlockedUrlError ? error.message : "Blocked URL" };
        }
      }
      return probe.listTools(
        existing.url,
        cipher.decryptHeadersForOutbound(existing.headers),
        loopback,
      );
    },
  };
}

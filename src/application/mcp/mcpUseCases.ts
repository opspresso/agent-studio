import { isMcpSourceMappings } from "@/domain/mcp/sourceMapping";
import type { McpRepository } from "@/domain/mcp/repository";
import { skipsUrlGuard, type McpServer } from "@/domain/mcp/types";
import { ConflictError, NotFoundError, ValidationError } from "@/application/errors";
import { processManagedMcpLifecycleClaims } from "@/application/mcp/managedMcpUseCases";
import { applyMcpUserEmail, stripMcpMetadataHeaders } from "@/application/mcpMetadataHeaders";
import {
  assertAllowedUrl,
  assertCredentialFreeRegistryUrl,
  createRegistryUseCases,
  resolveRegistryUrlPatch,
  type RegistryUseCases,
} from "@/application/registry/registryUseCases";
import type { SecretCipher } from "@/domain/security/secretCipher";
import { BlockedUrlError, type UrlPolicy } from "@/domain/security/urlPolicy";
import type { ListToolsResult, McpToolProbe } from "@/domain/mcp/toolProbe";
import { log } from "@/shared/logger";
import { urlOriginForLog, urlWithoutQueryOrFragment } from "@/shared/url";
import {
  managedMcpEnvironmentContext,
  mcpHeadersContext,
  mcpOAuthClientSecretContext,
} from "@/domain/security/secretContext";

export interface CreateMcpInput {
  sourceOutputs?: McpServer["sourceOutputs"];
  name: string;
  url: string;
  description?: string;
  content?: string;
  /** Provenance for a sync-created entry; absent for one an operator registered. */
  source?: string;
  headers: Record<string, string>;
}

export interface UpdateMcpInput {
  sourceOutputs?: McpServer["sourceOutputs"];
  url?: string;
  description?: string;
  content?: string;
  headers?: Record<string, string>;
  /**
   * Provenance takeover — a sync adopting an entry another sync created. Only
   * the plugin sync passes this; the update route's schema does not accept it,
   * so an API caller cannot re-badge an entry.
   */
  source?: string;
}

export interface McpUseCases extends RegistryUseCases<McpServer, CreateMcpInput, UpdateMcpInput> {
  /** Connects with decrypted headers and an optional requesting user identity. */
  testConnection(name: string, userEmail?: string): Promise<ListToolsResult>;
}

/** Client-safe projection: encrypted secret values are replaced with a mask. */
function masked(cipher: SecretCipher, server: McpServer): McpServer {
  return {
    ...server,
    url: urlWithoutQueryOrFragment(server.url),
    headers: cipher.maskHeaders(server.headers, mcpHeadersContext(server.name)),
    ...(server.environment
      ? {
          environment: cipher.maskHeaders(
            server.environment,
            managedMcpEnvironmentContext(server.name),
          ),
        }
      : {}),
    ...(server.auth
      ? {
          auth: {
            ...server.auth,
            ...(server.auth.clientSecret
              ? {
                  clientSecret: cipher.mask(
                    server.auth.clientSecret,
                    mcpOAuthClientSecretContext(server.name),
                  ),
                }
              : {}),
          },
        }
      : {}),
  };
}

export function createMcpUseCases(
  repo: McpRepository,
  cipher: SecretCipher,
  policy: UrlPolicy,
  probe: McpToolProbe,
  /**
   * DNS suffixes this deployment declared internal. Registration has to honour
   * them too, not just dispatch — a URL the run path would happily call is of no
   * use if it cannot be saved.
   */
  internalHostSuffixes: readonly string[] = [],
  lifecycleClaims: Set<string> = processManagedMcpLifecycleClaims(),
): McpUseCases {
  const registry = createRegistryUseCases<McpServer, CreateMcpInput, UpdateMcpInput>({
    label: "MCP server",
    auditKind: "mcp",
    repo,
    view: (server) => masked(cipher, server),
    async build(input, now) {
      if (input.sourceOutputs !== undefined && !isMcpSourceMappings(input.sourceOutputs)) throw new ValidationError("Invalid MCP source mappings");
      assertCredentialFreeRegistryUrl(input.url);
      // A new entry is `remote` by definition — nothing has provisioned it — so
      // the only way past the guard here is a suffix this deployment declared.
      if (!skipsUrlGuard({ url: input.url }, internalHostSuffixes)) {
        await assertAllowedUrl(policy, input.url);
      }
      return {
        name: input.name,
        url: input.url,
        description: input.description,
        content: input.content,
        sourceOutputs: input.sourceOutputs,
        source: input.source,
        headers: cipher.encryptHeaders(input.headers, mcpHeadersContext(input.name)),
        createdAt: now,
        updatedAt: now,
      };
    },
    async apply(existing, patch, now) {
      if (patch.sourceOutputs !== undefined && !isMcpSourceMappings(patch.sourceOutputs)) throw new ValidationError("Invalid MCP source mappings");
      const patchedUrl =
        patch.url === undefined ? undefined : resolveRegistryUrlPatch(existing.url, patch.url);
      // The address this save moves to, or nothing. Only a change is checked:
      // re-submitting the stored one — verbatim, or as the redaction the
      // console shows — is not a registration, and refusing it would make a
      // legacy entry that predates the credential-free rule uneditable rather
      // than migratable.
      const movedTo = patchedUrl !== undefined && patchedUrl !== existing.url ? patchedUrl : undefined;
      const movedAddress = movedTo !== undefined;
      if (movedTo !== undefined) {
        assertCredentialFreeRegistryUrl(movedTo);
      }
      // A managed entry's address is the whole basis for trusting it: it was
      // recorded after the provisioner bound the port, not typed by anyone. An
      // edit that could move it would turn "we started this" back into "someone
      // said so", which is exactly the claim the loopback bypass must not rest
      // on. Managed rows are changed by the provisioner, not through here.
      if (existing.runtime === "managed" && movedAddress) {
        throw new ValidationError(
          `MCP server "${existing.name}" is managed: its address is set when the container starts and cannot be edited.`,
        );
      }
      // A managed entry's address is loopback by construction, was vetted when
      // the provisioner reported it, and cannot have moved — the check above
      // refuses that. Re-running the public-URL guard over it fails the save of
      // every *other* field, which is how editing a managed server's headers
      // became impossible.
      if (
        movedTo !== undefined &&
        !skipsUrlGuard({ url: movedTo }, internalHostSuffixes)
      ) {
        await assertAllowedUrl(policy, movedTo);
      }
      // Credentials belong to the address they were entered for. The OAuth
      // block was read out of the *old* address's well-known documents — its
      // `resource` names that server — and the stored headers carry secrets an
      // operator typed for that host. Carrying either across a move would send
      // the old host's credentials to whatever the new URL points at, which is
      // exactly the exfiltration a repo commit (or a typo) must not be able to
      // cause: the plugins sync moves URLs automatically, so the address is
      // only as trusted as the last writer of the repository. Both are dropped
      // instead, the state a freshly registered entry is already in. Masked
      // header echoes cannot resurrect the old secrets either — against an
      // empty base, a mask confirms nothing; only a value typed in the same
      // save survives the move.
      const { auth: discarded, ...withoutAuth } = existing;
      const updated: McpServer = {
        ...(movedAddress ? withoutAuth : existing),
        url: patchedUrl ?? existing.url,
        description: patch.description ?? existing.description,
        content: patch.content ?? existing.content,
        sourceOutputs: patch.sourceOutputs ?? existing.sourceOutputs,
        source: patch.source ?? existing.source,
        headers: movedAddress
          ? cipher.mergeHeaderUpdate({}, patch.headers ?? {}, mcpHeadersContext(existing.name))
          : patch.headers !== undefined
            ? cipher.mergeHeaderUpdate(
                existing.headers,
                patch.headers,
                mcpHeadersContext(existing.name),
              )
            : existing.headers,
        updatedAt: now,
      };
      if (movedAddress && (discarded || Object.keys(existing.headers).length > 0)) {
        log.warn(
          "mcp",
          `'${existing.name}' moved to ${urlOriginForLog(updated.url)}; its stored credentials were dropped and must be re-entered`,
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

    async update(name, input) {
      // Metadata writes share the container's claim too: a restart persists
      // its snapshot after starting and must not overwrite a concurrent edit.
      if (lifecycleClaims.has(name)) {
        throw new ConflictError(`A lifecycle operation for "${name}" is already running.`);
      }
      lifecycleClaims.add(name);
      try {
        return await registry.update(name, input);
      } finally {
        lifecycleClaims.delete(name);
      }
    },

    async remove(name, actorEmail) {
      if (lifecycleClaims.has(name)) {
        throw new ConflictError(`A lifecycle operation for "${name}" is already running.`);
      }
      lifecycleClaims.add(name);
      try {
        if ((await repo.get(name))?.runtime === "managed") {
          throw new ValidationError(
            `MCP server "${name}" is managed: delete it through the managed lifecycle so its container is stopped.`,
          );
        }
        await registry.remove(name, actorEmail);
      } finally {
        lifecycleClaims.delete(name);
      }
    },

    async testConnection(name, userEmail) {
      const existing = await repo.get(name);
      if (!existing) {
        throw new NotFoundError(`MCP server not found: ${name}`);
      }
      // Same decision as the run path, from the same predicate: the console's
      // own test must reach what a run can, or a managed server looks broken in
      // the one place an operator checks it.
      const loopback = skipsUrlGuard(existing, internalHostSuffixes);
      if (!loopback) {
        try {
          await policy.assertAllowed(existing.url);
        } catch (error) {
          return { ok: false, error: error instanceof BlockedUrlError ? error.message : "Blocked URL" };
        }
      }
      const headers = cipher.decryptHeadersForOutbound(
        existing.headers,
        mcpHeadersContext(existing.name),
      );
      // A registry entry's stored spelling of a reserved metadata header does
      // not ride this probe impersonating a project, user, or conversation.
      stripMcpMetadataHeaders(headers);
      applyMcpUserEmail(headers, userEmail);
      return probe.listTools(existing.url, headers, loopback);
    },
  };
}

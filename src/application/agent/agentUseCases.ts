import type { ExternalAgentRepository } from "@/domain/agent/repository";
import type { AgentProtocol, ExternalAgent } from "@/domain/agent/types";
import { NotFoundError } from "@/application/errors";
import {
  assertAllowedUrl,
  assertCredentialFreeRegistryUrl,
  createRegistryUseCases,
  resolveRegistryUrlPatch,
  type RegistryUseCases,
} from "@/application/registry/registryUseCases";
import { BlockedUrlError, type UrlPolicy } from "@/domain/security/urlPolicy";
import type { SecretCipher } from "@/domain/security/secretCipher";
import type { RemoteAgentDispatcher, RemoteAgentProbeReply } from "@/domain/agent/dispatcher";
import { urlWithoutQueryOrFragment } from "@/shared/url";
import { externalAgentHeadersContext } from "@/domain/security/secretContext";

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
  sendMessage(name: string, message: string): Promise<RemoteAgentProbeReply>;
}

/** Client-safe projection: encrypted header values are replaced with a mask. */
function masked(cipher: SecretCipher, agent: ExternalAgent): ExternalAgent {
  return {
    ...agent,
    url: urlWithoutQueryOrFragment(agent.url),
    headers: cipher.maskHeaders(agent.headers, externalAgentHeadersContext(agent.name)),
  };
}

export function createAgentUseCases(
  repo: ExternalAgentRepository,
  cipher: SecretCipher,
  policy: UrlPolicy,
  dispatcher: RemoteAgentDispatcher,
): AgentUseCases {
  const registry = createRegistryUseCases<ExternalAgent, CreateAgentInput, UpdateAgentInput>({
    label: "External agent",
    auditKind: "agent",
    repo,
    view: (agent) => masked(cipher, agent),
    async build(input, now) {
      assertCredentialFreeRegistryUrl(input.url);
      await assertAllowedUrl(policy, input.url);
      return {
        name: input.name,
        url: input.url,
        ...(input.protocol ? { protocol: input.protocol } : {}),
        description: input.description,
        headers: cipher.encryptHeaders(input.headers, externalAgentHeadersContext(input.name)),
        createdAt: now,
        updatedAt: now,
      };
    },
    async apply(existing, patch, now) {
      const patchedUrl =
        patch.url === undefined ? undefined : resolveRegistryUrlPatch(existing.url, patch.url);
      // Only an address that actually changes is checked. Re-submitting the
      // stored one — whether verbatim or as the redaction the console shows —
      // is not a registration, and refusing it would make a legacy entry that
      // predates the credential-free rule uneditable rather than migratable.
      const movedTo = patchedUrl !== undefined && patchedUrl !== existing.url ? patchedUrl : undefined;
      const movedAddress = movedTo !== undefined;
      if (movedTo !== undefined) {
        assertCredentialFreeRegistryUrl(movedTo);
        await assertAllowedUrl(policy, movedTo);
      }
      return {
        ...existing,
        url: patchedUrl ?? existing.url,
        protocol: patch.protocol ?? existing.protocol,
        description: patch.description ?? existing.description,
        headers: movedAddress
          ? cipher.mergeHeaderUpdate(
              {},
              patch.headers ?? {},
              externalAgentHeadersContext(existing.name),
            )
          : patch.headers !== undefined
            ? cipher.mergeHeaderUpdate(
                existing.headers,
                patch.headers,
                externalAgentHeadersContext(existing.name),
              )
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
      return dispatcher.probe(
        {
          url: existing.url,
          protocol: existing.protocol,
          headers: cipher.decryptHeadersForOutbound(
            existing.headers,
            externalAgentHeadersContext(existing.name),
          ),
        },
        message,
      );
    },
  };
}

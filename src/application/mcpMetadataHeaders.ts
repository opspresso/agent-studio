/**
 * The metadata headers this platform reserves on every outbound MCP request:
 * who is calling (`X-Tenant-Id`), for whom (`X-User-Email`), and in which
 * conversation (`X-Conversation-Id`). Reserved means stored configuration —
 * a registry entry's headers, an Agent's overrides — can never supply them:
 * every stored spelling is stripped before any decision reads the header map,
 * and the platform's own values are stamped afterwards. One module owns the
 * spellings, the strip, and the actor-to-email judgement, so a run and every
 * probe present the same identity contract to the same server.
 */

import type { RunActor } from "@/domain/execution/actor";

/**
 * The header every MCP request names its calling project with — the project
 * name, as a tenant id.
 *
 * The platform's own metadata, in the spirit of the protocol's `Mcp-Method` /
 * `Mcp-Name`: derived from context, sent unconditionally, ignored by a server
 * that does not read it — and outside the `Mcp-` namespace because it is not
 * the protocol's. A multi-tenant server (mcp-memory) scopes its data by it
 * without any per-project registration.
 *
 * The generic name is deliberate, both halves of it. What the header carries
 * is a tenancy fact, not branding — a vendor-named header would have to chase
 * every product rename while meaning exactly the same thing — and the cost a
 * generic name buys into is accepted with eyes open: a third-party server that
 * already treats `X-Tenant-Id` as its tenancy switch will act on ours, which
 * is the behaviour wanted from a server that understands it at all.
 *
 * Applied at assembly rather than in the session, which has no project to know
 * about — and riding in the session's header map is also what keys the
 * discovery cache per project, so a server free to expose different tools per
 * tenant is cached per tenant. The catalog probe and "Test connection" carry
 * no project and therefore no header; a server that requires one refuses those
 * listings and is indexed at server level only, which the reindex reports.
 */
export const TENANT_ID_HEADER = "X-Tenant-Id";

/**
 * The header a request names its user with — the delegated identity an MCP
 * server may scope per-user permissions by (Agent Memory does). Carried by
 * `user` and `project-token` actors, whose ids are emails, and by surfaces
 * that resolve an address separately from a non-email actor (Slack). Not a
 * credential: the server must pair it with its own Bearer token or OAuth
 * grant before trusting it. Rides the session's identity map like the tenant,
 * so a server free to expose different tools per user is cached per user.
 */
export const USER_EMAIL_HEADER = "X-User-Email";

/**
 * The header every MCP request names its conversation with — the run's
 * `conversationKey`, when the surface has one.
 *
 * Same family as {@link TENANT_ID_HEADER} and the same reasoning for the
 * generic name, with one deliberate difference in how it travels: it is a
 * **request** fact rather than an identity one, so it rides
 * `McpServerConfig.contextHeaders` and is stamped on every request *without*
 * keying the discovery cache. A tenant or a user decides which tools a server
 * exposes; a conversation never does, and putting it in the identity map would
 * pay a full discovery per thread for a catalogue that has not changed.
 *
 * What a server may do with it: a memory server can tell working notes for
 * one thread from knowledge shared by the project, and any stateful server can
 * keep per-conversation context. What it must not do is treat it as
 * authorization — like its siblings, it authenticates nothing.
 *
 * Absent when the run has no conversation (a firing, an API call that sent no
 * `X-Conversation-Id`) and on the catalog probe and "Test connection", which
 * have no run.
 */
export const CONVERSATION_ID_HEADER = "X-Conversation-Id";

const RESERVED_NAMES = new Set(
  [TENANT_ID_HEADER, USER_EMAIL_HEADER, CONVERSATION_ID_HEADER].map((name) => name.toLowerCase()),
);

/**
 * Remove every stored spelling of the reserved metadata headers.
 *
 * Called once per header assembly, on the merged registry/binding map and
 * **before** the OAuth availability check reads it: a stored metadata header
 * must never count as "a way to authenticate" a server whose connection is
 * unavailable, and must never reach the server impersonating another project,
 * user, or conversation — fetch folds two case-variants into one comma-joined
 * value that reads as neither. The platform's own values are applied after the
 * check, by the assembly site.
 */
export function stripMcpMetadataHeaders(headers: Record<string, string>): void {
  for (const name of Object.keys(headers)) {
    if (RESERVED_NAMES.has(name.toLowerCase())) {
      delete headers[name];
    }
  }
}

function normalizedEmail(value: string | undefined): string | undefined {
  const email = value?.trim().toLowerCase();
  return email || undefined;
}

/**
 * The user a run presents to MCP servers. An email-shaped actor (`user`,
 * `project-token`) is its own answer; otherwise the surface's separately
 * resolved address (Slack's profile lookup) stands in, and a surface with
 * neither presents nobody.
 */
export function mcpUserEmail(
  actor: RunActor | undefined,
  resolvedUserEmail?: string,
): string | undefined {
  if (actor?.kind === "user" || actor?.kind === "project-token") {
    return normalizedEmail(actor.id);
  }
  return normalizedEmail(resolvedUserEmail);
}

/**
 * Stamp the platform's user identity onto an assembled header map. Assumes
 * {@link stripMcpMetadataHeaders} already ran on the merged stored headers;
 * with no email this stamps nothing, leaving the header absent.
 */
export function applyMcpUserEmail(
  headers: Record<string, string>,
  email: string | undefined,
): void {
  const normalized = normalizedEmail(email);
  if (normalized) {
    headers[USER_EMAIL_HEADER] = normalized;
  }
}

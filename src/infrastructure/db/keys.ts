/**
 * Single-table key builders. Never hand-write key strings outside this module.
 * See docs/ARCHITECTURE.md for the full key map.
 *
 * **Every tenant-scoped builder takes the tenant first.** It is a parameter
 * rather than something this module reads for itself, because a key is the only
 * thing standing between two tenants: read implicitly, a forgotten scope is a
 * cross-tenant read that looks exactly like a working query. Read explicitly, it
 * is a type error, and `tests/architecture.test.ts` fails any builder that
 * stops taking one.
 *
 * The rows that are *not* tenant-scoped are named in `UNSCOPED_KEYS` there, and
 * each is a decision rather than an omission: Better Auth's user rows (a person
 * is not a tenant's property and may belong to several), the app-wide settings
 * row (infrastructure this process is bound to — a tenant layer over it is its
 * own milestone), and the organization registry itself, which is the thing that
 * says what tenants exist.
 */

import { DEFAULT_TENANT } from "@/shared/tenantContext";

/**
 * The prefix a tenant's rows carry.
 *
 * The default tenant's is **empty**, which is the whole migration story: a
 * deployment that has always been single-tenant keeps every key it already
 * wrote, and adopting this scheme costs it nothing. A named tenant's rows sit
 * behind `T#{id}#`, so two tenants' identically-named projects cannot collide —
 * neither in a partition key nor in a GSI partition, which is where a scheme
 * that only scoped the primary key would leak.
 *
 * `scripts/retenant-table.ts` is what moves a default-tenant deployment onto a
 * named tenant when it wants one; nothing does it implicitly.
 */
function scope(tenant: string): string {
  return tenant === DEFAULT_TENANT ? "" : `T#${tenant}#`;
}

export const keys = {
  // --- Not tenant-scoped (see the module note) -------------------------------
  auth: (model: string, id: string) => ({ PK: `AUTH#${model}#${id}`, SK: "ITEM" }),
  authModelPartition: (model: string) => `AUTH#${model}`,
  authUniqueLookup: (model: string, field: string, value: string) =>
    `AUTH#${model}#${field}#${value}`,
  authUnique: (model: string, field: string, value: string) => ({
    PK: `AUTHUNIQUE#${model}#${field}#${value}`,
    SK: "LOCK",
  }),

  settings: () => ({ PK: "SETTINGS#app", SK: "META" }),

  /**
   * One workspace's settings. A distinct name from the app row rather than a
   * scoped copy of it: the default tenant's prefix is empty, so
   * `SETTINGS#app` under a scope would *be* the app row.
   */
  tenantSettings: (tenant: string) => ({
    PK: `${scope(tenant)}SETTINGS#workspace`,
    SK: "META",
  }),

  /** A tenant. Outside every tenant's scope, because it is what names them. */
  organization: (id: string) => ({ PK: `ORG#${id}`, SK: "META" }),
  organizationPartition: () => "TYPE#ORG",
  /**
   * One person's place in one tenant. In the organization's partition, so a
   * tenant's members are one query — and outside tenant scope like the
   * organization itself, because this is what *decides* the scope.
   */
  membership: (organizationId: string, userEmail: string) => ({
    PK: `ORG#${organizationId}`,
    SK: `MEMBER#${userEmail}`,
  }),
  membershipPrefix: () => "MEMBER#",
  /** The reverse: every tenant one person belongs to, read on each request. */
  membershipUserPartition: (userEmail: string) => `MEMBEROF#${userEmail}`,

  // --- Tenant-scoped ---------------------------------------------------------
  project: (tenant: string, name: string) => ({
    PK: `${scope(tenant)}PROJECT#${name}`,
    SK: "META",
  }),
  projectPartition: (tenant: string, name: string) => `${scope(tenant)}PROJECT#${name}`,
  projectApiToken: (tenant: string, name: string) => ({
    PK: `${scope(tenant)}PROJECT#${name}`,
    SK: "APITOKEN",
  }),
  version: (tenant: string, projectName: string, versionName: string) => ({
    PK: `${scope(tenant)}PROJECT#${projectName}`,
    SK: `VERSION#${versionName}`,
  }),
  versionPrefix: () => "VERSION#",

  chat: (tenant: string, chatId: string) => ({ PK: `${scope(tenant)}CHAT#${chatId}`, SK: "META" }),
  chatMessage: (tenant: string, chatId: string, seq: number) => ({
    PK: `${scope(tenant)}CHAT#${chatId}`,
    SK: `MSG#${String(seq).padStart(6, "0")}`,
  }),
  chatMessagePrefix: () => "MSG#",
  chatOwnerPartition: (tenant: string, email: string) => `${scope(tenant)}CHATOWNER#${email}`,

  /**
   * One audited act, partitioned by the UTC day it happened on. Written far
   * more often than it is read, so the key bounds the write partition and a
   * reader assembles a range from the days in it — no index, because nothing
   * asks a second question of these rows.
   */
  auditEvent: (tenant: string, day: string, createdAt: string, id: string) => ({
    PK: `${scope(tenant)}AUDIT#${day}`,
    SK: `EVENT#${createdAt}#${id}`,
  }),
  auditDayPartition: (tenant: string, day: string) => `${scope(tenant)}AUDIT#${day}`,

  skill: (tenant: string, name: string) => ({ PK: `${scope(tenant)}SKILL#${name}`, SK: "META" }),
  mcp: (tenant: string, name: string) => ({ PK: `${scope(tenant)}MCP#${name}`, SK: "META" }),
  externalAgent: (tenant: string, name: string) => ({
    PK: `${scope(tenant)}AGENT#${name}`,
    SK: "META",
  }),

  /**
   * A project's triggers and their delivery history, both in the project
   * partition — so the project cascade delete already removes them, and a
   * trigger's runs list is one `begins_with` query.
   */
  trigger: (tenant: string, projectName: string, triggerId: string) => ({
    PK: `${scope(tenant)}PROJECT#${projectName}`,
    SK: `TRIGGER#${triggerId}`,
  }),
  triggerPrefix: () => "TRIGGER#",
  /**
   * The cross-project schedule listing a scan tick walks. Only schedule rows
   * carry these GSI1 attributes; webhook rows stay invisible to the index.
   */
  scheduleIndex: (tenant: string, projectName: string, triggerId: string) => ({
    GSI1PK: keys.typePartition(tenant, "SCHEDULE"),
    GSI1SK: `${projectName}#${triggerId}`,
  }),
  triggerRun: (
    tenant: string,
    projectName: string,
    triggerId: string,
    startedAt: string,
    runId: string,
  ) => ({
    PK: `${scope(tenant)}PROJECT#${projectName}`,
    SK: `TRIGGERRUN#${triggerId}#${startedAt}#${runId}`,
  }),
  triggerRunPrefix: (triggerId: string) => `TRIGGERRUN#${triggerId}#`,
  /**
   * A delivery's idempotency claim. Its own partition because the key is an
   * arbitrary caller-supplied string, which has no business in the project
   * partition's sort-key space.
   */
  triggerIdempotency: (tenant: string, projectName: string, triggerId: string, key: string) => ({
    PK: `${scope(tenant)}TRIGGERIDEM#${projectName}#${triggerId}#${key}`,
    SK: "META",
  }),

  /** A project's OAuth connection to one registry MCP server. */
  mcpConnection: (tenant: string, projectName: string, serverName: string) => ({
    PK: `${scope(tenant)}PROJECT#${projectName}`,
    SK: `MCPCONN#${serverName}`,
  }),
  mcpConnectionPrefix: () => "MCPCONN#",
  /** An authorization in flight, keyed by the opaque `state` it was started with. */
  mcpOAuthState: (tenant: string, state: string) => ({
    PK: `${scope(tenant)}MCPOAUTH#${state}`,
    SK: "META",
  }),

  usage: (tenant: string, projectName: string, date: string) => ({
    PK: `${scope(tenant)}USAGE#${projectName}`,
    SK: `DATE#${date}`,
  }),
  usageDatePartition: (tenant: string, date: string) => `${scope(tenant)}USAGEDATE#${date}`,
  /**
   * Per-caller daily usage, in the project's usage partition. Date leads the
   * sort key so a range query over dates is one `BETWEEN`, and so the rows of
   * one day sit together; `DATE#` and `ACTOR#` are distinct prefixes, so the
   * project totals above are never swept up by an actor query or vice versa.
   */
  usageActor: (tenant: string, projectName: string, date: string, actor: string) => ({
    PK: `${scope(tenant)}USAGE#${projectName}`,
    SK: `ACTOR#${date}#${actor}`,
  }),
  usageActorPrefix: (date: string) => `ACTOR#${date}`,

  /**
   * One in-flight run's concurrency slot for one caller. All of a caller's
   * slots share a partition so the live ones can be read in a single query.
   *
   * Scoped like everything else: a trigger's actor id is `{project}:{trigger}`,
   * so two tenants with the same project name would otherwise share one
   * caller's concurrency budget.
   */
  runSlot: (tenant: string, actor: string, index: number) => ({
    PK: `${scope(tenant)}RUNSLOT#${actor}`,
    SK: `SLOT#${String(index).padStart(3, "0")}`,
  }),
  runSlotPartition: (tenant: string, actor: string) => `${scope(tenant)}RUNSLOT#${actor}`,

  slackEvent: (tenant: string, eventId: string) => ({
    PK: `${scope(tenant)}SLACKEVENT#${eventId}`,
    SK: "META",
  }),

  a2aTask: (tenant: string, projectName: string, taskId: string) => ({
    PK: `${scope(tenant)}A2ATASK#${projectName}#${taskId}`,
    SK: "META",
  }),

  trace: (tenant: string, traceId: string) => ({
    PK: `${scope(tenant)}TRACE#${traceId}`,
    SK: "META",
  }),
  traceRef: (tenant: string, projectName: string, createdAt: string, traceId: string) => ({
    PK: `${scope(tenant)}PROJECT#${projectName}`,
    SK: `TRACE#${createdAt}#${traceId}`,
  }),
  traceProjectPartition: (tenant: string, projectName: string) =>
    `${scope(tenant)}TRACEPROJECT#${projectName}`,

  typePartition: (
    tenant: string,
    entityType: "PROJECT" | "SKILL" | "MCP" | "AGENT" | "SCHEDULE",
  ) => `${scope(tenant)}TYPE#${entityType}`,
} as const;

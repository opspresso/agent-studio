/**
 * Single-table key builders. Never hand-write key strings outside this module.
 * See docs/ARCHITECTURE.md for the full key map.
 */

export const keys = {
  auth: (model: string, id: string) => ({ PK: `AUTH#${model}#${id}`, SK: "ITEM" }),
  authModelPartition: (model: string) => `AUTH#${model}`,
  authUniqueLookup: (model: string, field: string, value: string) =>
    `AUTH#${model}#${field}#${value}`,
  authUnique: (model: string, field: string, value: string) => ({
    PK: `AUTHUNIQUE#${model}#${field}#${value}`,
    SK: "LOCK",
  }),

  project: (name: string) => ({ PK: `PROJECT#${name}`, SK: "META" }),
  projectPartition: (name: string) => `PROJECT#${name}`,
  projectApiToken: (name: string) => ({ PK: `PROJECT#${name}`, SK: "APITOKEN" }),
  version: (projectName: string, versionName: string) => ({
    PK: `PROJECT#${projectName}`,
    SK: `VERSION#${versionName}`,
  }),
  versionPrefix: () => "VERSION#",

  chat: (chatId: string) => ({ PK: `CHAT#${chatId}`, SK: "META" }),
  chatMessage: (chatId: string, seq: number) => ({
    PK: `CHAT#${chatId}`,
    SK: `MSG#${String(seq).padStart(6, "0")}`,
  }),
  chatMessagePrefix: () => "MSG#",
  chatOwnerPartition: (email: string) => `CHATOWNER#${email}`,

  settings: () => ({ PK: "SETTINGS#app", SK: "META" }),

  skill: (name: string) => ({ PK: `SKILL#${name}`, SK: "META" }),
  mcp: (name: string) => ({ PK: `MCP#${name}`, SK: "META" }),
  externalAgent: (name: string) => ({ PK: `AGENT#${name}`, SK: "META" }),

  /**
   * A project's triggers and their delivery history, both in the project
   * partition — so the project cascade delete already removes them, and a
   * trigger's runs list is one `begins_with` query.
   */
  trigger: (projectName: string, triggerId: string) => ({
    PK: `PROJECT#${projectName}`,
    SK: `TRIGGER#${triggerId}`,
  }),
  triggerPrefix: () => "TRIGGER#",
  /**
   * The cross-project schedule listing a scan tick walks. Only schedule rows
   * carry these GSI1 attributes; webhook rows stay invisible to the index.
   */
  scheduleIndex: (projectName: string, triggerId: string) => ({
    GSI1PK: keys.typePartition("SCHEDULE"),
    GSI1SK: `${projectName}#${triggerId}`,
  }),
  triggerRun: (projectName: string, triggerId: string, startedAt: string, runId: string) => ({
    PK: `PROJECT#${projectName}`,
    SK: `TRIGGERRUN#${triggerId}#${startedAt}#${runId}`,
  }),
  triggerRunPrefix: (triggerId: string) => `TRIGGERRUN#${triggerId}#`,
  /**
   * A delivery's idempotency claim. Its own partition because the key is an
   * arbitrary caller-supplied string, which has no business in the project
   * partition's sort-key space.
   */
  triggerIdempotency: (projectName: string, triggerId: string, key: string) => ({
    PK: `TRIGGERIDEM#${projectName}#${triggerId}#${key}`,
    SK: "META",
  }),

  /** A project's OAuth connection to one registry MCP server. */
  mcpConnection: (projectName: string, serverName: string) => ({
    PK: `PROJECT#${projectName}`,
    SK: `MCPCONN#${serverName}`,
  }),
  mcpConnectionPrefix: () => "MCPCONN#",
  /** An authorization in flight, keyed by the opaque `state` it was started with. */
  mcpOAuthState: (state: string) => ({ PK: `MCPOAUTH#${state}`, SK: "META" }),

  usage: (projectName: string, date: string) => ({
    PK: `USAGE#${projectName}`,
    SK: `DATE#${date}`,
  }),
  usageDatePartition: (date: string) => `USAGEDATE#${date}`,
  /**
   * Per-caller daily usage, in the project's usage partition. Date leads the
   * sort key so a range query over dates is one `BETWEEN`, and so the rows of
   * one day sit together; `DATE#` and `ACTOR#` are distinct prefixes, so the
   * project totals above are never swept up by an actor query or vice versa.
   */
  usageActor: (projectName: string, date: string, actor: string) => ({
    PK: `USAGE#${projectName}`,
    SK: `ACTOR#${date}#${actor}`,
  }),
  usageActorPrefix: (date: string) => `ACTOR#${date}`,

  /**
   * One in-flight run's concurrency slot for one caller. All of a caller's
   * slots share a partition so the live ones can be read in a single query.
   */
  runSlot: (actor: string, index: number) => ({
    PK: `RUNSLOT#${actor}`,
    SK: `SLOT#${String(index).padStart(3, "0")}`,
  }),
  runSlotPartition: (actor: string) => `RUNSLOT#${actor}`,

  slackEvent: (eventId: string) => ({ PK: `SLACKEVENT#${eventId}`, SK: "META" }),

  a2aTask: (projectName: string, taskId: string) => ({
    PK: `A2ATASK#${projectName}#${taskId}`,
    SK: "META",
  }),

  /**
   * Audit records, partitioned by the UTC day they happened on. A day at a time
   * is how they are read, and it keeps every sensitive act of the deployment's
   * whole history from appending to one partition — the same reason usage rows
   * are keyed by date.
   */
  auditEvent: (day: string, createdAt: string, eventId: string) => ({
    PK: `AUDIT#${day}`,
    SK: `${createdAt}#${eventId}`,
  }),
  auditDayPartition: (day: string) => `AUDIT#${day}`,

  trace: (traceId: string) => ({ PK: `TRACE#${traceId}`, SK: "META" }),
  traceRef: (projectName: string, createdAt: string, traceId: string) => ({
    PK: `PROJECT#${projectName}`,
    SK: `TRACE#${createdAt}#${traceId}`,
  }),
  traceProjectPartition: (projectName: string) => `TRACEPROJECT#${projectName}`,

  typePartition: (entityType: "PROJECT" | "SKILL" | "MCP" | "AGENT" | "SCHEDULE") =>
    `TYPE#${entityType}`,
} as const;

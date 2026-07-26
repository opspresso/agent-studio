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

  slackEvent: (eventId: string) => ({ PK: `SLACKEVENT#${eventId}`, SK: "META" }),

  a2aTask: (projectName: string, taskId: string) => ({
    PK: `A2ATASK#${projectName}#${taskId}`,
    SK: "META",
  }),

  trace: (traceId: string) => ({ PK: `TRACE#${traceId}`, SK: "META" }),
  traceRef: (projectName: string, createdAt: string, traceId: string) => ({
    PK: `PROJECT#${projectName}`,
    SK: `TRACE#${createdAt}#${traceId}`,
  }),
  traceProjectPartition: (projectName: string) => `TRACEPROJECT#${projectName}`,

  typePartition: (entityType: "PROJECT" | "SKILL" | "MCP" | "AGENT") => `TYPE#${entityType}`,
} as const;

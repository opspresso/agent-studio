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
  /**
   * A batch of a run's stream, kept just long enough for a reader that lost the
   * connection to catch up. Padded like `chatMessage` so the sort order is the
   * arrival order past the 9→10 boundary.
   */
  chatRunLog: (chatId: string, runId: string, seq: number) => ({
    PK: `CHAT#${chatId}`,
    SK: `RUNLOG#${runId}#${String(seq).padStart(6, "0")}`,
  }),
  /**
   * Sort-key bounds for reading one run's log from `fromSeq` on. A range rather
   * than a `begins_with` prefix, because a tail asks for what it has not seen —
   * `999999` is the widest a six-digit sequence can be.
   */
  chatRunLogRange: (runId: string, fromSeq: number) => ({
    from: `RUNLOG#${runId}#${String(fromSeq).padStart(6, "0")}`,
    to: `RUNLOG#${runId}#999999`,
  }),

  settings: () => ({ PK: "SETTINGS#app", SK: "META" }),

  skill: (name: string) => ({ PK: `SKILL#${name}`, SK: "META" }),
  mcp: (name: string) => ({ PK: `MCP#${name}`, SK: "META" }),
  externalAgent: (name: string) => ({ PK: `AGENT#${name}`, SK: "META" }),
  /** An installed Agent Plugins package. The name may contain periods — inert in a key. */
  plugin: (name: string) => ({ PK: `PLUGIN#${name}`, SK: "META" }),
  /** The last plugins-sync report for one source repo, and the sync's lease. */
  pluginSyncReport: (repo: string) => ({ PK: `PLUGINSYNC#${repo}`, SK: "REPORT" }),
  pluginSyncLock: (repo: string) => ({ PK: `PLUGINSYNC#${repo}`, SK: "LOCK" }),

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
  /**
   * The once-per-month notification claims for the monthly cost thresholds.
   * Its own row rather than a marker on a daily row, because the instances
   * crossing the threshold on different days read different daily rows.
   */
  usageMonthClaim: (projectName: string, month: string) => ({
    PK: `USAGE#${projectName}`,
    SK: `MONTHCLAIM#${month}`,
  }),
  usageDatePartition: (date: string) => `USAGEDATE#${date}`,
  /**
   * One member's cross-project spend for one UTC day — their own console runs
   * (`user:` actors), which is what the tier cost cap bounds. A project
   * token's spend deliberately stays out (it is bounded by the project's own
   * limits; see `memberEmailFromActorKey`). Its own partition because no
   * project's cascade delete may take a person's history with it.
   *
   * Daily rather than monthly, and for the same reason the project rows are:
   * one shape answers both readers. The cap sums the month from `MONTH-01` to
   * today, exactly as the project guard does over `USAGE#{project}`, and the
   * profile page reads whatever window its date picker names — a month
   * aggregate could only have answered the first, and keeping both would be
   * two running totals of the same spend.
   *
   * The project is part of the sort key rather than collapsed into the row,
   * so a person can be shown *where* their spend went as well as on which
   * model. Date leads it so a window is still one `BETWEEN`; the cap simply
   * sums every row the window returns, which it did before this split too.
   */
  usageMember: (email: string, date: string, projectName: string) => ({
    PK: `USAGEMEMBER#${email}`,
    SK: `DATE#${date}#${projectName}`,
  }),
  usageMemberPartition: (email: string) => `USAGEMEMBER#${email}`,
  usageMemberPrefix: (date: string) => `DATE#${date}`,
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

  /**
   * One Telegram update delivered to one project's bot, and one album (a
   * `media_group_id`) the bot answers once. In the project partition so the
   * cascade delete takes them; qualified by bot because an `update_id` is a
   * counter per bot, and a project may change bots.
   */
  telegramUpdate: (projectName: string, botId: number | string, updateId: number | string) => ({
    PK: `PROJECT#${projectName}`,
    SK: `TELEGRAMUPDATE#${botId}#${updateId}`,
  }),
  telegramAlbum: (projectName: string, botId: number | string, mediaGroupId: string) => ({
    PK: `PROJECT#${projectName}`,
    SK: `TELEGRAMALBUM#${botId}#${mediaGroupId}`,
  }),

  /**
   * One Bot Framework activity delivered to one project's Teams bot. In the
   * project partition, qualified by app id, for the reasons the Telegram
   * update is; the id the caller passes is `{conversationId}#{activityId}`,
   * because an activity id is unique only within its conversation.
   */
  teamsActivity: (projectName: string, appId: string, conversationAndActivityId: string) => ({
    PK: `PROJECT#${projectName}`,
    SK: `TEAMSACTIVITY#${appId}#${conversationAndActivityId}`,
  }),

  /**
   * What a chat-bot surface remembers of one conversation. In the project
   * partition so the cascade delete takes it — a deleted project must not
   * leave a week of somebody's messages behind — and one turn per row so a
   * long conversation never rewrites a growing item; the newest turns are one
   * bounded query on the sort-key prefix, newest first.
   */
  transcriptTurnPrefix: (projectName: string, conversationKey: string) => ({
    PK: `PROJECT#${projectName}`,
    prefix: `TRANSCRIPT#${conversationKey}#TURN#`,
  }),
  transcriptTurn: (projectName: string, conversationKey: string, createdAt: string, seq: string) => ({
    PK: `PROJECT#${projectName}`,
    SK: `TRANSCRIPT#${conversationKey}#TURN#${createdAt}#${seq}`,
  }),

  /**
   * A channel thread this project's bot is engaged in. Point-read only — the
   * gate asks about one thread — so the whole address is the partition and
   * nothing ever queries across them.
   */
  slackThread: (projectName: string, channel: string, threadTs: string) => ({
    PK: `SLACKTHREAD#${projectName}#${channel}#${threadTs}`,
    SK: "META",
  }),

  a2aTask: (projectName: string, taskId: string) => ({
    PK: `A2ATASK#${projectName}#${taskId}`,
    SK: "META",
  }),

  /**
   * The remote `contextId` an external agent holds for one of this project's
   * conversations. In the project partition so the cascade delete takes it;
   * point-read only, so the whole triple is the sort key.
   */
  remoteConversation: (projectName: string, agentName: string, conversationKey: string) => ({
    PK: `PROJECT#${projectName}`,
    SK: `REMOTECTX#${agentName}#${conversationKey}`,
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

  /**
   * What a run produced. Two indexes, because each reaches rows the other
   * cannot: a Slack, A2A or trigger run names no email, so the project index is
   * the only way those are ever listed or deleted; and projects are a shared
   * catalog, so the owner index is the only way a person finds their own work
   * without reading someone else's project.
   */
  artifact: (artifactId: string) => ({ PK: `ARTIFACT#${artifactId}`, SK: "META" }),
  artifactProjectPartition: (projectName: string) => `ARTIFACTPROJECT#${projectName}`,
  /** Sparse: only rows whose actor names an email carry the GSI2 attributes. */
  artifactOwnerPartition: (email: string) => `ARTIFACTOWNER#${email}`,

  trace: (traceId: string) => ({ PK: `TRACE#${traceId}`, SK: "META" }),
  traceRef: (projectName: string, createdAt: string, traceId: string) => ({
    PK: `PROJECT#${projectName}`,
    SK: `TRACE#${createdAt}#${traceId}`,
  }),
  traceProjectPartition: (projectName: string) => `TRACEPROJECT#${projectName}`,

  /** A named inbound-A2A client key. */
  a2aClientKey: (name: string) => ({ PK: `A2ACLIENT#${name}`, SK: "META" }),
  /**
   * The verification row: the key value's SHA-256 → the client name. Its own
   * item so the hot path (every inbound A2A request) is one GetItem rather
   * than a list-and-compare over every registered client.
   */
  a2aClientKeyHash: (tokenHash: string) => ({ PK: `A2AKEYHASH#${tokenHash}`, SK: "META" }),

  typePartition: (
    entityType: "PROJECT" | "SKILL" | "MCP" | "AGENT" | "PLUGIN" | "SCHEDULE" | "A2ACLIENT",
  ) => `TYPE#${entityType}`,
} as const;

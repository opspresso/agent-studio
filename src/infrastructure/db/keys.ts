/**
 * Item-store key builders: the partition/sort address of every row. Never hand-write key strings outside this module.
 * See docs/ARCHITECTURE.md for the full key map.
 */

/** The widest sequence a six-digit message sort key can hold. */
export const CHAT_MESSAGE_MAX_SEQ = 999999;
export const TELEGRAM_DESTINATION_INDEX_PREFIX = "TELEGRAMDESTINATION#";

export const keys = {
  workspace: (id: string) => ({ PK: `WORKSPACE#${id}`, SK: "META" }),
  workspacePartition: (id: string) => `WORKSPACE#${id}`,
  workspaceChat: (chatId: string) => ({ PK: `WORKSPACECHAT#${chatId}`, SK: "META" }),
  workspaceOwner: (email: string) => `WORKSPACEOWNER#${email}`,
  workspaceDue: () => "WORKSPACEDUE",
  workspaceDueSort: (dueAt: string, id: string) => `${dueAt}#${id}`,
  workspaceDueRange: (now: string) => ({ between: ["", `${now}#\uffff`] as [string, string] }),
  workspaceContinuationsDue: () => "WORKSPACECONTINUATIONDUE",
  workspaceChild: (id: string, kind: "SESSION" | "SANDBOX" | "RUN" | "APPROVAL" | "REQUEST" | "DELIVERY" | "CONTINUATION", childId: string) => ({
    PK: `WORKSPACE#${id}`, SK: `${kind}#${childId}`,
  }),
  workspaceChildPrefix: (kind: "RUN" | "APPROVAL") => `${kind}#`,
  workspaceEvent: (id: string, runId: string, seq: number) => ({
    PK: `WORKSPACE#${id}`, SK: `EVENT#${runId}#${String(seq).padStart(8, "0")}`,
  }),
  workspaceEventRange: (runId: string, afterSeq: number) => ({
    between: [`EVENT#${runId}#${String(afterSeq + 1).padStart(8, "0")}`, `EVENT#${runId}#99999999`] as [string, string],
  }),
  workspaceStatePartition: (id: string) => `WORKSPACESTATE#${id}`,
  workspaceCheckpoint: (id: string, checkpointId: string) => ({ PK: `WORKSPACESTATE#${id}`, SK: `${checkpointId}#META` }),
  workspaceCheckpointChunk: (id: string, checkpointId: string, index: number) => ({
    PK: `WORKSPACESTATE#${id}`, SK: `${checkpointId}#${String(index).padStart(6, "0")}`,
  }),
  agent: (name: string) => ({ PK: `AGENT#${name}`, SK: "META" }),
  agentPartition: (name: string) => `AGENT#${name}`,
  agentApiToken: (name: string) => ({ PK: `AGENT#${name}`, SK: "APITOKEN" }),
  workspacePolicy: (name: string) => ({ PK: `AGENT#${name}`, SK: "WORKSPACEPOLICY" }),
  workspaceRepositoryCreation: (agent: string, repository: string) => ({ PK: `AGENT#${agent}`, SK: `REPOSITORYCREATE#${repository.toLowerCase()}` }),

  audioJob: (agentName: string, id: string) => ({ PK: `AGENT#${agentName}`, SK: `AUDIOJOB#${id}` }),
  audioJobConfig: (agentName: string) => ({ PK: `AGENT#${agentName}`, SK: "AUDIOCONFIG" }),
  audioJobPrefix: () => "AUDIOJOB#",
  usageReceipt: (agentName: string, id: string) => ({ PK: `AGENT#${agentName}`, SK: `USAGERECEIPT#${id}` }),
  sourceFile: (id: string) => ({ PK: `SOURCEFILE#${id}`, SK: "META" }),
  sourceFileJobIndex: (agent: string, job: string, kind: string, id: string) => ({
    GSI2PK: `SOURCEJOB#${agent}#${job}`, GSI2SK: `${kind}#${id}`,
  }),
  sourceFileJobQuery: (agent: string, job: string, kind: string) => ({
    pk: `SOURCEJOB#${agent}#${job}`, sk: { prefix: `${kind}#` },
  }),
  sourceReference: (id: string) => ({ PK: `SOURCEREFERENCE#${id}`, SK: "META" }),
  sourceFileExpiryIndex: (retireAt: string, agentName: string, id: string) => ({
    GSI1PK: "SOURCEFILEEXPIRY", GSI1SK: `${retireAt}#${agentName}#${id}`,
  }),
  sourceFileExpiryQuery: (now: string) => ({
    pk: "SOURCEFILEEXPIRY", sk: { between: ["", `${now}#\uffff`] as [string, string] },
  }),
  audioJobSlots: (agentName: string) => ({ PK: `AGENT#${agentName}`, SK: "AUDIOSLOTS" }),
  audioJobSource: (agentName: string, sourceKey: string) => ({
    PK: `AGENT#${agentName}`, SK: `AUDIOSOURCE#${sourceKey}`,
  }),
  audioJobOccurrence: (agentName: string, occurrence: string) => ({
    PK: `AGENT#${agentName}`, SK: `AUDIOOCCURRENCE#${occurrence}`,
  }),
  audioJobDueIndex: (dueAt: string, agentName: string, id: string) => ({
    GSI1PK: "AUDIOJOBDUE", GSI1SK: `${dueAt}#${agentName}#${id}`,
  }),
  audioJobDueQuery: (now: string) => ({
    pk: "AUDIOJOBDUE", sk: { between: ["", `${now}#\uffff`] as [string, string] },
  }),

  chat: (chatId: string) => ({ PK: `CHAT#${chatId}`, SK: "META" }),
  chatMessage: (chatId: string, seq: number) => ({
    PK: `CHAT#${chatId}`,
    SK: `MSG#${String(seq).padStart(6, "0")}`,
  }),
  chatMessagePrefix: () => "MSG#",
  /**
   * Sort-key bounds for reading a chat's messages from `fromSeq` on — what a
   * thread that already holds the turns before it asks for.
   *
   * A range rather than the prefix, for the same reason `chatRunLogRange` is
   * one: `SK > MSG#…` alone would run past the message rows into the run log,
   * which sorts after them in the same partition. `CHAT_MESSAGE_MAX_SEQ` is
   * the widest a six-digit sequence can be, and a `fromSeq` past it has no
   * range at all — clamping there would answer "nothing after the last row"
   * with the last row itself, and not clamping would build a `BETWEEN` whose
   * bounds invert, which a range query answers with nothing. The caller reads `null`
   * as the empty answer it is.
   */
  chatMessageRange: (fromSeq: number) =>
    fromSeq > CHAT_MESSAGE_MAX_SEQ
      ? null
      : {
          from: `MSG#${String(fromSeq).padStart(6, "0")}`,
          to: `MSG#${CHAT_MESSAGE_MAX_SEQ}`,
        },
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
  modelPreferences: (userId: string) => ({ PK: `MODELPREFERENCES#${userId}`, SK: "META" }),
  /** Serialize capability index rebuilds and track their generation. */
  catalogReindexLock: () => ({ PK: "CATALOGREINDEX#global", SK: "LOCK" }),

  skill: (name: string) => ({ PK: `SKILL#${name}`, SK: "META" }),
  mcp: (name: string) => ({ PK: `MCP#${name}`, SK: "META" }),
  /** An installed Agent Plugins package. The name may contain periods — inert in a key. */
  plugin: (name: string) => ({ PK: `PLUGIN#${name}`, SK: "META" }),
  /** The last plugins-sync report for one source repo, and the sync's lease. */
  pluginSyncReport: (repo: string) => ({ PK: `PLUGINSYNC#${repo}`, SK: "REPORT" }),
  pluginSyncLock: (repo: string) => ({ PK: `PLUGINSYNC#${repo}`, SK: "LOCK" }),

  /**
   * An agent's triggers and their delivery history, both in the agent
   * partition — so the agent cascade delete already removes them, and a
   * trigger's runs list is one `begins_with` query.
   */
  trigger: (agentName: string, triggerId: string) => ({
    PK: `AGENT#${agentName}`,
    SK: `TRIGGER#${triggerId}`,
  }),
  triggerPrefix: () => "TRIGGER#",
  /**
   * The cross-agent schedule listing a scan tick walks. Only schedule rows
   * carry these GSI1 attributes; webhook rows stay invisible to the index.
   */
  scheduleIndex: (agentName: string, triggerId: string) => ({
    GSI1PK: keys.typePartition("SCHEDULE"),
    GSI1SK: `${agentName}#${triggerId}`,
  }),
  triggerRun: (agentName: string, triggerId: string, startedAt: string, runId: string) => ({
    PK: `AGENT#${agentName}`,
    SK: `TRIGGERRUN#${triggerId}#${startedAt}#${runId}`,
  }),
  triggerRunPrefix: (triggerId: string) => `TRIGGERRUN#${triggerId}#`,
  queuedTriggerRunPartition: (agentName: string, triggerId: string) => `TRIGGERQUEUE#${agentName}#${triggerId}`,
  queuedTriggerRunIndex: (agentName: string, triggerId: string, leaseUntil: string, runId: string) => ({
    GSI1PK: keys.queuedTriggerRunPartition(agentName, triggerId),
    GSI1SK: `${leaseUntil}#${runId}`,
  }),
  /**
   * A delivery's idempotency claim. Its own partition because the key is an
   * arbitrary caller-supplied string, which has no business in the agent
   * partition's sort-key space.
   */
  triggerIdempotency: (agentName: string, triggerId: string, key: string) => ({
    PK: `TRIGGERIDEM#${agentName}#${triggerId}#${key}`,
    SK: "META",
  }),

  /** An agent's OAuth connection to one registry MCP server. */
  mcpConnection: (agentName: string, serverName: string) => ({
    PK: `AGENT#${agentName}`,
    SK: `MCPCONN#${serverName}`,
  }),
  mcpConnectionPrefix: () => "MCPCONN#",
  /** An authorization in flight, keyed by the opaque `state` it was started with. */
  mcpOAuthState: (state: string) => ({ PK: `MCPOAUTH#${state}`, SK: "META" }),

  usage: (agentName: string, date: string) => ({
    PK: `USAGE#${agentName}`,
    SK: `DATE#${date}`,
  }),
  /**
   * The once-per-month notification claims for the monthly cost thresholds.
   * Its own row rather than a marker on a daily row, because the instances
   * crossing the threshold on different days read different daily rows.
   */
  usageMonthClaim: (agentName: string, month: string) => ({
    PK: `USAGE#${agentName}`,
    SK: `MONTHCLAIM#${month}`,
  }),
  usageDatePartition: (date: string) => `USAGEDATE#${date}`,
  /**
   * One member's cross-agent spend for one UTC day — their own console runs
   * (`user:` actors), which is what the tier cost cap bounds. An agent
   * token's spend deliberately stays out (it is bounded by the agent's own
   * limits; see `memberEmailFromActorKey`). Its own partition because no
   * agent's cascade delete may take a person's history with it.
   *
   * Daily rather than monthly, and for the same reason the agent rows are:
   * one shape answers both readers. The cap sums the month from `MONTH-01` to
   * today, exactly as the agent guard does over `USAGE#{agent}`, and the
   * profile page reads whatever window its date picker names — a month
   * aggregate could only have answered the first, and keeping both would be
   * two running totals of the same spend.
   *
   * The agent is part of the sort key rather than collapsed into the row,
   * so a person can be shown *where* their spend went as well as on which
   * model. Date leads it so a window is still one `BETWEEN`; the cap sums every
   * row the window returns.
   */
  usageMember: (email: string, date: string, agentName: string) => ({
    PK: `USAGEMEMBER#${email}`,
    SK: `DATE#${date}#${agentName}`,
  }),
  usageMemberPartition: (email: string) => `USAGEMEMBER#${email}`,
  usageMemberPrefix: (date: string) => `DATE#${date}`,
  /**
   * Per-caller daily usage, in the agent's usage partition. Date leads the
   * sort key so a range query over dates is one `BETWEEN`, and so the rows of
   * one day sit together; `DATE#` and `ACTOR#` are distinct prefixes, so the
   * agent totals above are never swept up by an actor query or vice versa.
   */
  usageActor: (agentName: string, date: string, actor: string) => ({
    PK: `USAGE#${agentName}`,
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
  agentRecommendationQuota: (email: string, date: string) => ({
    PK: `AGENTRECOMMENDATION#${email.toLowerCase()}`,
    SK: `DATE#${date}`,
  }),

  slackEvent: (eventId: string) => ({ PK: `SLACKEVENT#${eventId}`, SK: "META" }),

  /**
   * One Telegram update delivered to one agent's bot, one album (a
   * `media_group_id`) the bot answers once, and one observed report
   * destination. In the agent partition so the cascade delete takes them;
   * qualified by bot because an `update_id` is a counter per bot, and a
   * agent may change bots.
   */
  telegramUpdate: (agentName: string, botId: number | string, updateId: number | string) => ({
    PK: `AGENT#${agentName}`,
    SK: `TELEGRAMUPDATE#${botId}#${updateId}`,
  }),
  telegramAlbum: (agentName: string, botId: number | string, mediaGroupId: string) => ({
    PK: `AGENT#${agentName}`,
    SK: `TELEGRAMALBUM#${botId}#${mediaGroupId}`,
  }),
  telegramDestinationPrefix: (agentName: string, botId: number | string) => ({
    PK: `AGENT#${agentName}`,
    prefix: `TELEGRAMDESTINATION#${botId}#`,
  }),
  telegramDestinationIndexPrefix: (agentName: string, botId: number | string) => ({
    GSI2PK: `${TELEGRAM_DESTINATION_INDEX_PREFIX}${agentName}#${botId}`,
  }),
  telegramDestination: (
    agentName: string,
    botId: number | string,
    chatId: number,
    threadId?: number,
  ) => ({
    PK: `AGENT#${agentName}`,
    SK: `TELEGRAMDESTINATION#${botId}#${chatId}#${threadId ?? ""}`,
  }),

  /**
   * One Bot Framework activity delivered to one agent's Teams bot. In the
   * agent partition, qualified by app id, for the reasons the Telegram
   * update is; the id the caller passes is `{conversationId}#{activityId}`,
   * because an activity id is unique only within its conversation.
   */
  teamsActivity: (agentName: string, appId: string, conversationAndActivityId: string) => ({
    PK: `AGENT#${agentName}`,
    SK: `TEAMSACTIVITY#${appId}#${conversationAndActivityId}`,
  }),

  /**
   * What a chat-bot surface remembers of one conversation. In the agent
   * partition so the cascade delete takes it — a deleted agent must not
   * leave a week of somebody's messages behind — and one turn per row so a
   * long conversation never rewrites a growing item; the newest turns are one
   * bounded query on the sort-key prefix, newest first.
   */
  transcriptTurnPrefix: (agentName: string, conversationKey: string) => ({
    PK: `AGENT#${agentName}`,
    prefix: `TRANSCRIPT#${conversationKey}#TURN#`,
  }),
  transcriptTurn: (agentName: string, conversationKey: string, createdAt: string, seq: string) => ({
    PK: `AGENT#${agentName}`,
    SK: `TRANSCRIPT#${conversationKey}#TURN#${createdAt}#${seq}`,
  }),

  /**
   * A channel thread this agent's bot is engaged in. Point-read only — the
   * gate asks about one thread — so the whole address is the partition and
   * nothing ever queries across them.
   */
  slackThread: (agentName: string, channel: string, threadTs: string) => ({
    PK: `SLACKTHREAD#${agentName}#${channel}#${threadTs}`,
    SK: "META",
  }),

  slackRunControl: (agentName: string, channel: string, threadTs: string) => ({
    PK: `AGENT#${agentName}`,
    SK: `SLACKSTOP#${channel}#${threadTs}`,
  }),
  slackRunLease: (agentName: string, channel: string, threadTs: string) => ({
    PK: `AGENT#${agentName}`,
    SK: `SLACKRUN#${channel}#${threadTs}`,
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
   * cannot: a Slack or trigger run names no email, so the agent index is
   * the only way those are ever listed or deleted; and agents are a shared
   * catalog, so the owner index is the only way a person finds their own work
   * without reading someone else's agent.
   */
  artifact: (artifactId: string) => ({ PK: `ARTIFACT#${artifactId}`, SK: "META" }),
  artifactAgentPartition: (agentName: string) => `ARTIFACTAGENT#${agentName}`,
  /** Sparse: only rows whose actor names an email carry the GSI2 attributes. */
  artifactOwnerPartition: (email: string) => `ARTIFACTOWNER#${email}`,

  trace: (traceId: string) => ({ PK: `TRACE#${traceId}`, SK: "META" }),
  traceRef: (agentName: string, createdAt: string, traceId: string) => ({
    PK: `AGENT#${agentName}`,
    SK: `TRACE#${createdAt}#${traceId}`,
  }),
  traceAgentPartition: (agentName: string) => `TRACEAGENT#${agentName}`,

  typePartition: (
    entityType: "AGENT" | "SKILL" | "MCP" | "PLUGIN" | "SCHEDULE",
  ) => `TYPE#${entityType}`,
} as const;

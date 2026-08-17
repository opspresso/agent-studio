# Single-owner invariants

Every decision below has **one owning file**. `tests/architecture.test.ts` fails on a second
copy **and** on the owner losing the definition — a check that passed because the rule stopped
matching anything reads exactly like a clean one.

Why this list exists, and the rule for deciding which layer owns a limit, are in
[../AGENTS.md](../AGENTS.md#single-owner-invariants). **Before writing any of these, check
whether you are about to make copy number two.**

| Decision | Owner |
|---|---|
| The shape of an MCP tool | `src/domain/mcp/types.ts` |
| Which hosts may skip the outbound URL guard | `src/domain/mcp/types.ts` |
| The address a project's client ID metadata document is served at | `clientMetadataUrl` in `src/application/mcp/mcpAuthUseCases.ts` — drift here is fatal by specification: an authorization server refuses when the document's own `client_id` differs from the URL it fetched |
| Interpreting `plugin.json`/`mcp.json`, and which MCP transports a plugin may bind | `src/domain/plugin/types.ts` |
| The Agent Plugins name rule | `isPluginName` in `src/domain/plugin/types.ts` |
| Which storage errors mean a lost conditional write | `src/application/errors.ts` |
| How an audit row is written | `src/application/audit/recordAudit.ts` |
| Collapsing an image model's three token counts into a usage row | `src/domain/llm/models.ts` |
| How an artifact row is written | `src/application/artifact/storeArtifact.ts` |
| The object key an artifact is stored under | `artifactObjectKey` in `src/domain/artifact/types.ts` |
| Deleting a stored object | `src/infrastructure/storage/s3ObjectStore.ts` |
| Constant-time secret comparison | `src/shared/timingSafe.ts` |
| Parsing a comma-separated config list | `src/shared/parseList.ts` |
| Whether a configured value is blank | `src/shared/env.ts` |
| Asking a provider for an embedding | `src/infrastructure/llm/embeddings.ts` |
| Reaching Bedrock | `src/infrastructure/llm/bedrockClient.ts` |
| Talking to the vector store | `src/infrastructure/vector/s3VectorsStore.ts` |
| The key a capability is indexed under | `capabilityKey` in `src/domain/catalog/types.ts` |
| What text a capability is embedded as | `capabilityText` in `src/domain/catalog/types.ts` |
| How much a search may add to one run | `DISCOVERY_LIMITS` in `src/application/execution/bindings.ts` |
| How a run primes its memory — which tool is asked, with what, and what the answer becomes | `recallMemories` / `RECALL_TOOL_NAME` / `MAX_RECALLED_CHARS` in `src/application/execution/memoryRecall.ts` |
| What a run searches the catalog with | `discoveryQueries` in `src/application/execution/bindings.ts` |
| Parsing a markdown frontmatter block | `src/shared/frontmatter.ts` |
| The subagent nesting limit | `src/application/execution/subagentRunner.ts` |
| The per-run MCP tool cap | `src/domain/llm/toolLimits.ts` |
| What each member tier may spend | `TIER_LIMITS` in `src/domain/member/tiers.ts` |
| What a 401 from an MCP server means | `src/infrastructure/mcp/session.ts` |
| The name a provider will accept for an MCP tool | `src/infrastructure/mcp/toolManager.ts` |
| Reaching `undici` directly | `src/infrastructure/net/publicFetch.ts` — a `dispatcher` is a private contract between a fetch and its `Agent`, and the runtime ships its own undici behind the global `fetch`; mixing the two cost every outbound request a bare `TypeError: fetch failed` |
| The header that names the calling project to an MCP server | `TENANT_ID_HEADER` in `src/application/execution/mcpTools.ts` |
| The header that names the run's conversation to an MCP server | `CONVERSATION_ID_HEADER` in `src/application/execution/mcpTools.ts` — the API layer reads the same spelling *inbound* in `src/app/api/projects/_lib/conversation.ts`, and the API Reference tab (`endpoints.ts`) shows it to a caller; those two files alone |
| How a run's conversation is built and keyed | `conversationOf` / `conversationKey` in `src/domain/execution/actor.ts`; each surface's spelling is its own builder (`chatConversation`, `slackConversation`, `telegramConversation`, `a2aConversation`, `requestConversation`), and every one goes through these two |
| How many agents one dispatch may run | `src/application/llm/agentAssembly.ts` |
| How an agent run's prompt and tool set are assembled | `assembleAgentRun` in `src/application/llm/agentAssembly.ts` |
| Deriving a run's context budget from the model's window | `src/application/llm/contextBudget.ts` |
| Whether a run's trace is sampled | `src/application/run/traceLifecycle.ts` |
| Evaluating when a schedule fires | `src/domain/trigger/cron.ts` |
| Where a project's webhook is delivered | `projectWebhookPath` in `src/domain/trigger/types.ts` |
| The managed-workload name rule | `MANAGED_NAME` in `src/shared/slug.ts` |
| Merging concurrent generators | `src/shared/mergeGenerators.ts` |
| Deriving the transfer chain a chunk came from | `src/app/_lib/authorPaths.ts` |
| A dollar amount, written for a person | `formatUsd` in `src/app/_lib/formatUsd.ts` — enforced as its own rule rather than as a `SINGLE_OWNERS` row: no `${…toFixed(…)}` anywhere in `app` but the two `_lib` formatters |
| A stored object's size, written for a person | `formatBytes` in `src/app/_lib/formatBytes.ts` |
| Deriving why a run ended from its chunks | `chunkTermination`/`runTermination` in `src/domain/llm/types.ts` |
| Collecting what a run lost from its chunks | `collectedWarning` in `src/domain/llm/types.ts` |
| The 401 response body | `src/shared/unauthorized.ts` |
| The code a refused sign-in is identified by | `src/shared/signInError.ts` |
| Writing to the console | `src/shared/logger.ts` |
| What wraps a top-level run | `src/application/run/runBracket.ts` |
| Which project type runs which way | `src/application/execution/deps.ts` |
| Whether a run's prompt may name its caller | `callerFor` in `src/application/execution/deps.ts` |
| What a tool result has to do, and in what order | `createToolResultEmitter` in `src/application/llm/toolResultBudget.ts` |
| How the execution facade dispatches an agent project | `src/application/execution/deps.ts` |
| How a Slack reply is delivered, progress included | `src/application/slack/replyStream.ts` — one report, rendered by whichever mechanism the surface has: a DM's status line or a channel stream's `task_update` axis. Neither is the definition of the other |
| Which delivered Slack events are for the bot, the loop guard included | `src/application/slack/engagement.ts` |
| Which messages are a fixed command rather than a question | `parseSlackCommand` in `src/application/slack/engagement.ts` — strict by design: a command changes whether the bot speaks again, and a looser match silences threads nobody asked to silence |
| The Slack Web API surface a run uses | `SlackClientPort` in `src/application/slack/types.ts`; the streaming chunk shapes it passes are `SlackChunk` in `src/domain/slack/types.ts`, which is where the adapter can also reach them |
| How a chat-bot turn runs once its adapter has normalised it — attachments into a turn, chunks onto the sink, the tail in one order | `handleTurn` in `src/application/messaging/handleTurn.ts`; the Slack and Telegram handlers normalise and render, and neither folds a chunk itself |
| Attachment limits and the sentence each dropped attachment earns, on every chat-bot surface | `src/application/messaging/attachments.ts` — the platform contributes the bytes through `InboundAttachment.download` and nothing else |
| The reply ports every chat-bot surface implements | `ReplySink` / `ReplyChannel` in `src/domain/messaging/reply.ts` — the pipeline calls them, each adapter renders them, neither imports the other |
| The claim-and-settle contract behind exactly-once inbound events | `createInboundClaimRepository` in `src/infrastructure/db/repositories/inboundClaimRepository.ts`; Slack keys it by `event_id`, Telegram by project and `update_id`, and the port is `InboundEventClaims` in `src/domain/messaging/inboundClaims.ts` |
| The webhook tail every chat platform shares — claim, ack, work under the event's id, settle | `admitInboundEvent` in `src/app/api/_lib/inboundEvent.ts` |
| How a Telegram reply is delivered — edited in place, split at 4,096 characters, rendered once with a plain fallback | `src/application/telegram/replyChannel.ts` |
| Which delivered Telegram updates are for the bot, and which are a command | `classifyTelegramUpdate` / `parseTelegramCommand` in `src/application/telegram/engagement.ts` |
| The Telegram Bot API surface this platform uses | `TelegramClientPort` in `src/domain/telegram/client.ts`; the adapter is `src/infrastructure/telegram/client.ts` |
| Rendering an answer's Markdown as Telegram HTML | `markdownToTelegramHtml` in `src/application/telegram/markdown.ts` |
| Deciding whether bytes are UTF-8 text | `src/shared/utf8Text.ts` |
| User-document caps | `src/domain/llm/documentLimits.ts` |
| How a fetched URL is framed in a turn | `framedFetchedUrl` in `src/application/llm/documentParts.ts` |
| How much of a fetched URL is kept | `MAX_FETCHED_TEXT_CHARS` in `src/application/llm/urlContent.ts` |
| How an attached document is framed in a turn | `src/application/llm/documentParts.ts` |
| The name every entry is addressed by | `isSlug` in `src/shared/slug.ts` |

Other decisions with a single owner that the test cannot express as a pattern, but that the
same rule applies to:

| Decision | Owner |
|---|---|
| Every DynamoDB key string | `src/infrastructure/db/keys.ts` |
| What a model is, and which routes serve it | `MODEL_FAMILIES`/`MODEL_OFFERINGS` in `src/domain/llm/models.ts` |
| Detaching a stream from the consumer that walked away | `src/shared/detachOnReturn.ts` |
| Reading an HTTP body under a byte ceiling | `src/shared/httpBody.ts` |
| The name and media type a tool's file is carried under | `safeFileName`/`baseMediaType` in `src/infrastructure/mcp/toolManager.ts` |
| Keeping a background timer from holding the process open | `src/shared/unrefTimer.ts` |
| Paginated list reads | `queryAll()` in `src/infrastructure/db/query.ts` |
| Which pages are public | `src/proxy.ts` |
| Whether a chunk is top-level | `isTopLevelChunk()` in `src/domain/llm/types.ts` |
| Which version a run executes | `resolveRunnableVersion` in `src/application/project/` |
| User-image caps | `src/domain/llm/imageLimits.ts` |
| `data:` image encoding | `imageDataUrl`/`parseImageDataUrl` in `src/domain/llm/types.ts` |
| Turning a stored image reference into an address | `resolveImageUrl` in `src/domain/chat/imageRefs.ts` |
| Turning a stored file reference into a download address | `resolveFileUrl` in `src/domain/chat/fileRefs.ts` |
| Offering a file a run produced to a reader | `src/application/artifact/producedFiles.ts` — the test enforces the *pairing* (a module reading one output axis reads the other) and exempts this file by name, since its whole subject is the axis |
| Signing an outbound request for AWS | `src/infrastructure/llm/awsSigner.ts` — pinned by `tests/awsSigner.test.ts` instead, which fixes the signature it produces |
| How long a signed object URL lives, per reader | `src/application/artifact/urlTtl.ts` |
| Who releases a chat's run lease | `teeToRunLog` in `src/application/chat/runLog.ts` |
| How a chat run reaches the browser | `src/app/api/chats/_lib/detachedRun.ts` |
| Row TTLs | `src/infrastructure/db/ttl.ts` |
| The UTC day a usage row is keyed by | `utcDay` in `src/shared/date.ts` |
| What a repo sync did, and what it left to a person | `src/domain/sync/types.ts` |
| The brand palette and component defaults | `src/app/theme.ts` |
| Who owns the chat viewport while a reply streams | `useStickToBottom` in `src/app/chats/_components/ChatThread.tsx` |
| Pairing a tool call with the result that answered it | `src/app/_lib/toolPairs.ts` |
| Drawing one tool's traffic as one row | `src/app/_components/ToolRow.tsx` |
| What a tool call reads as to a person | `describeTool` in `src/app/_lib/toolCalls.ts` |
| Every string the console shows a person | `src/app/_i18n/messages/en.ts` |
| Which language a request is served in | `src/app/_i18n/locale.ts` |
| What a chat-bot surface remembers of a conversation when the platform keeps no history | `ConversationTranscriptRepository` in `src/domain/messaging/transcript.ts`; written and read only by the Telegram handler |


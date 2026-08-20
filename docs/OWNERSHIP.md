# 단일 소유자 불변식

아래의 모든 결정에는 **소유 파일이 하나씩** 있다. `tests/architecture.test.ts` 는 사본이
하나 더 생겨도 실패하고 **소유자가 정의를 잃어도** 실패한다 — 규칙이 아무것도 매칭하지
않게 되어 통과한 검사는 깨끗하게 통과한 검사와 똑같이 보이기 때문이다.

이 목록이 존재하는 이유와, 어느 레이어가 어떤 한도를 소유하는지 정하는 규칙은
[../AGENTS.md](../AGENTS.md#single-owner-invariants) 에 있다. **이 중 어느 것이든 쓰기
전에, 사본 두 번째를 만들고 있는 것은 아닌지 확인하라.**

| 결정 | 소유자 |
|---|---|
| MCP tool 의 형태 | `src/domain/mcp/types.ts` |
| 어떤 호스트가 아웃바운드 URL 가드를 건너뛸 수 있는가 | `src/domain/mcp/types.ts` |
| Project 의 client ID 메타데이터 문서가 서빙되는 주소 | `src/application/mcp/mcpAuthUseCases.ts` 의 `clientMetadataUrl` — 여기서 어긋나는 것은 명세상 치명적이다: 문서 자신의 `client_id` 가 그것을 가져온 URL 과 다르면 authorization server 는 거부한다 |
| `plugin.json`/`mcp.json` 의 해석, 그리고 Plugin 이 어떤 MCP transport 를 바인딩할 수 있는가 | `src/domain/plugin/types.ts` |
| Agent Plugins 이름 규칙 | `src/domain/plugin/types.ts` 의 `isPluginName` |
| 어떤 스토리지 에러가 조건부 쓰기의 실패를 뜻하는가 | `src/application/errors.ts` |
| audit 행을 어떻게 쓰는가 | `src/application/audit/recordAudit.ts` |
| 이미지 Model 의 세 가지 토큰 수를 usage 행 하나로 합치기 | `src/domain/llm/models.ts` |
| artifact 행을 어떻게 쓰는가 | `src/application/artifact/storeArtifact.ts` |
| artifact 가 저장되는 오브젝트 키 | `src/domain/artifact/types.ts` 의 `artifactObjectKey` |
| 저장된 오브젝트를 삭제하기 | `src/infrastructure/storage/s3ObjectStore.ts` |
| 상수 시간 시크릿 비교 | `src/shared/timingSafe.ts` |
| 쉼표로 구분된 설정 목록의 파싱 | `src/shared/parseList.ts` |
| 설정된 값이 비어 있는지 여부 | `src/shared/env.ts` |
| provider 에 embedding 을 요청하기 | `src/infrastructure/llm/embeddings.ts` |
| Bedrock 에 닿기 | `src/infrastructure/llm/bedrockClient.ts` |
| vector store 와 이야기하기 | `src/infrastructure/vector/s3VectorsStore.ts` |
| capability 가 색인되는 키 | `src/domain/catalog/types.ts` 의 `capabilityKey` |
| capability 가 어떤 텍스트로 embedding 되는가 | `src/domain/catalog/types.ts` 의 `capabilityText` |
| 검색이 한 런에 얼마나 더할 수 있는가 | `src/application/execution/bindings.ts` 의 `DISCOVERY_LIMITS` |
| 런이 자기 메모리를 어떻게 준비하는가 — 어떤 tool 에게, 무엇으로 묻고, 그 답이 무엇이 되는가 | `src/application/execution/memoryRecall.ts` 의 `recallMemories` / `MAX_RECALLED_CHARS`; 묻는 tool 의 이름과 "바인딩만으로 회상이 불가능한가" 는 `src/domain/project/memoryRecall.ts` 의 `RECALL_TOOL_NAME` / `bindingsMayOfferRecall` — 버전 편집기가 런 전에 같은 답을 읽는다 |
| 런이 무엇으로 카탈로그를 검색하는가 | `src/application/execution/bindings.ts` 의 `discoveryQueries` |
| 마크다운 frontmatter 블록의 파싱 | `src/domain/plugin/frontmatter.ts` |
| 아티팩트 목록의 페이지 커서(= 정렬 키) 철자 | `src/domain/artifact/repository.ts` 의 `artifactCursor` |
| subagent 중첩 한도 | `src/application/execution/subagentRunner.ts` |
| 런당 MCP tool 상한 | `src/domain/llm/toolLimits.ts` |
| 각 member tier 가 쓸 수 있는 금액 | `src/domain/member/tiers.ts` 의 `TIER_LIMITS` |
| MCP 서버가 보낸 401 이 뜻하는 것 | `src/infrastructure/mcp/session.ts` |
| provider 가 MCP tool 이름으로 받아들이는 이름 | `src/infrastructure/mcp/toolManager.ts` |
| `undici` 에 직접 닿기 | `src/infrastructure/net/publicFetch.ts` — `dispatcher` 는 하나의 fetch 와 그 `Agent` 사이의 사적인 계약이고, 런타임은 전역 `fetch` 뒤에 자기 몫의 undici 를 싣고 다닌다. 둘을 섞은 대가로 모든 아웃바운드 요청이 맨몸의 `TypeError: fetch failed` 를 받았다 |
| 호출하는 Project 를 MCP 서버에 알리는 헤더 | `src/application/execution/mcpTools.ts` 의 `TENANT_ID_HEADER` |
| 런의 conversation 을 MCP 서버에 알리는 헤더 | `src/application/execution/mcpTools.ts` 의 `CONVERSATION_ID_HEADER` — API 레이어는 `src/app/api/projects/_lib/conversation.ts` 에서 같은 철자를 *인바운드* 로 읽고, API Reference 탭(`endpoints.ts`)이 그것을 호출자에게 보여준다. 그 두 파일뿐이다 |
| 런의 conversation 을 어떻게 만들고 무엇으로 키를 삼는가 | `src/domain/execution/actor.ts` 의 `conversationOf` / `conversationKey`. 각 표면의 철자는 저마다 자기 빌더(`chatConversation`, `slackConversation`, `telegramConversation`, `a2aConversation`, `requestConversation`)를 갖지만, 그 전부가 이 둘을 지난다 |
| 한 번의 dispatch 가 몇 개의 Agent 를 실행할 수 있는가 | `src/application/llm/agentAssembly.ts` |
| Agent 런의 프롬프트와 tool 집합을 어떻게 조립하는가 | `src/application/llm/agentAssembly.ts` 의 `assembleAgentRun` |
| Model 의 window 로부터 런의 컨텍스트 예산을 도출하기 | `src/application/llm/contextBudget.ts` |
| 런의 trace 를 샘플링할지 여부 | `src/application/run/traceLifecycle.ts` |
| schedule 이 언제 발화하는지 판정하기 | `src/domain/trigger/cron.ts` |
| Project 의 webhook 이 어디로 전달되는가 | `src/domain/trigger/types.ts` 의 `projectWebhookPath` |
| managed workload 이름 규칙 | `src/domain/naming.ts` 의 `MANAGED_NAME` |
| 동시에 도는 generator 를 병합하기 | `src/shared/mergeGenerators.ts` |
| chunk 가 거쳐 온 transfer 사슬을 도출하기 | `src/app/_lib/authorPaths.ts` |
| 사람이 읽을 달러 금액 | `src/app/_lib/formatUsd.ts` 의 `formatUsd` — `SINGLE_OWNERS` 행이 아니라 그 자체가 하나의 규칙으로 강제된다: `app` 안 어디에도 `${…toFixed(…)}` 는 없고 두 `_lib` 포매터만 있다 |
| 사람이 읽을 저장 오브젝트의 크기 | `src/app/_lib/formatBytes.ts` 의 `formatBytes` |
| 런이 왜 끝났는지를 그 chunk 들로부터 도출하기 | `src/domain/llm/types.ts` 의 `chunkTermination`/`runTermination` |
| 런이 무엇을 잃었는지를 그 chunk 들로부터 모으기 | `src/domain/llm/types.ts` 의 `collectedWarning` |
| 401 응답 본문 | `src/shared/unauthorized.ts` |
| 거부된 sign-in 을 식별하는 코드 | `src/shared/signInError.ts` |
| 콘솔에 쓰기 | `src/shared/logger.ts` |
| top-level 런을 감싸는 것 | `src/application/run/runBracket.ts` |
| 어떤 project type 이 어떤 방식으로 실행되는가 | `src/application/execution/deps.ts` |
| 런의 프롬프트가 자기 caller 를 이름으로 불러도 되는가 | `src/application/execution/deps.ts` 의 `callerFor` |
| tool 결과가 무엇을, 어떤 순서로 해야 하는가 | `src/application/llm/toolResultBudget.ts` 의 `createToolResultEmitter` |
| 실행 파사드가 agent project 를 어떻게 dispatch 하는가 | `src/application/execution/deps.ts` |
| 진행 상황을 포함해 Slack 답변이 어떻게 전달되는가 | `src/application/slack/replyStream.ts` — 보고는 하나이고, 그것을 렌더하는 것은 표면이 가진 메커니즘이다: DM 의 상태 줄이거나 채널 스트림의 `task_update` 축이다. 어느 쪽도 다른 쪽의 정의가 아니다 |
| 전달된 Slack 이벤트 중 어떤 것이 봇에게 온 것인가, loop guard 포함 | `src/application/slack/engagement.ts` |
| Slack 메시지가 무엇을 *말하는가* — `text`·attachment·prose block 을 한 텍스트로 | `src/domain/slack/messageText.ts` 의 `slackMessageText`. 키워드 매칭, 런이 답하는 턴, 스레드 히스토리 셋이 이것을 읽는다 — 경보 앱은 제목과 본문을 attachment 에 두므로 `text` 만 읽는 쪽은 헤드라인만 받는다 |
| 어떤 메시지가 질문이 아니라 고정된 명령인가 | `src/application/slack/engagement.ts` 의 `parseSlackCommand` — 의도적으로 엄격하다: 명령은 봇이 다시 말할지 여부를 바꾸고, 매칭이 느슨하면 아무도 침묵시켜 달라 하지 않은 스레드를 침묵시킨다 |
| 런이 사용하는 Slack Web API 표면 | `src/application/slack/types.ts` 의 `SlackClientPort`. 그것이 넘기는 스트리밍 chunk 형태는 `src/domain/slack/types.ts` 의 `SlackChunk` 이고, 어댑터도 거기서 그것들에 닿을 수 있다 |
| 어댑터가 정규화를 마친 뒤 chat-bot 턴이 어떻게 도는가 — 첨부는 턴 안으로, chunk 는 sink 위로, 꼬리는 한 가지 순서로 | `src/application/messaging/handleTurn.ts` 의 `handleTurn`. Slack·Telegram·Teams 핸들러는 정규화하고 렌더할 뿐, 어느 쪽도 chunk 를 직접 접어 넣지 않는다 |
| 편집으로 답을 전달하는 표면의 장부 — 페이싱, 메시지가 넘칠 때 다음으로 잇기, 거부된 쓰기의 재시도 간격, 마감이 독자에게 빚진 것 | `src/application/messaging/editInPlaceReply.ts` 의 `createEditInPlaceReply`. Telegram 과 Teams 는 호출·상한·렌더링(`EditInPlaceTransport`)만 건넨다 |
| 답이 메시지 하나를 넘칠 때 *어디서* 끊는가 — 문단 → 줄 → 문장 → 공백 → 서러게이트 쌍을 쪼개지 않는 하드 컷, 그리고 잘린 코드 펜스를 한쪽에서 닫고 다음 쪽에서 다시 여는 것 | `src/shared/messageCut.ts` 의 `cutPoint` / `splitMessages`. 세 표면이 상한만 다르게 건넨다 — 끊긴 자리는 독자가 보는 것이고, 사본 둘은 "문장 중간에서 멈추는가" 에 대한 답 둘이다 |
| 플랫폼 히스토리가 없는 표면이 대화를 어떻게 읽고 적는가 — 턴 수·문자 예산, 턴 하나의 상한, 텍스트 없는 턴과 답 없는 런의 기록, 화자 라벨의 옵트인 | `src/application/messaging/transcriptHistory.ts` |
| 플랫폼 히스토리가 없는 표면의 턴이 어떻게 도는가 — 기억한 대화를 읽고, 파이프라인을 돌리고, 도착 시각으로 두 턴을 적는 것 | `src/application/messaging/rememberedTurn.ts` 의 `runRememberedTurn` / `resolveAgentProject`. Telegram 과 Teams 핸들러는 사람·첨부·도착 시각·답변 대상만 건넨다 |
| 코드 펜스가 열려 있는지 — 조각 경계와 꼬리 붙이기가 렌더러와 같은 답을 내도록 | `src/shared/markdownFence.ts` |
| 선언 없이 온 그림의 종류를 바이트로 알아내기 | `src/domain/llm/imageSniff.ts` |
| 모든 chat-bot 표면에서의 첨부 한도와, 버려진 첨부마다 얻는 문장 | `src/application/messaging/attachments.ts` — 플랫폼이 기여하는 것은 `InboundAttachment.download` 를 통한 바이트뿐이고 그 외에는 없다 |
| 모든 chat-bot 표면이 구현하는 답변 port | `src/domain/messaging/reply.ts` 의 `ReplySink` / `ReplyChannel` — 파이프라인이 그것을 호출하고, 각 어댑터가 그것을 렌더하며, 어느 쪽도 다른 쪽을 import 하지 않는다 |
| 인바운드 이벤트를 정확히 한 번 처리하게 하는 claim-and-settle 계약 | `src/infrastructure/db/repositories/inboundClaimRepository.ts` 의 `createInboundClaimRepository`. Slack 은 `event_id` 로, Telegram 은 project·봇·`update_id` 로, Teams 는 project·App ID·activity id 로 키를 잡고, port 는 `src/domain/messaging/inboundClaims.ts` 의 `InboundEventClaims` 이다 |
| 모든 chat 플랫폼이 공유하는 webhook 꼬리 — claim, ack, 이벤트의 id 아래에서 작업, settle | `src/app/api/_lib/inboundEvent.ts` 의 `admitInboundEvent` |
| Telegram 답변이 어떻게 전달되는가 — Bot API 호출, 4,096자, HTML 로 한 번 렌더하고 plain fallback | `src/application/telegram/replyChannel.ts` (장부는 위의 `editInPlaceReply.ts`) |
| Teams 답변이 어떻게 전달되는가 — activity 를 보내고 갱신하며, Markdown 은 그대로, 그림은 inline `data:` 첨부 | `src/application/teams/replyChannel.ts` |
| 전달된 Bot Framework activity 중 어떤 것이 봇에게 온 것인가 | `src/application/teams/engagement.ts` 의 `classifyTeamsActivity` |
| 이 플랫폼이 사용하는 Bot Framework 표면 | `src/domain/teams/client.ts` 의 `TeamsClientPort`. 어댑터는 `src/infrastructure/teams/client.ts` 이다 |
| Bot Framework 토큰의 검증 — 서명 키, 발급자, audience, `serviceurl` | `src/infrastructure/teams/client.ts` 의 `verifyRequest` |
| 전달된 Telegram update 중 어떤 것이 봇에게 온 것이고, 어떤 것이 명령인가 | `src/application/telegram/engagement.ts` 의 `classifyTelegramUpdate` / `parseTelegramCommand` |
| 이 플랫폼이 사용하는 Telegram Bot API 표면 | `src/domain/telegram/client.ts` 의 `TelegramClientPort`. 어댑터는 `src/infrastructure/telegram/client.ts` 이다 |
| 답변의 Markdown 을 Telegram HTML 로 렌더하기 | `src/application/telegram/markdown.ts` 의 `markdownToTelegramHtml` |
| 바이트가 UTF-8 텍스트인지 판정하기 | `src/shared/utf8Text.ts` |
| 사용자 문서의 상한 | `src/domain/llm/documentLimits.ts` |
| 가져온 URL 이 턴 안에서 어떻게 감싸이는가 | `src/application/llm/documentParts.ts` 의 `framedFetchedUrl` |
| 가져온 URL 을 얼마나 유지하는가 | `src/application/llm/urlContent.ts` 의 `MAX_FETCHED_TEXT_CHARS` |
| 첨부된 문서가 턴 안에서 어떻게 감싸이는가 | `src/application/llm/documentParts.ts` |
| 모든 항목이 불리는 이름 | `src/domain/naming.ts` 의 `isSlug` |

테스트가 패턴으로는 표현하지 못하지만 같은 규칙이 적용되는, 단일 소유자를 갖는 그 밖의
결정들:

| 결정 | 소유자 |
|---|---|
| 모든 DynamoDB 키 문자열 | `src/infrastructure/db/keys.ts` |
| Model 이 무엇이고, 어떤 route 가 그것을 서빙하는가 | **이 저장소 밖** — [opspresso/agent-models](https://github.com/opspresso/agent-models) 의 `models/` (family/offering), `https://models.opspresso.com/models.json` 으로 발행된다. 앱에서는 `src/domain/llm/models.ts` 의 `loadModelCatalog` 가 받아들이는 *유일한 입구* 이고, 숫자는 절대 여기 쓰지 않는다 (`tests/models.test.ts` 가 막는다) |
| 떠나 버린 소비자로부터 스트림을 떼어내기 | `src/shared/detachOnReturn.ts` |
| 바이트 상한 아래에서 HTTP 본문 읽기 | `src/shared/httpBody.ts` |
| tool 의 파일이 실려 다니는 이름과 media type | `src/infrastructure/mcp/toolManager.ts` 의 `safeFileName`/`baseMediaType` |
| 백그라운드 타이머가 프로세스를 붙잡아 두지 않게 하기 | `src/shared/unrefTimer.ts` |
| 페이지네이션된 목록 읽기 | `src/infrastructure/db/query.ts` 의 `queryAll()` |
| 어떤 페이지가 공개인가 | `src/proxy.ts` |
| chunk 가 top-level 인지 여부 | `src/domain/llm/types.ts` 의 `isTopLevelChunk()` |
| 런이 어떤 Version 을 실행하는가 | `src/application/project/` 의 `resolveRunnableVersion` |
| 사용자 이미지의 상한 | `src/domain/llm/imageLimits.ts` |
| `data:` 이미지 인코딩 | `src/domain/llm/types.ts` 의 `imageDataUrl`/`parseImageDataUrl` |
| 저장된 이미지 참조를 주소로 바꾸기 | `src/domain/chat/imageRefs.ts` 의 `resolveImageUrl` |
| 저장된 파일 참조를 다운로드 주소로 바꾸기 | `src/domain/chat/fileRefs.ts` 의 `resolveFileUrl` |
| 런이 만들어 낸 파일을 읽는 사람에게 내주기 | `src/application/artifact/producedFiles.ts` — 테스트가 강제하는 것은 *짝*(출력 축 하나를 읽는 모듈은 다른 축도 읽는다)이고, 이 파일은 이름으로 면제한다. 이 파일의 주제 자체가 그 축이기 때문이다 |
| AWS 로 나가는 요청에 서명하기 | `src/infrastructure/llm/awsSigner.ts` — 대신 `tests/awsSigner.test.ts` 가 못박는다. 이 파일이 만들어 내는 서명을 고정해 두는 테스트다 |
| 서명된 오브젝트 URL 이 읽는 주체별로 얼마나 사는가 | `src/application/artifact/urlTtl.ts` |
| Chat 의 run lease 를 누가 놓는가 | `src/application/chat/runLog.ts` 의 `teeToRunLog` |
| chat 런이 브라우저에 어떻게 닿는가 | `src/app/api/chats/_lib/detachedRun.ts` |
| 행의 TTL | `src/infrastructure/db/ttl.ts` |
| usage 행의 키가 되는 UTC 날짜 | `src/shared/date.ts` 의 `utcDay` |
| repo sync 가 무엇을 했고, 무엇을 사람에게 남겼는가 | `src/domain/sync/types.ts` |
| 브랜드 팔레트와 컴포넌트 기본값 | `src/app/theme.ts` |
| 답변이 스트리밍되는 동안 chat 뷰포트를 누가 소유하는가 | `src/app/chats/_components/ChatThread.tsx` 의 `useStickToBottom` |
| tool 호출을 그에 답한 결과와 짝짓기 | `src/app/_lib/toolPairs.ts` |
| 한 tool 의 트래픽을 한 행으로 그리기 | `src/app/_components/ToolRow.tsx` |
| tool 호출이 사람에게 무엇으로 읽히는가 | `src/app/_lib/toolCalls.ts` 의 `describeTool` |
| 콘솔이 사람에게 보여주는 모든 문자열 | `src/app/_i18n/messages/en.ts` |
| 요청이 어떤 언어로 서빙되는가 | `src/app/_i18n/locale.ts` |
| 플랫폼이 히스토리를 남기지 않을 때 chat-bot 표면이 conversation 에 대해 무엇을 기억하는가 | `src/domain/messaging/transcript.ts` 의 `ConversationTranscriptRepository`. Telegram 과 Teams 핸들러가 `transcriptHistory.ts` 를 통해 쓰고 읽는다 |

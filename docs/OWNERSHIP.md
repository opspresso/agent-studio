# 단일 소유자 불변식

아래의 모든 결정에는 **소유 파일이 하나씩** 있다. `tests/architecture.test.ts` 는 사본이
하나 더 생겨도 실패하고 **소유자가 정의를 잃어도** 실패한다. 규칙이 아무것도 매칭하지
않게 되어 통과한 검사는 깨끗하게 통과한 검사와 똑같이 보이기 때문이다.

이 목록이 존재하는 이유와, 어느 레이어가 어떤 한도를 소유하는지 정하는 규칙은
[../AGENTS.md](../AGENTS.md#single-owner-invariants) 에 있다. **이 중 어느 것이든 쓰기
전에, 사본 두 번째를 만들고 있는 것은 아닌지 확인하라.**

| 결정 | 소유자 |
|---|---|
| MCP tool 의 형태 | `src/domain/mcp/types.ts` |
| 어떤 호스트가 아웃바운드 URL 가드를 건너뛸 수 있는가. 선언된 suffix 에 이름을 맞추는 술어 하나 | `src/domain/security/internalHosts.ts` 의 `isDeclaredInternalHost`. MCP 목록과 `FetchUrl` 목록이 같은 술어를 지나고, provenance(managed 루프백)와 합친 형태는 `src/domain/mcp/types.ts` 의 `skipsUrlGuard` 다 |
| Project 의 client ID 메타데이터 문서가 서빙되는 주소 | `src/application/mcp/mcpAuthUseCases.ts` 의 `clientMetadataUrl`. 여기서 어긋나는 것은 명세상 치명적이다: 문서 자신의 `client_id` 가 그것을 가져온 URL 과 다르면 authorization server 는 거부한다 |
| `plugin.json`/`mcp.json` 의 해석, 그리고 Plugin 이 어떤 MCP transport 를 바인딩할 수 있는가 | `src/domain/plugin/types.ts` |
| Agent Plugins 이름 규칙 | `src/domain/plugin/types.ts` 의 `isPluginName` |
| 어떤 스토리지 에러가 조건부 쓰기의 실패를 뜻하는가 | `src/application/errors.ts` |
| audit 행을 어떻게 쓰는가 | `src/application/audit/recordAudit.ts` |
| 이미지 Model 의 세 가지 토큰 수를 usage 행 하나로 합치기 | `src/domain/llm/models.ts` |
| artifact 행을 어떻게 쓰는가 | `src/application/artifact/storeArtifact.ts` |
| artifact 가 저장되는 오브젝트 키 | `src/domain/artifact/types.ts` 의 `artifactObjectKey` |
| mime 타입에서 파라미터를 떼어낸 형태. 아래 세 규칙이 모두 이것 위에 쓰여 있어 서로 어긋날 수 없다 | `src/domain/artifact/types.ts` 의 `baseMimeType` |
| 저장된 artifact 가 화면에 닿는 방식(쓰인 그대로 / 렌더해서), 그리고 그 상한 | `src/domain/artifact/types.ts` 의 `inlineViewOf` / `MAX_INLINE_VIEW_BYTES` |
| 저장된 artifact 를 그 타입답게 페이지로 만들기 | `src/app/api/artifacts/[artifactId]/view/_lib/viewPage.tsx` |
| 구분자로 나뉜 행의 파싱 (RFC 4180) | `src/app/api/artifacts/[artifactId]/view/_lib/csv.ts` 의 `parseCsv` |
| 어떤 응답이 콘솔의 보안 헤더를 받는가. 여기 선언한 헤더는 라우트가 같은 키로 세운 것을 *대체한다* | `next.config.ts` 의 `SECURITY_HEADERS` 와 그 `source` |
| 런이 파일로 쓸 수 있는 타입과 그 크기 | `src/domain/artifact/types.ts` 의 `SAVABLE_TYPES` / `isSavable` / `MAX_SAVED_FILE_BYTES` |
| 저장된 파일이 독자에게 어떤 이름으로 내려가는가 | `src/domain/artifact/types.ts` 의 `savedFileName` |
| 한 런이 파일을 몇 개까지 쓸 수 있는가 | `src/application/llm/engine.ts` 의 `MAX_SAVED_FILES_PER_RUN`. 이 플랫폼이 고른 루프 한도라 그것을 강제하는 루프 옆에 산다 |
| 한 호출의 인자를 얼마나 보관하고 되풀이하는가 (알려지는 쪽과 프로바이더로 돌아가는 쪽 둘 다) | `src/application/llm/engine.ts` 의 `MAX_TOOL_ARG_BYTES` / `boundToolArgs` / `boundArgumentText` |
| 프로젝트 산출물을 읽을 수 있는 사람. 쓰기와 같은 규칙, 기록만 하지 않는다 | `src/application/project/projectUseCases.ts` 의 `assertProjectOutputReadable` |
| 저장된 오브젝트를 삭제하기 | `src/infrastructure/storage/s3ObjectStore.ts` |
| proxied 오브젝트 주소와 그 토큰. `/api/objects/<key>?exp=&sig=[&dl=]`, HMAC 이 무엇을 덮는가 | `src/infrastructure/storage/objectUrlToken.ts`. 서명자와 라우트가 여기서 합의한다. 두 번째 작성자는 HMAC 이 파일명을 덮는지에 대해 다르게 답할 수 있고, 그것은 답하지 않는 링크이거나 서명되지 않은 이름으로 내려가는 링크다 |
| 상수 시간 시크릿 비교 | `src/shared/timingSafe.ts` |
| 쉼표로 구분된 설정 목록의 파싱 | `src/shared/parseList.ts` |
| 설정된 값이 비어 있는지 여부 | `src/shared/env.ts` |
| provider 에 embedding 을 요청하기 | `src/infrastructure/llm/embeddings.ts` |
| Bedrock 에 닿기 | `src/infrastructure/llm/bedrockClient.ts` |
| vector store 와 이야기하기. cosine 거리 `<=>`, 점수 = 1 − 거리 | `src/infrastructure/vector/pgVectorStore.ts` |
| capability 가 색인되는 키 | `src/domain/catalog/types.ts` 의 `capabilityKey` |
| capability 가 어떤 텍스트로 embedding 되는가 | `src/domain/catalog/types.ts` 의 `capabilityText` |
| 검색이 한 런에 얼마나 더할 수 있는가 | `src/application/execution/bindings.ts` 의 `DISCOVERY_LIMITS` |
| 런이 자기 메모리를 어떻게 준비하는가. 어떤 tool 에게, 무엇으로 묻고, 그 답이 무엇이 되는가 | `src/application/execution/memoryRecall.ts` 의 `recallMemories` / `MAX_RECALLED_CHARS`; 묻는 tool 의 이름과 "바인딩만으로 회상이 불가능한가" 는 `src/domain/project/memoryRecall.ts` 의 `RECALL_TOOL_NAME` / `bindingsMayOfferRecall`. 버전 편집기가 런 전에 같은 답을 읽는다 |
| 런이 무엇으로 카탈로그를 검색하는가 | `src/application/execution/bindings.ts` 의 `discoveryQueries` |
| 마크다운 frontmatter 블록의 파싱 | `src/domain/plugin/frontmatter.ts` |
| repo 소유 컴포넌트의 provenance 문자열(`github:<repo>#<plugin>`) | `src/domain/plugin/types.ts` 의 `pluginSourcePrefix`(sync 가 `startsWith`/`slice` 로 기대는 쪽)·`pluginSource`·`parsePluginSource` |
| 아티팩트 목록의 페이지 커서(= GSI 정렬 키) 철자. 아래 "모든 행 키 문자열" 의 유일한 예외이고, API 가 독자에게 건네는 커서이기도 하기 때문이다 | `src/domain/artifact/repository.ts` 의 `artifactCursor` |
| 호출자가 요청한 페이지 크기를 읽는 법과, 한 페이지가 커질 수 있는 상한 | `src/shared/pageLimit.ts` 의 `parsePageLimit` / `boundedPageLimit` / `MAX_PAGE_LIMIT`. 목록 엔드포인트 넷이 각자 읽던 것이고, 사본들은 정수가 아닌 모든 입력에서 서로 달랐다 — 빈 `?limit=` 은 `Number("")` 가 0 이라 1 로 클램프되어, 갤러리 한 장을 요청한 페이지라고 답했다. 갤러리·chat 사이드바처럼 페이지 크기 자체가 하나의 결정인 곳은 자기 `max` 를 건네고, 리포지토리는 들어오는 값을 같은 규칙으로 다시 묶는다. Project·version·trigger·MCP connection 전체 열거, schedule scan, name-keyed registry와 A2A client key도 자연 키 cursor로 100개씩 읽는다. Better Auth member는 `createdAt + id`, audit day는 `createdAt + eventId`, chat transcript와 run-log replay는 `seq` cursor로 같은 크기를 읽는다. Usage 범위 집계와 Telegram destination 목록은 primary/GSI 정렬 키 cursor로 같은 크기를 내부 순회한다 |
| UTC 날짜를 시각으로 읽는 법, 하루의 길이, 그리고 날짜 범위를 걸어가는 법 | `src/shared/date.ts` 의 `isUtcDay` / `daySpan` / `daysBetween`. 감사 로그·usage 일별 파티션·콘솔 비용 차트가 각자 범위를 걸었고, 넷째는 넓은 범위를 거절하려고 일수를 따로 셌다. 넷이 어긋난 날 하나는 아무것도 쓰이지 않은 키로 던지는 쿼리이거나, 다른 곳에 적힌 행 옆에 그려지는 차트의 기둥이다. 방향(오래된 쪽부터/최근 쪽부터)만 호출자의 것이고, `reverse()` 는 두 번째 걷기가 아니다 |
| subagent 중첩 한도 | `src/application/execution/subagentRunner.ts` |
| catalog 재색인 중 동시에 probe할 MCP 서버 수 | `src/application/catalog/reindexCatalog.ts` 의 `MAX_CONCURRENT_CATALOG_PROBES` |
| plugin snapshot 하나가 동시에 읽을 선택 파일 수 | `src/infrastructure/plugin/snapshot.ts` 의 `MAX_CONCURRENT_PLUGIN_READS` |
| Slack 읽기 하나가 동시에 조회할 프로필 수 | `src/domain/slack/reader.ts` 의 `MAX_CONCURRENT_SLACK_PROFILE_LOOKUPS`. thread caller context와 workspace read tool이 함께 적용한다 |
| schedule 설정 화면이 동시에 읽을 최근 실행 목록 수 | `src/app/projects/[name]/settings/scheduleRuns.ts` 의 `MAX_CONCURRENT_SCHEDULE_RUN_READS` |
| 호출자별 동시 실행 slot 수의 저장 상한 | `src/domain/execution/runSlot.ts` 의 `MAX_RUN_SLOTS` / `boundedRunSlotLimit`. 저장 키의 세 자리 index가 표현하는 `0..999`이며 config와 repository가 함께 적용한다 |
| 런당 MCP tool 상한 | `src/domain/llm/toolLimits.ts` |
| 각 member tier 가 쓸 수 있는 금액 | `src/domain/member/tiers.ts` 의 `TIER_LIMITS` |
| MCP 서버가 보낸 401 이 뜻하는 것 | `src/infrastructure/mcp/session.ts` |
| provider 가 MCP tool 이름으로 받아들이는 이름 | `src/infrastructure/mcp/toolManager.ts` |
| `undici` 에 직접 닿기 | `src/infrastructure/net/publicFetch.ts`. `dispatcher` 는 하나의 fetch 와 그 `Agent` 사이의 사적인 계약이고, 런타임은 전역 `fetch` 뒤에 자기 몫의 undici 를 싣고 다닌다. 둘을 섞은 대가로 모든 아웃바운드 요청이 맨몸의 `TypeError: fetch failed` 를 받았다 |
| 호출하는 Project 를 MCP 서버에 알리는 헤더 | `src/application/execution/mcpTools.ts` 의 `TENANT_ID_HEADER` |
| 런의 conversation 을 MCP 서버에 알리는 헤더 | `src/application/execution/mcpTools.ts` 의 `CONVERSATION_ID_HEADER`. API 레이어는 `src/app/api/projects/_lib/conversation.ts` 에서 같은 철자를 *인바운드* 로 읽고, API Reference 탭(`endpoints.ts`)이 그것을 호출자에게 보여준다. 그 두 파일뿐이다 |
| 런의 conversation 을 어떻게 만들고 무엇으로 키를 삼는가 | `src/domain/execution/actor.ts` 의 `conversationOf` / `conversationKey`. 각 표면의 철자는 저마다 자기 빌더(`chatConversation`, `slackConversation`, `telegramConversation`, `a2aConversation`, `aguiConversation`, `requestConversation`)를 갖지만, 그 전부가 이 둘을 지난다 |
| 한 번의 dispatch 가 몇 개의 Agent 를 실행할 수 있는가 | `src/application/llm/agentAssembly.ts` |
| Agent 런의 프롬프트와 tool 집합을 어떻게 조립하는가 | `src/application/llm/agentAssembly.ts` 의 `assembleAgentRun` |
| Model 의 window 로부터 런의 컨텍스트 예산을 도출하기 | `src/application/llm/contextBudget.ts` |
| 런의 trace 를 샘플링할지 여부 | `src/application/run/traceLifecycle.ts` |
| schedule 이 언제 발화하는지 판정하기 | `src/domain/trigger/cron.ts` |
| Project 의 webhook 이 어디로 전달되는가 | `src/domain/trigger/types.ts` 의 `projectWebhookPath` |
| Project optimistic update 가 경쟁에서 졌을 때의 오류 계약 | `src/application/project/projectUpdate.ts` 의 `persistProjectUpdate` |
| managed workload 이름 규칙 | `src/domain/naming.ts` 의 `MANAGED_NAME` |
| 동시에 도는 generator 를 병합하기 | `src/shared/mergeGenerators.ts` |
| chunk 가 거쳐 온 transfer 사슬을 도출하기 | `src/app/_lib/authorPaths.ts` |
| 사람이 읽을 달러 금액 | `src/app/_lib/formatUsd.ts` 의 `formatUsd`. `SINGLE_OWNERS` 행이 아니라 그 자체가 하나의 규칙으로 강제된다: `app` 안 어디에도 `${…toFixed(…)}` 는 없고 두 `_lib` 포매터만 있다 |
| 사람이 읽을 저장 오브젝트의 크기 | `src/app/_lib/formatBytes.ts` 의 `formatBytes` |
| 사람이 읽을 경과·소요 시간 | `src/app/_lib/duration.ts` 의 `formatSeconds`/`formatDuration`. 단위는 `common.duration*` 카탈로그가 가지므로 어느 페이지든 그대로 쓴다. 진행 중 시계와 끝난 뒤 배지가 같은 규칙(내림)으로 읽히는 것이 이 소유의 요점이다 |
| 저장된 시각 문자열을 밀리초로 읽기 | `src/shared/date.ts` 의 `parsedInstant`. 읽을 수 없는 `createdAt` 은 값이 없는 것이라는 판단을 포매터들과 나눠 갖는다 |
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
| 진행 상황을 포함해 Slack 답변이 어떻게 전달되는가 | `src/application/slack/replyStream.ts`. 보고는 하나이고, 그것을 렌더하는 것은 표면이 가진 메커니즘이다: DM 의 상태 줄이거나 채널 스트림의 `task_update` 축이다. 어느 쪽도 다른 쪽의 정의가 아니다 |
| 전달된 Slack 이벤트 중 어떤 것이 봇에게 온 것인가, loop guard 포함 | `src/application/slack/engagement.ts` |
| Slack 메시지가 무엇을 *말하는가*. `text`·attachment·prose block 을 한 텍스트로 | `src/domain/slack/messageText.ts` 의 `slackMessageText`. 키워드 매칭, 런이 답하는 턴, 스레드 히스토리 셋이 이것을 읽는다. 경보 앱은 제목과 본문을 attachment 에 두므로 `text` 만 읽는 쪽은 헤드라인만 받는다 |
| 어떤 메시지가 질문이 아니라 고정된 명령인가 | `src/application/slack/engagement.ts` 의 `parseSlackCommand`. 의도적으로 엄격하다: 명령은 봇이 다시 말할지 여부를 바꾸고, 매칭이 느슨하면 아무도 침묵시켜 달라 하지 않은 스레드를 침묵시킨다 |
| 런이 사용하는 Slack Web API 표면 | `src/application/slack/types.ts` 의 `SlackClientPort`. 그것이 넘기는 스트리밍 chunk 형태는 `src/domain/slack/types.ts` 의 `SlackChunk` 이고, 어댑터도 거기서 그것들에 닿을 수 있다 |
| 어댑터가 정규화를 마친 뒤 chat-bot 턴이 어떻게 도는가. 첨부는 턴 안으로, chunk 는 sink 위로, 꼬리는 한 가지 순서로 | `src/application/messaging/handleTurn.ts` 의 `handleTurn`. Slack·Telegram·Teams 핸들러는 정규화하고 렌더할 뿐, 어느 쪽도 chunk 를 직접 접어 넣지 않는다 |
| 편집으로 답을 전달하는 표면의 장부. 페이싱, 메시지가 넘칠 때 다음으로 잇기, 거부된 쓰기의 재시도 간격, 마감이 독자에게 빚진 것 | `src/application/messaging/editInPlaceReply.ts` 의 `createEditInPlaceReply`. Telegram 과 Teams 는 호출·상한·렌더링(`EditInPlaceTransport`)만 건넨다 |
| 답이 메시지 하나를 넘칠 때 *어디서* 끊는가. 문단 → 줄 → 문장 → 공백 → 서러게이트 쌍을 쪼개지 않는 하드 컷, 그리고 잘린 코드 펜스를 한쪽에서 닫고 다음 쪽에서 다시 여는 것 | `src/shared/messageCut.ts` 의 `cutPoint` / `splitMessages`. 세 표면이 상한만 다르게 건넨다. 끊긴 자리는 독자가 보는 것이고, 사본 둘은 "문장 중간에서 멈추는가" 에 대한 답 둘이다 |
| 플랫폼 히스토리가 없는 표면이 대화를 어떻게 읽고 적는가. 턴 수·문자 예산, 턴 하나의 상한, 텍스트 없는 턴과 답 없는 런의 기록, 화자 라벨의 옵트인 | `src/application/messaging/transcriptHistory.ts` |
| 플랫폼 히스토리가 없는 표면의 턴이 어떻게 도는가. 기억한 대화를 읽고, 파이프라인을 돌리고, 도착 시각으로 두 턴을 적는 것 | `src/application/messaging/rememberedTurn.ts` 의 `runRememberedTurn` / `resolveAgentProject`. Telegram 과 Teams 핸들러는 사람·첨부·도착 시각·답변 대상만 건넨다 |
| 코드 펜스가 열려 있는지. 조각 경계와 꼬리 붙이기가 렌더러와 같은 답을 내도록 | `src/shared/markdownFence.ts` |
| 선언 없이 온 그림의 종류를 바이트로 알아내기 | `src/domain/llm/imageSniff.ts` |
| 모든 chat-bot 표면에서의 첨부 한도와, 버려진 첨부마다 얻는 문장 | `src/application/messaging/attachments.ts`. 플랫폼이 기여하는 것은 `InboundAttachment.download` 를 통한 바이트뿐이고 그 외에는 없다 |
| 모든 chat-bot 표면이 구현하는 답변 port | `src/domain/messaging/reply.ts` 의 `ReplySink` / `ReplyChannel`. 파이프라인이 그것을 호출하고, 각 어댑터가 그것을 렌더하며, 어느 쪽도 다른 쪽을 import 하지 않는다 |
| 인바운드 이벤트를 정확히 한 번 처리하게 하는 claim-and-settle 계약 | `src/infrastructure/db/repositories/inboundClaimRepository.ts` 의 `createInboundClaimRepository`. Slack 은 `event_id` 로, Telegram 은 project·봇·`update_id` 로, Teams 는 project·App ID·activity id 로 키를 잡고, port 는 `src/domain/messaging/inboundClaims.ts` 의 `InboundEventClaims` 이다 |
| 모든 chat 플랫폼이 공유하는 webhook 꼬리. claim, ack, 이벤트의 id 아래에서 작업, settle | `src/app/api/_lib/inboundEvent.ts` 의 `admitInboundEvent` |
| 인바운드 delivery 가 얼마나 클 수 있는가, 그리고 넘쳤을 때의 거부 | `src/app/api/_lib/inboundEvent.ts` 의 `MAX_INBOUND_EVENT_BYTES` 와 `readEventBody`. webhook 넷(Slack·Telegram·Teams·프로젝트 자신의 것)이 각자 같은 1MB 를 이름 붙이고 있었고, 413 도 저마다 적어 상한을 말하지 않는 유일한 거부가 됐다. 413 본문은 `body.ts` 의 `bodyTooLarge` 가 소유한다 |
| Telegram 답변이 어떻게 전달되는가. Bot API 호출, 4,096자, HTML 로 한 번 렌더하고 plain fallback | `src/application/telegram/replyChannel.ts` (장부는 위의 `editInPlaceReply.ts`) |
| Teams 답변이 어떻게 전달되는가. activity 를 보내고 갱신하며, Markdown 은 그대로, 그림은 inline `data:` 첨부 | `src/application/teams/replyChannel.ts` |
| 전달된 Bot Framework activity 중 어떤 것이 봇에게 온 것인가 | `src/application/teams/engagement.ts` 의 `classifyTeamsActivity` |
| 이 플랫폼이 사용하는 Bot Framework 표면 | `src/domain/teams/client.ts` 의 `TeamsClientPort`. 어댑터는 `src/infrastructure/teams/client.ts` 이다 |
| Bot Framework 토큰의 검증. 서명 키, 발급자, audience, `serviceurl` | `src/infrastructure/teams/client.ts` 의 `verifyRequest` |
| 전달된 Telegram update 중 어떤 것이 봇에게 온 것이고, 어떤 것이 명령인가 | `src/application/telegram/engagement.ts` 의 `classifyTelegramUpdate` / `parseTelegramCommand` |
| 이 플랫폼이 사용하는 Telegram Bot API 표면 | `src/domain/telegram/client.ts` 의 `TelegramClientPort`. 어댑터는 `src/infrastructure/telegram/client.ts` 이다 |
| 답변의 Markdown 을 Telegram HTML 로 렌더하기 | `src/application/telegram/markdown.ts` 의 `markdownToTelegramHtml` |
| 바이트가 UTF-8 텍스트인지 판정하기 | `src/shared/utf8Text.ts` |
| 사용자 문서의 상한 | `src/domain/llm/documentLimits.ts` |
| 가져온 URL 이 턴 안에서 어떻게 감싸이는가 | `src/application/llm/documentParts.ts` 의 `framedFetchedUrl` |
| 가져온 URL 을 얼마나 유지하는가 | `src/application/llm/urlContent.ts` 의 `MAX_FETCHED_TEXT_CHARS` |
| 첨부된 문서가 턴 안에서 어떻게 감싸이는가 | `src/application/llm/documentParts.ts` |
| AG-UI 런의 라이프사이클 이벤트(`RUN_STARTED` / `RUN_FINISHED` / `RUN_ERROR`)를 내보내기. 끝낼 때 무엇이 아직 열려 있는지를 아는 유일한 곳 | `src/application/agui/events.ts` |
| 모든 항목이 불리는 이름 | `src/domain/naming.ts` 의 `isSlug` |

테스트가 패턴으로는 표현하지 못하지만 같은 규칙이 적용되는, 단일 소유자를 갖는 그 밖의
결정들:

| 결정 | 소유자 |
|---|---|
| 모든 행 키 문자열. 아이템 테이블의 `PK`/`SK`/GSI 주소 (파티션 키 전부, 그리고 어댑터 밖으로 나가지 않는 정렬 키. 아티팩트 목록의 정렬 키만 예외, 위 `artifactCursor`) | `src/infrastructure/db/keys.ts` |
| 아이템 테이블에 쓰는 방법. 행 잠금 아래에서 평가되는 조건, 키 순서로 잠그는 트랜잭션, 접두사 쿼리의 상한(`￿`), 만료 행의 sweep | `src/infrastructure/db/store.ts`. 리포지토리는 `items` 에 raw SQL 을 쓰지 않는다. 두 번째 `SELECT … FOR UPDATE` 는 그 셋이 어긋날 두 번째 자리다 |
| 스키마. `items` 와 그 파생 컬럼·부분 인덱스, Better Auth 의 테이블, `catalog_vectors`, 그리고 어느 버전이 적용됐는지 | `src/infrastructure/db/migrations.ts`. 추가만 하는 목록, advisory lock 아래에서 부팅마다 |
| 만료 행을 지우는 틱 | `src/lib/container.ts` 의 `sweepExpiredRows` 가 `store.deleteExpired`(아이템 테이블)와 `memberRepository.deleteExpiredSessions`(Better Auth `session`)를 schedule-scan 틱에서 부른다 (`src/app/api/triggers/scan/route.ts`) |
| Model 이 무엇이고, 어떤 route 가 그것을 서빙하는가 | **이 저장소 밖**. [opspresso/agent-models](https://github.com/opspresso/agent-models) 의 `models/` (family/offering), `https://models.opspresso.com/models.json` 으로 발행된다. 앱에서는 `src/domain/llm/models.ts` 의 `loadModelCatalog` 가 받아들이는 *유일한 입구* 이고, 숫자는 절대 여기 쓰지 않는다 (`tests/models.test.ts` 가 막는다) |
| 떠나 버린 소비자로부터 스트림을 떼어내기 | `src/shared/detachOnReturn.ts` |
| 바이트 상한 아래에서 HTTP 본문 읽기 | `src/shared/httpBody.ts` |
| tool 의 파일이 실려 다니는 이름과 media type | `src/infrastructure/mcp/toolManager.ts` 의 `safeFileName`/`baseMediaType` |
| 백그라운드 타이머가 프로세스를 붙잡아 두지 않게 하기 | `src/shared/unrefTimer.ts` |
| 목록 읽기. 매치 전체를 답하고, 경계는 호출자의 `limit`, 만료 필터는 `LIMIT` 보다 먼저 도는 `notExpiredAt`, 호출자가 가져온 필터도 같은 자리에서 도는 `filter` | `src/infrastructure/db/store.ts` 의 `queryItems()`. `LIMIT` 뒤에서 거르는 목록은 존재하는 행보다 짧게 답하고, 거기서 회복하는 길은 둘 다 틀렸다 — 짧게 답하거나, 어딘가에서 포기해야 하는 루프로 다시 묻거나. 포기한 목록은 끝에 닿은 목록과 똑같이 보인다 |
| Better Auth 의 `user` 행을 멤버로 읽기. 스토어가 소유하지 않는 테이블에 대한 plain SQL | `src/infrastructure/db/repositories/memberRepository.ts` |
| 저장소 트리 하나를 plugins 스냅샷으로. 어느 디렉터리가 plugin·skill·확장 문서인가 | `src/infrastructure/plugin/snapshot.ts` 의 `collectRepoPlugins`. GitHub 클라이언트와 업로드 아카이브는 파일을 어떻게 나열하고 읽는지만 건넨다 |
| 업로드 아카이브로 sync 된 행의 provenance. 설정된 저장소, 없으면 `archive` | `src/domain/plugin/sync.ts` 의 `archiveSyncRepo` / `ARCHIVE_SYNC_REPO`; 브랜치 `archive` 와 commit = sha256 은 `src/infrastructure/plugin/archiveSnapshot.ts` |
| tar 아카이브 읽기. gzip 여부, GNU/pax 긴 이름, 트리를 벗어나는 경로의 거부, 크기·엔트리 상한 | `src/infrastructure/archive/tar.ts` 의 `readTarArchive` |
| 심볼릭 링크의 git 모드. 첨부 수집기가 거부하는 한 가지 엔트리 타입 | `src/domain/skill/files.ts` 의 `SYMLINK_MODE`. GitHub 트리와 아카이브가 같은 값으로 보고한다 |
| admin 이 올린 모델 카탈로그 문서의 자리, 그리고 그것이 발행 카탈로그보다 우선한다는 규칙 | `src/infrastructure/db/keys.ts` 의 `modelCatalog` (행 `MODELCATALOG#doc`), 우선순위는 `src/application/llm/modelCatalogStoredSource.ts` 의 `createCompositeModelCatalogSource`. 부팅 refresher 와 콘솔의 refresh 버튼이 같은 조합을 쓴다 |
| 어떤 로그인 수단이 켜져 있는가 | `src/lib/config.ts` 의 `authProviders`. `auth.ts` 가 그대로 조립하고 로그인 페이지가 그대로 그린다 |
| AG-UI 의 와이어 형태. 받는 `RunAgentInput` 과 내보내는 이벤트 | `src/domain/agui/types.ts` (SDK 대신 직접 선언한 이유가 파일 머리에 있다); 입력 검증은 `src/app/api/agui/_lib/schema.ts` |
| AG-UI 메시지와 `context`·`state` 가 엔진 메시지가 되는 방식 | `src/application/agui/input.ts` |
| OAuth authorization 서버 메타데이터를 찾는 주소와 순서 | `src/infrastructure/mcp/oauthMetadata.ts` 의 `authorizationServerCandidates` |
| A2A task 의 종단·실패·대기 상태가 무엇인가 | `src/domain/a2a/task.ts`. 프로토콜이 정한 사실이라 domain 에 있고, executor·taskStore·client·requestHandler 가 전부 여기를 읽는다 |
| 인바운드 A2A 메시지가 실을 수 있는 part | `src/application/a2a/requestHandler.ts` 의 `unsupportedPart`. card 의 `defaultInputModes` 와 같은 답이어야 한다 |
| 어떤 페이지가 공개인가 | `src/proxy.ts` |
| chunk 가 top-level 인지 여부 | `src/domain/llm/types.ts` 의 `isTopLevelChunk()` |
| 런이 어떤 Version 을 실행하는가 | `src/application/project/` 의 `resolveRunnableVersion` |
| 누가 project 에 접근할 수 있는가 (공개 범위·초대 목록의 판정) | `src/domain/project/access.ts` 의 `mayAccessProject`. admin 오버라이드를 합친 형태는 `projectUseCases.ts` 의 `assertProjectAccessible`/`userMayAccessProject` 뿐이고, 표면들은 그 둘을 지난다 ([SECURITY.md](SECURITY.md#인가-모델)) |
| 사용자 이미지의 상한 | `src/domain/llm/imageLimits.ts` |
| `data:` 이미지 인코딩 | `src/domain/llm/types.ts` 의 `imageDataUrl`/`parseImageDataUrl` |
| 저장된 이미지 참조를 주소로 바꾸기 | `src/domain/chat/imageRefs.ts` 의 `resolveImageUrl` |
| 저장된 파일 참조를 다운로드 주소로 바꾸기 | `src/domain/chat/fileRefs.ts` 의 `resolveFileUrl` |
| 런이 만들어 낸 파일을 읽는 사람에게 내주기 | `src/application/artifact/producedFiles.ts`. 테스트가 강제하는 것은 *짝*(출력 축 하나를 읽는 모듈은 다른 축도 읽는다)이고, 이 파일은 이름으로 면제한다. 이 파일의 주제 자체가 그 축이기 때문이다 |
| AWS 로 나가는 요청에 서명하기 | `src/infrastructure/llm/awsSigner.ts`. 대신 `tests/awsSigner.test.ts` 가 못박는다. 이 파일이 만들어 내는 서명을 고정해 두는 테스트다 |
| 서명된 오브젝트 URL 이 읽는 주체별로 얼마나 사는가 | `src/application/artifact/urlTtl.ts` |
| Chat 의 run lease 를 누가 놓는가 | `src/application/chat/runLog.ts` 의 `teeToRunLog` |
| Chat 목록을 한 번에 몇 개 읽는가, 그리고 최대 몇 개까지 허용하는가 | `src/domain/chat/repository.ts` 의 `CHAT_PAGE` / `MAX_CHAT_PAGE`. use case 의 기본값, 엔드포인트의 상한, 사이드바 "더 보기"의 증가폭이 모두 같은 결정이고, `domain` 은 셋 다 닿을 수 있는 유일한 계층이다(순수 TS 라 클라이언트 번들에 들어가도 된다) |
| Chat 메시지를 꼬리부터 읽는 정렬 키 범위 | `src/infrastructure/db/keys.ts` 의 `chatMessageRange`. 하한 클램프까지 포함해서 |
| 꼬리로 읽어 온 메시지를 화면의 것과 어떻게 합치는가 | `src/app/chats/_lib/mergeMessages.ts` |
| chat 런이 브라우저에 어떻게 닿는가 | `src/app/api/chats/_lib/detachedRun.ts` |
| 행의 `expiresAt`. 보존 창과 그것을 초로 바꾸는 헬퍼 | `src/infrastructure/db/ttl.ts` |
| usage 행의 키가 되는 UTC 날짜 | `src/shared/date.ts` 의 `utcDay` |
| repo sync 가 무엇을 했고, 무엇을 사람에게 남겼는가 | `src/domain/sync/types.ts` |
| 브랜드 팔레트와 컴포넌트 기본값 | `src/app/theme.ts` |
| 답변이 스트리밍되는 동안 chat 뷰포트를 누가 소유하는가 | `src/app/chats/_components/ChatThread.tsx` 의 `useStickToBottom` |
| tool 호출을 그에 답한 결과와 짝짓기 | `src/app/_lib/toolPairs.ts` |
| 한 tool 의 트래픽을 한 행으로 그리기 | `src/app/_components/ToolRow.tsx` |
| 런의 추론을 한 블록으로 그리기 | `src/app/_components/ReasoningRow.tsx` |
| 토큰 속도로 오는 텍스트를 커밋 단위로 묶기 | `src/app/_lib/textPacer.ts` |
| tool 호출이 사람에게 무엇으로 읽히는가 | `src/app/_lib/toolCalls.ts` 의 `describeTool` |
| 콘솔이 사람에게 보여주는 모든 문자열 | `src/app/_i18n/messages/en.ts` |
| 요청이 어떤 언어로 서빙되는가 | `src/app/_i18n/locale.ts` |
| 플랫폼이 히스토리를 남기지 않을 때 chat-bot 표면이 conversation 에 대해 무엇을 기억하는가 | `src/domain/messaging/transcript.ts` 의 `ConversationTranscriptRepository`. Telegram 과 Teams 핸들러가 `transcriptHistory.ts` 를 통해 쓰고 읽는다 |

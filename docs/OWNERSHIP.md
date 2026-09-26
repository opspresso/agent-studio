# 단일 소유자 불변식

상수·wire 형태·키·포맷·정책을 추가하기 전에 해당 결정의 소유자를 찾는다.
타입·정책·어댑터가 서로 다른 책임을 가진 경우에는 각 역할을 구분해 적었다.
레이어 선택 기준은 [AGENTS.md](../AGENTS.md#single-ownership), 전체 관계는 [아키텍처](ARCHITECTURE.md)를 따른다.

확인 열의 **구조**는 `tests/architecture.test.ts`의 단일 소유·호출 범위 등 구조 검사와
연결된 결정, **코드**는 구현과 개별 회귀 검사·리뷰에서 확인할 추가 소유 계약이다.
검사 대상·패턴·예외의 정본은 테스트 코드다. 표에 있다는 이유만으로 모든 소비 경로가 자동 검증된다고 보지 않는다.

[실행·모델·검색](#실행모델검색) · [Chat·Workspace](#chatworkspace) · [파일·문서·오디오](#파일문서오디오) · [메시징](#메시징) · [MCP·Plugin·프로토콜](#mcpplugin프로토콜) · [보안·설정](#보안설정) · [저장·공통·화면](#저장공통화면)

## 실행·모델·검색

| 결정 | 소유자 | 확인 |
|---|---|---|
| 호출 단위 모델 tier·작업 목적·전역 정책 형태와 기본값 | `src/domain/llm/callRouting.ts`; Agent는 boolean 사용 여부만 저장한다 | 구조 |
| 전역 라우팅 정책 저장·검증과 모델 삭제 가드 | `src/application/llm/modelRegistry.ts`, `callRoutingPolicy.ts` | 코드 |
| 보조 호출 모델 우선순위·후보 중복 제거·확률 비교·권한·기능·예산·출력 구조·승격·fallback | `src/application/llm/callModelRouter.ts`; context 추정은 기존 `contextBudget.ts`를 사용한다 | 코드 |
| ModelTask의 SDK 호출·청구·안전한 라우팅 trace | `src/application/runtime/modelTask.ts`; 모델 usage 해석은 `modelUsage.ts`, 로컬 span 변환은 `tracing.ts` | 코드 |
| 실행의 첫 응답을 확인한 뒤 경고를 먼저 전달하고 조기 종료 시 원본 실행을 닫기 | `src/application/run/leadingWarnings.ts` 의 `withLeadingWarnings`. Chat과 실행 API가 같은 첫 응답·종료 계약을 사용한다 | 구조 |
| 이미지 Model 의 세 가지 토큰 수를 usage 행 하나로 합치기 | `src/domain/llm/models.ts` | 구조 |
| 한 런이 파일을 몇 개까지 쓸 수 있는가 | `src/application/runtime/tools.ts` 의 `MAX_SAVED_FILES_PER_RUN`. 이 플랫폼이 고른 루프 한도라 그것을 강제하는 루프 옆에 산다 | 구조 |
| 한 호출의 인자를 얼마나 보관하고 되풀이하는가 (알려지는 쪽과 프로바이더로 돌아가는 쪽 둘 다) | `src/application/runtime/arguments.ts` 의 `MAX_TOOL_ARG_BYTES` / `boundToolArgsPair` / `boundArgumentText` | 구조 |
| Embedding/Rerank 선택 모델의 endpoint·credential·wire ID 결정 | `src/lib/runtime-settings.ts`의 `getEmbeddingTarget` / `getRerankerTarget`. 등록 모델의 provider 연결을 사용한다 | 구조 |
| provider 에 embedding 을 요청하기 | `src/infrastructure/llm/embeddings.ts` | 구조 |
| 전사 모델의 endpoint·credential·wire ID·응답 형식 결정 | `src/lib/runtime-settings.ts`의 `getTranscriptionTarget` | 구조 |
| 전사 사용량의 시간/토큰 단위 비용 계산 | `src/domain/llm/models.ts`의 `calculateTranscriptionCost`. 누락된 과금 단위는 unknown이다 | 구조 |
| 배포 전역 Embedding/Rerank 모델 선택과 Embedding 변경 시 vector migration | `src/application/llm/modelSelection.ts`; DB의 모델 선택·미설정 상태 해석은 `src/lib/runtime-settings.ts` | 구조 |
| vector 후보를 2차 정렬하기 | 요청/응답 프로토콜은 `src/infrastructure/llm/reranker.ts`, 어느 후보·텍스트·과업 instruction을 보내고 상대 하한으로 자를지는 `src/application/catalog/searchCatalog.ts` | 구조 |
| vector store 와 이야기하기. cosine 거리 `<=>`, 점수 = 1 − 거리 | `src/infrastructure/vector/pgVectorStore.ts` | 구조 |
| capability 가 색인되는 키 | `src/domain/catalog/types.ts` 의 `capabilityKey` | 구조 |
| capability 가 어떤 텍스트로 embedding 되는가 | `src/domain/catalog/types.ts` 의 `capabilityText` | 구조 |
| 검색이 한 런에 얼마나 더할 수 있는가 | `src/application/execution/bindings.ts` 의 `DISCOVERY_LIMITS` | 구조 |
| 런이 자기 메모리를 어떻게 준비하는가. 언제 준비하고, 어떤 tool 에게 무엇으로 묻고, 그 답이 무엇이 되는가 | `src/application/execution/memoryRecall.ts` 의 `prepareMemoryForRun` / `recallMemories` / `MAX_RECALLED_CHARS`; 묻는 tool 의 이름과 "바인딩만으로 회상이 불가능한가" 는 `src/domain/agent/memoryRecall.ts` 의 `RECALL_TOOL_NAME` / `bindingsMayOfferRecall`. Agent 설정 편집기가 런 전에 같은 답을 읽는다 | 구조 |
| 런이 무엇으로 카탈로그를 검색하는가 | `src/application/execution/bindings.ts` 의 `discoveryQueries` — 원래 요청과 회상으로 보강한 검색 문맥의 한도·조합 | 구조 |
| subagent 중첩 한도 | `src/application/execution/agentBindings.ts` | 구조 |
| MCP 기본 파일 매핑 선택과 연결별 namespace | `src/application/execution/mcpTools.ts`; Agent 설정이 없을 때만 레지스트리 기본값을 사용한다 | 구조 |
| 매핑된 MCP 도구의 모델용 응답 계약 | `src/application/audio/mapMcpSource.ts`의 `MCP_SOURCE_RESULT_DESCRIPTION`; 실행 바인딩이 해당 alias의 설명에만 덧붙인다 | 구조 |
| 호출자별 동시 실행 slot 수의 저장 상한 | `src/domain/execution/runSlot.ts` 의 `MAX_RUN_SLOTS` / `boundedRunSlotLimit`. 저장 키의 세 자리 index가 표현하는 `0..999`이며 config와 repository가 함께 적용한다 | 구조 |
| 런의 conversation 을 어떻게 만들고 무엇으로 키를 삼는가 | `src/domain/execution/actor.ts` 의 `conversationOf` / `conversationKey`. 각 표면의 철자는 저마다 자기 빌더(`chatConversation`, `slackConversation`, `telegramConversation`, `requestConversation`)를 갖지만, 그 전부가 이 둘을 지난다 | 구조 |
| SDK function tool 동시 실행 수 | `src/application/runtime/runner.ts`의 `MAX_FUNCTION_TOOL_CONCURRENCY` | 구조 |
| Agent 런의 프롬프트와 tool 집합을 어떻게 조립하는가 | `src/application/llm/agentAssembly.ts` 의 `assembleAgentRun` | 구조 |
| Model 의 window 로부터 런의 컨텍스트 예산을 도출하기 | `src/application/llm/contextBudget.ts` | 구조 |
| Agent 실행 Trace의 생성과 종료 | `src/application/run/traceLifecycle.ts` | 코드 |
| 사람이 읽을 경과·소요 시간 | `src/app/_lib/duration.ts` 의 `formatSeconds`/`formatDuration`. 단위는 `common.duration*` 카탈로그가 가지므로 어느 페이지든 그대로 쓴다. 진행 중 시계와 끝난 뒤 배지가 같은 규칙(내림)으로 읽히는 것이 이 소유의 요점이다 | 구조 |
| top-level 런을 감싸는 것 | `src/application/run/runBracket.ts` | 구조 |
| Agent 실행과 완료 응답 수집 | `src/application/execution/runAgent.ts` | 코드 |
| 런의 프롬프트가 자기 caller 를 이름으로 불러도 되는가 | `src/application/execution/deps.ts` 의 `callerFor` | 구조 |
| tool 결과가 무엇을, 어떤 순서로 해야 하는가 | `src/application/runtime/output.ts` 의 `writeToolResult` | 구조 |
| SDK Agent·Handoff·Agent-as-Tool 조립과 동시 호출의 identity | `src/application/runtime/agent.ts`, `boundAgent.ts`; SDK가 실행을 소유하고 앱이 호출별 자원을 연결한다 | 코드 |
| Workspace Runtime 모델 선택·호환성 | `domain/workspace/runtimeModels.ts`; 저장은 `application/workspace/runtimeModels.ts`, 실행 자격증명은 `lib/runtime-settings.ts` | 코드 |
| 모델 이력·승인 체크포인트·revision과 저장 예산 | `src/application/runtime/session.ts`; 저장 CAS와 tombstone은 `src/infrastructure/db/repositories/runtimeSessionRepository.ts` | 코드 |
| SDK native span의 로컬 수집과 안전한 메타데이터 변환 | `src/application/runtime/tracing.ts` | 코드 |
| Agent의 입력 Guardrail과 Handoff 대상 검사 | `src/application/runtime/policy.ts`; 도구 정책은 SDK 도구 조립에 적용한다 | 코드 |
| 선택적 실행 도구의 권한 거부와 권한 조회 실패 구분 | `src/application/execution/optionalToolAccess.ts`; Workspace·오디오 조립은 같은 판정을 사용한다 | 코드 |
| 현재 PostgreSQL 스키마. `items`와 파생 컬럼·부분 인덱스, Better Auth 테이블, `catalog_vectors`, `runtime_sessions`, 기준선 버전 | `src/infrastructure/db/migrations.ts`. 빈 DB를 advisory lock 아래 초기화하고 다른 스키마는 거부한다 | 코드 |
| 선택된 모델의 facts와 실행 레지스트리 | 저장 형태·검증은 `src/domain/llm/providerModels.ts`, runtime facts·가격 계산은 `src/domain/llm/models.ts`, 선택·삭제는 `src/application/llm/modelRegistry.ts`가 소유한다 | 코드 |
| 내부 self-hosted 모델의 유형·modality·기능 해석 | `src/infrastructure/llm/providerModelDiscovery.ts`; 명시적 메타데이터를 이름 추정보다 우선한다 | 코드 |
| 공개 모델 카탈로그 조회·검증·공개 ID와 전송 ID 매핑·가격 | `src/infrastructure/llm/publishedModelFacts.ts`; `scripts/sync-models.ts`가 오프라인 스냅샷을 갱신한다 | 코드 |
| 모델 카드·다중 기능 배지·검색·정렬 | `src/app/models/ModelCollection.tsx`, `modelTable.ts`; 단가 표시는 `src/app/_components/modelOptions.tsx` | 코드 |
| 어떤 모델이 새 선택에 보이는가 | `src/domain/llm/models.ts`의 `offeredModels`. 관리자가 등록한 모델과 연결의 교집합이며 기본 모델을 우선한다 | 코드 |
| 모델 즐겨찾기의 개인 범위와 상한 | `src/domain/llm/modelPreferences.ts` 의 `ModelPreferencesRepository` / `MAX_FAVORITE_MODELS`. user id 별 한 행이며 picker 그룹화는 `src/app/_components/modelOptions.tsx` 의 `modelSelectData` 가 소유한다 | 코드 |
| 누가 agent 에 접근할 수 있는가 (공개 범위·초대 목록의 판정) | `src/domain/agent/access.ts` 의 `mayAccessAgent`. admin 오버라이드를 합친 형태는 `agentUseCases.ts` 의 `assertAgentAccessible`/`userMayAccessAgent` 뿐이고, 표면들은 그 둘을 지난다 ([SECURITY.md](SECURITY.md#인가-모델)) | 코드 |
| 모델이 파일 ID로 읽거나 편집할 수 있는 범위 | `src/application/document/fileTool.ts`의 actor·시작 agent 검사. ID 자체는 접근 권한이 아니다 | 코드 |

## Chat·Workspace

| 결정 | 소유자 | 확인 |
|---|---|---|
| Slack 읽기 하나가 동시에 조회할 프로필 수 | `src/domain/slack/reader.ts` 의 `MAX_CONCURRENT_SLACK_PROFILE_LOOKUPS`. thread caller context와 workspace read tool이 함께 적용한다 | 구조 |
| 어댑터가 정규화를 마친 뒤 chat-bot 턴이 어떻게 도는가. 첨부는 턴 안으로, chunk 는 sink 위로, 꼬리는 한 가지 순서로 | `src/application/messaging/handleTurn.ts` 의 `handleTurn`. Slack·Telegram·Teams 핸들러는 정규화하고 렌더할 뿐, 어느 쪽도 chunk 를 직접 접어 넣지 않는다 | 구조 |
| 모든 chat-bot 표면에서의 첨부 한도와, 버려진 첨부마다 얻는 문장 | `src/application/messaging/attachments.ts`. 플랫폼이 기여하는 것은 `InboundAttachment.download` 를 통한 바이트뿐이고 그 외에는 없다 | 구조 |
| 모든 chat-bot 표면이 구현하는 답변 port | `src/domain/messaging/reply.ts` 의 `ReplySink` / `ReplyChannel`. 파이프라인이 그것을 호출하고, 각 어댑터가 그것을 렌더하며, 어느 쪽도 다른 쪽을 import 하지 않는다 | 구조 |
| 모든 chat 플랫폼이 공유하는 webhook 꼬리. claim, ack, 이벤트의 id 아래에서 작업, settle | `src/app/api/_lib/inboundEvent.ts` 의 `admitInboundEvent` | 구조 |
| 일반 작업과 코딩 작업의 Workspace·Sandbox·Runtime Session·Run 계약 | `src/domain/workspace/`; Git 저장소와 PR·승인 형태는 `src/domain/coding/types.ts` | 코드 |
| Workspace Agent 설정·저장소 범위·기본값 | `src/domain/workspace/policy.ts`; 읽기·소유자/관리자 쓰기는 `application/workspace/repositoryPolicy.ts`, 도구 활성 여부는 `domain/agent/workspaceAccess.ts` | 코드 |
| 사용자에게 제시할 Workspace Agent 옵션과 정책 조회 상한 | `src/application/workspace/workspaceOptions.ts`; 접근 가능한 Agent 목록과 정책 repository는 조립 지점에서 주입한다 | 코드 |
| 신규 저장소 생성과 자동 등록의 증거·중복 방지 | `application/workspace/createRepository.ts`; GitHub 201 응답 검증은 `infrastructure/github/codingForge.ts`, 결과와 정책 transaction은 `workspaceRepositoryCreationStore.ts` | 코드 |
| 도구 결과의 실패 표시와 trace 오류 판정 | `src/shared/toolResultStatus.ts`의 `isToolErrorText`. Runtime의 `Error:` 결과를 Chat·Playground에도 실패로 표시한다 | 코드 |
| Native 코딩 턴에 전달하는 Workspace Git 승인 경계 지침 | `src/application/workspace/taskInput.ts` | 코드 |
| Workspace admission과 중복 요청의 동일성 | `src/application/workspace/workspaceUseCases.ts`; revision·receipt·이벤트의 원자적 쓰기는 `src/infrastructure/db/repositories/workspaceRepository.ts` | 코드 |
| 원래 Chat의 Agent별 Workspace 선택과 동시 생성 차단 | `Chat.linkedWorkspaces`; `workspaceUseCases.startForChat`과 `workspaceRepository`의 source Chat transaction | 코드 |
| GitHub Webhook HMAC-SHA256 서명과 delivery ID 형식 | `src/shared/githubWebhook.ts`; Agent Trigger와 Workspace 메타데이터 Webhook은 각자 시크릿을 해석하고 같은 검증을 사용한다 | 코드 |
| Workspace 승인 결과의 원래 Chat 전달과 단일 후속 실행 | `CodingApproval.sourceChatId`, `domain/workspace/continuation.ts`; `workspaceRepository`의 원자적 알림과 `application/chat/workspaceContinuation.ts` 소비자 | 코드 |
| Workspace 명령과 검사에 공통인 셸 실패 처리 | `src/shared/workspaceShell.ts` | 코드 |
| Workspace 체크포인트의 저장 상한과 암호화 주소 | `src/domain/workspace/limits.ts`, `src/domain/security/secretContext.ts`; 청크·manifest 저장과 무결성 검사는 `src/infrastructure/db/repositories/workspaceCheckpointStore.ts` | 코드 |
| 저장된 이미지 참조를 주소로 바꾸기 | `src/domain/chat/imageRefs.ts` 의 `resolveImageUrl` | 코드 |
| 저장된 파일 참조를 다운로드 주소로 바꾸기 | `src/domain/chat/fileRefs.ts` 의 `resolveFileUrl` | 코드 |
| Chat 의 run lease 를 누가 놓는가 | `src/application/chat/runLog.ts` 의 `teeToRunLog` | 코드 |
| Chat 목록을 한 번에 몇 개 읽는가, 그리고 최대 몇 개까지 허용하는가 | `src/domain/chat/repository.ts` 의 `CHAT_PAGE` / `MAX_CHAT_PAGE`. use case 의 기본값, 엔드포인트의 상한, 탭별 사이드바 "더 보기"의 증가폭이 모두 같은 결정이고, `domain` 은 셋 다 닿을 수 있는 유일한 계층이다(순수 TS 라 클라이언트 번들에 들어가도 된다) | 코드 |
| Chat 메시지를 꼬리부터 읽는 정렬 키 범위 | `src/infrastructure/db/keys.ts` 의 `chatMessageRange`. 하한 클램프까지 포함해서 | 코드 |
| 꼬리로 읽어 온 메시지를 화면의 것과 어떻게 합치는가 | `src/app/chats/_lib/mergeMessages.ts` | 코드 |
| chat 런이 브라우저에 어떻게 닿는가 | `src/app/api/chats/_lib/detachedRun.ts` | 코드 |
| 답변이 스트리밍되는 동안 chat 뷰포트를 누가 소유하는가 | `src/app/chats/_components/ChatThread.tsx` 의 `useLatestScroll`; 첫 진입과 하단 추적 규칙은 `src/app/_lib/useLatestScroll.ts` | 코드 |
| 플랫폼이 히스토리를 남기지 않을 때 chat-bot 표면이 conversation 에 대해 무엇을 기억하는가 | `src/domain/messaging/transcript.ts` 의 `ConversationTranscriptRepository`. Telegram 과 Teams 핸들러가 `transcriptHistory.ts` 를 통해 쓰고 읽는다 | 코드 |

## 파일·문서·오디오

| 결정 | 소유자 | 확인 |
|---|---|---|
| Agent 의 client ID 메타데이터 문서가 서빙되는 주소 | `src/application/mcp/mcpAuthUseCases.ts` 의 `clientMetadataUrl`. 여기서 어긋나는 것은 명세상 치명적이다: 문서 자신의 `client_id` 가 그것을 가져온 URL 과 다르면 authorization server 는 거부한다 | 구조 |
| artifact 행을 어떻게 쓰는가 | `src/application/artifact/storeArtifact.ts` | 구조 |
| 비공개 파일의 Artifact 등록과 원본 보존 기한 연결 | `src/application/artifact/storeArtifact.ts`의 `registerSourceArtifact`. 바이트 복사 없이 `privateFileId`로 연결하며 checkpoint를 제외한다 | 구조 |
| artifact 가 저장되는 오브젝트 키 | `src/domain/artifact/types.ts` 의 `artifactObjectKey` | 구조 |
| 비공개 파일의 오브젝트 키·경로 판정 | `src/domain/artifact/sourceFile.ts`의 `sourceFileObjectKey`·`isSourceFileObjectKey`. 일반 object 접근 거절은 `domain/artifact/objectStore.ts`의 `assertNotPrivateFileKey` | 구조 |
| 파일의 달력 일·월 보존 기간과 월말·DST 만료 계산 | `src/application/artifact/fileRetention.ts` 의 `fileExpiresAt`. 시간대 해석은 기존 `domain/trigger/cron.ts`의 `wallClock`을 사용한다 | 구조 |
| mime 타입에서 파라미터를 떼어낸 형태. 아래 세 규칙이 모두 이것 위에 쓰여 있어 서로 어긋날 수 없다 | `src/domain/artifact/types.ts` 의 `baseMimeType` | 구조 |
| 저장된 artifact 가 화면에 닿는 방식(쓰인 그대로 / 렌더해서), 그리고 그 상한 | `src/domain/artifact/types.ts` 의 `inlineViewOf` / `MAX_INLINE_VIEW_BYTES` | 구조 |
| 저장된 artifact 를 그 타입답게 페이지로 만들기 | `src/app/api/artifacts/[artifactId]/view/_lib/viewPage.tsx` | 구조 |
| 구분자로 나뉜 행의 파싱 (RFC 4180) | `src/app/api/artifacts/[artifactId]/view/_lib/csv.ts` 의 `parseCsv` | 구조 |
| 런이 파일로 쓸 수 있는 타입과 그 크기 | `src/domain/artifact/types.ts` 의 `SAVABLE_TYPES` / `isSavable` / `MAX_SAVED_FILE_BYTES` | 구조 |
| 저장된 파일이 독자에게 어떤 이름으로 내려가는가 | `src/domain/artifact/types.ts` 의 `savedFileName` | 구조 |
| 일반 산출물 오브젝트를 삭제하기 | `src/infrastructure/storage/s3ObjectStore.ts` | 구조 |
| 비공개 source 본문 제거와 지연 업로드 재생성 차단 | `src/infrastructure/storage/sourceObjectStore.ts` 의 `delete`. 0바이트 표식으로 키를 유지하며 source 읽기에서는 없는 파일로 취급한다 | 구조 |
| proxied 오브젝트 주소와 그 토큰. `/api/objects/<key>?exp=&sig=[&dl=]`, HMAC 이 무엇을 덮는가 | `src/infrastructure/storage/objectUrlToken.ts`. 키·만료·다운로드 파일명을 같은 HMAC 계약으로 서명·검증한다 | 구조 |
| 아티팩트 목록의 페이지 커서(= GSI 정렬 키) 철자. 아래 "모든 행 키 문자열" 의 유일한 예외이고, API 가 독자에게 건네는 커서이기도 하기 때문이다 | `src/domain/artifact/repository.ts` 의 `artifactCursor` | 구조 |
| plugin snapshot 하나가 동시에 읽을 선택 파일 수 | `src/infrastructure/plugin/snapshot.ts` 의 `MAX_CONCURRENT_PLUGIN_READS` | 구조 |
| plugin 기본 파일 응답 매핑 선언·검증 | `src/domain/plugin/types.ts`의 `STUDIO_PLUGIN_EXTENSION`, `src/domain/mcp/sourceMapping.ts`의 `isMcpSourceMappings` | 구조 |
| 오디오 도구의 작업별 입력 shape | `src/application/audio/toolDefinitions.ts`; `AudioJob.request`의 operation별 union | 구조 |
| 오디오 Agent 큐의 접수 순서·due 인덱스·직렬 claim | `src/infrastructure/db/repositories/audioJobRepository.ts`; 큐 첫 작업만 실행하고 작업 전이와 큐 갱신을 transaction으로 묶는다 | 구조 |
| 오디오 작업 화면의 동시 상태 조회 수와 갱신 병합 | `src/app/agents/[name]/audio/jobPolling.ts`의 `MAX_CONCURRENT_AUDIO_JOB_READS`와 `mergeAudioJobUpdates` | 구조 |
| 아웃바운드 MCP 요청의 예약 metadata 헤더 — 철자, 저장된 표기 제거, actor→email 판정 | `src/application/mcpMetadataHeaders.ts` 의 `TENANT_ID_HEADER` / `USER_EMAIL_HEADER` / `CONVERSATION_ID_HEADER` / `stripMcpMetadataHeaders` / `mcpUserEmail` / `applyMcpUserEmail`. API 레이어는 `src/app/api/agents/_lib/conversation.ts` 에서 conversation 철자를 *인바운드* 로 읽고, API Reference 탭(`endpoints.ts`)이 그것을 호출자에게 보여준다. 그 두 파일뿐이다 | 구조 |
| Agent 변경 시각의 단조 증가 | `src/shared/nextUpdatedAt.ts`. Agent 수정과 오디오 후처리 참조의 삭제 방지 transaction이 함께 사용한다 | 구조 |
| 사람이 읽을 저장 오브젝트의 크기 | `src/app/_lib/formatBytes.ts` 의 `formatBytes` | 구조 |
| 선언 없이 온 그림의 종류를 바이트로 알아내기 | `src/domain/llm/imageSniff.ts` | 구조 |
| Teams 답변이 어떻게 전달되는가. activity 를 보내고 갱신하며, Markdown 은 그대로, 그림은 inline `data:` 첨부 | `src/application/teams/replyChannel.ts` | 구조 |
| 바이트가 UTF-8 텍스트인지 판정하기 | `src/shared/utf8Text.ts` | 구조 |
| 사용자 문서의 상한 | `src/domain/llm/documentLimits.ts` | 구조 |
| Office 문서 파싱과 렌더링 | `src/infrastructure/documents/engine/` — 프로토콜·저장소와 독립적인 내부 엔진. 첨부 추출은 `src/infrastructure/llm/documentExtractor.ts`가 연결한다 | 구조 |
| 첨부된 문서가 턴 안에서 어떻게 감싸이는가 | `src/application/llm/documentParts.ts` | 구조 |
| 모든 행 키 문자열. 아이템 테이블의 `PK`/`SK`/GSI 주소 (파티션 키 전부, 그리고 어댑터 밖으로 나가지 않는 정렬 키. 아티팩트 목록의 정렬 키만 예외, 위 `artifactCursor`) | `src/infrastructure/db/keys.ts` | 코드 |
| tool 의 파일이 실려 다니는 이름과 media type | `src/infrastructure/mcp/toolManager.ts` 의 `safeFileName`/`baseMediaType` | 코드 |
| 저장소 트리 하나를 plugins 스냅샷으로. 어느 디렉터리가 plugin·skill·확장 문서인가 | `src/infrastructure/plugin/snapshot.ts` 의 `collectRepoPlugins`. GitHub 클라이언트와 업로드 아카이브는 파일을 어떻게 나열하고 읽는지만 건넨다 | 코드 |
| 사용자 이미지의 상한 | `src/domain/llm/imageLimits.ts` | 코드 |
| inline payload의 base64 문법과 decoded byte 길이 계산 | `src/domain/llm/base64.ts`. 이미지 data URL과 일반 첨부가 같은 판정을 읽는다 | 코드 |
| `data:` 이미지 인코딩 | `src/domain/llm/imageLimits.ts`의 `imageDataUrl` / `parseImageDataUrl`; `types.ts`가 재노출한다 | 코드 |
| 런이 만들어 낸 파일을 읽는 사람에게 내주기 | `src/application/artifact/producedFiles.ts`. 테스트가 강제하는 것은 *짝*(출력 축 하나를 읽는 모듈은 다른 축도 읽는다)이고, 이 파일은 이름으로 면제한다. 이 파일의 주제 자체가 그 축이기 때문이다 | 코드 |
| AWS 로 나가는 요청에 서명하기 | `src/infrastructure/llm/awsSigner.ts`. 대신 `tests/awsSigner.test.ts` 가 못박는다. 이 파일이 만들어 내는 서명을 고정해 두는 테스트다 | 코드 |
| 서명된 오브젝트 URL 이 읽는 주체별로 얼마나 사는가 | `src/shared/artifactUrlTtl.ts` | 코드 |

## 메시징

| 결정 | 소유자 | 확인 |
|---|---|---|
| 진행 상황을 포함해 Slack 답변이 어떻게 전달되는가 | `src/application/slack/replyStream.ts`. 보고는 하나이고, 그것을 렌더하는 것은 표면이 가진 메커니즘이다: DM 의 상태 줄이거나 채널 스트림의 `task_update` 축이다. 어느 쪽도 다른 쪽의 정의가 아니다 | 구조 |
| Slack 출력에서 어떤 mrkdwn token이 알림 권한을 갖는가 | `src/domain/slack/outboundText.ts`의 `neutralizeSlackMentions`. 실제 Slack Web API 어댑터가 post, update, stream의 모든 텍스트 축에 적용한다 | 구조 |
| 전달된 Slack 이벤트 중 어떤 것이 봇에게 온 것인가, loop guard 포함 | `src/application/slack/engagement.ts` | 구조 |
| Slack 실행의 replica 간 중단 전달과 지연 이벤트 범위 | `domain/slack/runControl.ts`의 timestamp·repository 계약, `application/slack/watchStop.ts`의 확인 주기, `infrastructure/db/repositories/slackRunControlRepository.ts`의 최신 시각 원자적 저장 | 코드 |
| Slack 메시지가 무엇을 *말하는가*. `text`·attachment·prose block 을 한 텍스트로 | `src/domain/slack/messageText.ts` 의 `slackMessageText`. 키워드 매칭, 런이 답하는 턴, 스레드 히스토리 셋이 이것을 읽는다. 경보 앱은 제목과 본문을 attachment 에 두므로 `text` 만 읽는 쪽은 헤드라인만 받는다 | 구조 |
| 어떤 메시지가 질문이 아니라 고정된 명령인가 | `src/application/slack/engagement.ts` 의 `parseSlackCommand`. 의도적으로 엄격하다: 명령은 봇이 다시 말할지 여부를 바꾸고, 매칭이 느슨하면 아무도 침묵시켜 달라 하지 않은 스레드를 침묵시킨다 | 구조 |
| 런이 사용하는 Slack Web API 표면 | `src/application/slack/types.ts` 의 `SlackClientPort`. 스트리밍 chunk와 세션 상태 요청 형태는 `src/domain/slack/types.ts`의 `SlackChunk`·`SlackSessionStatusInput`이며 어댑터도 이를 사용한다 | 구조 |
| 편집으로 답을 전달하는 표면의 장부. 페이싱, 메시지가 넘칠 때 다음으로 잇기, 거부된 쓰기의 재시도 간격, 마감이 독자에게 빚진 것 | `src/application/messaging/editInPlaceReply.ts` 의 `createEditInPlaceReply`. Telegram 과 Teams 는 호출·상한·렌더링(`EditInPlaceTransport`)만 건넨다 | 구조 |
| 답이 메시지 하나를 넘칠 때 *어디서* 끊는가. 문단 → 줄 → 문장 → 공백 → 서러게이트 쌍을 쪼개지 않는 하드 컷, 그리고 잘린 코드 펜스를 한쪽에서 닫고 다음 쪽에서 다시 여는 것 | `src/shared/messageCut.ts` 의 `cutPoint` / `splitMessages`. 세 표면이 상한만 다르게 건넨다. 끊긴 자리는 독자가 보는 것이고, 사본 둘은 "문장 중간에서 멈추는가" 에 대한 답 둘이다 | 구조 |
| 플랫폼 히스토리가 없는 표면이 대화를 어떻게 읽고 적는가. 턴 수·문자 예산, 턴 하나의 상한, 텍스트 없는 턴과 답 없는 런의 기록, 화자 라벨의 옵트인 | `src/application/messaging/transcriptHistory.ts` | 구조 |
| 플랫폼 히스토리가 없는 표면의 턴이 어떻게 도는가. 기억한 대화를 읽고, 파이프라인을 돌리고, 도착 시각으로 두 턴을 적는 것 | `src/application/messaging/rememberedTurn.ts` 의 `runRememberedTurn` / `resolveAgentSummary`. Telegram 과 Teams 핸들러는 사람·첨부·도착 시각·답변 대상만 건넨다 | 구조 |
| 코드 펜스가 열려 있는지. 조각 경계와 꼬리 붙이기가 렌더러와 같은 답을 내도록 | `src/shared/markdownFence.ts` | 구조 |
| 인바운드 이벤트의 중복 억제와 claim·settle | `src/infrastructure/db/repositories/inboundClaimRepository.ts` 의 `createInboundClaimRepository`. Slack 은 `event_id` 로, Telegram 은 agent·봇·`update_id` 로, Teams 는 agent·App ID·activity id 로 키를 잡고, port 는 `src/domain/messaging/inboundClaims.ts` 의 `InboundEventClaims` 이다 | 구조 |
| 인바운드 delivery 가 얼마나 클 수 있는가, 그리고 넘쳤을 때의 거부 | `src/app/api/_lib/inboundEvent.ts`의 `MAX_INBOUND_EVENT_BYTES` / `readEventBody`. 413 응답은 `src/app/api/_lib/body.ts`의 `bodyTooLarge`가 소유한다 | 구조 |
| Telegram 답변이 어떻게 전달되는가. Bot API 호출, 4,096자, HTML 로 한 번 렌더하고 plain fallback | `src/application/telegram/replyChannel.ts` (장부는 위의 `editInPlaceReply.ts`) | 구조 |
| 전달된 Bot Framework activity 중 어떤 것이 봇에게 온 것인가 | `src/application/teams/engagement.ts` 의 `classifyTeamsActivity` | 구조 |
| 이 플랫폼이 사용하는 Bot Framework 표면 | `src/domain/teams/client.ts` 의 `TeamsClientPort`. 어댑터는 `src/infrastructure/teams/client.ts` 이다 | 구조 |
| Bot Framework 토큰의 검증. 서명 키, 발급자, audience, `serviceurl` | `src/infrastructure/teams/client.ts` 의 `verifyRequest` | 구조 |
| 전달된 Telegram update 중 어떤 것이 봇에게 온 것이고, 어떤 것이 명령인가 | `src/application/telegram/engagement.ts` 의 `classifyTelegramUpdate` / `parseTelegramCommand` | 구조 |
| 이 플랫폼이 사용하는 Telegram Bot API 표면 | `src/domain/telegram/client.ts` 의 `TelegramClientPort`. 어댑터는 `src/infrastructure/telegram/client.ts` 이다 | 구조 |
| 답변의 Markdown 을 Telegram HTML 로 렌더하기 | `src/application/telegram/markdown.ts` 의 `markdownToTelegramHtml` | 구조 |

## MCP·Plugin·프로토콜

| 결정 | 소유자 | 확인 |
|---|---|---|
| MCP tool 의 형태 | `src/domain/mcp/types.ts` | 구조 |
| 어떤 호스트가 아웃바운드 URL 가드를 건너뛸 수 있는가. 선언된 suffix 에 이름을 맞추는 술어 하나 | `src/domain/security/internalHosts.ts` 의 `isDeclaredInternalHost`. MCP 목록과 `FetchUrl` 목록이 같은 술어를 지나고, provenance(managed 루프백)와 합친 형태는 `src/domain/mcp/types.ts` 의 `skipsUrlGuard` 다 | 구조 |
| MCP OAuth 콜백 기본값과 수동 입력 검증 | `src/application/mcp/mcpAuthUseCases.ts`의 `redirectUri`. Tools와 인가 요청은 같은 서버 설정에서 주소를 얻고 token 교환은 pending state의 주소를 쓴다 | 구조 |
| 공용 MCP OAuth client 참조와 token endpoint 자격 증명 선택 | `src/application/mcp/mcpOAuthClient.ts`. code 교환과 refresh가 같은 선택을 사용한다 | 구조 |
| 원격·관리형 MCP의 헤더·환경·OAuth secret 응답 마스킹 | `src/application/mcp/mcpViews.ts` | 구조 |
| `plugin.json`/`mcp.json` 의 해석, 그리고 Plugin 이 어떤 MCP transport 를 바인딩할 수 있는가 | `src/domain/plugin/types.ts` | 구조 |
| Agent Plugins 이름 규칙 | `src/domain/plugin/types.ts` 의 `isPluginName` | 구조 |
| 마크다운 frontmatter 블록의 파싱 | `src/domain/plugin/frontmatter.ts` | 구조 |
| repo 소유 컴포넌트의 provenance 문자열(`github:<repo>#<plugin>`) | `src/domain/plugin/types.ts` 의 `pluginSourcePrefix`(sync 가 `startsWith`/`slice` 로 기대는 쪽)·`pluginSource`·`parsePluginSource` | 구조 |
| catalog 재색인 중 동시에 probe할 MCP 서버 수 | `src/application/catalog/reindexCatalog.ts` 의 `MAX_CONCURRENT_CATALOG_PROBES` | 구조 |
| query embedding의 캐시 key·LRU·잘못된 벡터 응답 처리 | `src/application/catalog/queryCache.ts` | 코드 |
| builtin 도구의 wire 이름과 예약 집합 | `src/domain/llm/toolNames.ts` — 엔진, MCP alias 할당, 클라이언트 표시가 함께 사용한다 | 구조 |
| 런당 MCP tool 상한 | `src/domain/llm/toolLimits.ts` | 구조 |
| MCP 서버가 보낸 401 이 뜻하는 것 | `src/infrastructure/mcp/session.ts` | 구조 |
| provider 가 MCP tool 이름으로 받아들이는 이름 | `src/infrastructure/mcp/toolManager.ts` | 구조 |
| managed workload의 image·환경 키·값·argv·endpoint path 문법 | `src/domain/mcp/provisioner.ts`. API가 400으로 거절하는 문법과 lifecycle/Docker 경계가 실행 직전에 방어하는 문법이 같다 | 구조 |
| plugin 상세의 repository·commit 링크가 향하는 GitHub web base | `src/lib/config.ts`의 `githubWebUrl`. public GitHub와 표준 GHES API 경로에서 도출하고, 그 밖에는 `GITHUB_WEB_URL`이 정한다. 브라우저는 상세 API가 만든 `repositoryUrl`만 읽는다 | 구조 |
| 업로드 아카이브로 sync 된 행의 provenance. 설정된 저장소, 없으면 `archive` | `src/domain/plugin/sync.ts` 의 `archiveSyncRepo` / `ARCHIVE_SYNC_REPO`; 브랜치 `archive` 와 commit = sha256 은 `src/infrastructure/plugin/archiveSnapshot.ts` | 코드 |
| tar 아카이브 읽기. gzip 여부, GNU/pax 긴 이름, 트리를 벗어나는 경로의 거부, 크기·엔트리 상한 | `src/infrastructure/archive/tar.ts` 의 `readTarArchive` | 코드 |
| 심볼릭 링크의 git 모드. 첨부 수집기가 거부하는 한 가지 엔트리 타입 | `src/domain/skill/files.ts` 의 `SYMLINK_MODE`. GitHub 트리와 아카이브가 같은 값으로 보고한다 | 코드 |
| OAuth authorization 서버 메타데이터를 찾는 주소와 순서 | `src/infrastructure/mcp/oauthMetadata.ts` 의 `authorizationServerCandidates` | 코드 |

## 보안·설정

| 결정 | 소유자 | 확인 |
|---|---|---|
| 아웃바운드 redirect의 출처·횟수·HTTP 메서드 규칙 | `src/infrastructure/net/redirectPolicy.ts` 의 `fetchSameOrigin`. 공개 URL의 DNS 검증·연결 고정은 `publicFetch.ts`가 각 요청에 적용한다 | 구조 |
| 어떤 응답이 콘솔의 보안 헤더를 받는가. 여기 선언한 헤더는 라우트가 같은 키로 세운 것을 *대체한다* | `next.config.ts` 의 `SECURITY_HEADERS` 와 그 `source` | 구조 |
| 상수 시간 시크릿 비교 | `src/shared/timingSafe.ts` | 구조 |
| `AES_ENCRYPTION_KEY` 의 base64 해석과 32바이트 검증 | `src/shared/aesKey.ts` 의 `decodeAes256Key` | 구조 |
| 쉼표로 구분된 설정 목록의 파싱 | `src/shared/parseList.ts` | 구조 |
| 설정된 값이 비어 있는지 여부 | `src/shared/env.ts` | 구조 |
| Schedule 연동 화면이 동시에 읽을 최근 실행 목록 수 | `src/app/agents/[name]/integrations/scheduleRuns.ts` 의 `MAX_CONCURRENT_SCHEDULE_RUN_READS` | 구조 |
| 각 member tier 가 쓸 수 있는 금액 | `src/domain/member/tiers.ts` 의 `TIER_LIMITS` | 구조 |
| `undici` 에 직접 닿기 | `src/infrastructure/net/publicFetch.ts`. dispatcher와 fetch는 같은 undici 구현을 사용한다 | 구조 |
| chunk 가 거쳐 온 transfer 사슬을 도출하기 | `src/domain/llm/types.ts` 의 `chunkAuthorPath` | 구조 |
| 같은 도구 call ID를 실행·위임별로 구분하는 내부 키 | `src/domain/llm/types.ts` 의 `toolCallKey`. 트레이스와 UI가 author 경로·transfer ID·call ID를 함께 사용한다 | 구조 |
| 401 응답 본문 | `src/shared/unauthorized.ts` | 구조 |
| 거부된 sign-in 을 식별하는 코드 | `src/shared/signInError.ts` | 구조 |
| Better Auth 계정 키와 테이블 구조 | `src/infrastructure/db/migrations.ts`; 키는 `providerId + accountId`이며 기존 `issuer` 값은 nullable로 보존한다 | 코드 |
| 만료 행을 지우는 틱 | `src/lib/container.ts`의 `sweepExpiredRows`: items, Better Auth session, runtime_sessions를 정리한다. 호출은 `src/app/api/triggers/scan/route.ts`가 담당한다 | 코드 |
| Better Auth 의 `user` 행을 멤버로 읽기. 스토어가 소유하지 않는 테이블에 대한 plain SQL | `src/infrastructure/db/repositories/memberRepository.ts` | 코드 |
| 어떤 로그인 수단이 켜져 있는가 | `src/lib/config.ts` 의 `authProviders`. `auth.ts` 가 그대로 조립하고 로그인 페이지가 그대로 그린다 | 코드 |
| 앱 인증 쿠키의 접두어 | `src/shared/authCookies.ts` 의 `AUTH_COOKIE_PREFIX`. Better Auth 설정과 페이지 게이트가 함께 사용하며 개발 세션은 Better Auth context의 쿠키 이름을 사용한다 | 코드 |
| 어떤 페이지가 공개인가 | `src/shared/pageAccess.ts` 의 `isPublicPagePath` | 코드 |

## 저장·공통·화면

| 결정 | 소유자 | 확인 |
|---|---|---|
| 새 Chat·Workspace의 요청에 어떤 Agent를 추천하는가 | `src/application/llm/agentRecommendation.ts`의 Choice 구성·후보 분할·선택 매핑. 접근 가능한 후보 목록은 `src/lib/container.ts`가 각 기존 목록 유스케이스에 바인딩한다 | 코드 |
| Chat·Workspace 입력 중 추천을 언제 요청하고 최신 입력을 어떻게 합치는가 | `src/app/_lib/agentSuggestionQueue.ts`의 입력 대기·최대 대기·최소 요청 간격과 단일 진행 요청 | 코드 |
| 결정 모델 호출의 provider별 URL·응답 해석 | `src/infrastructure/llm/decisionClient.ts`. 결정 모델의 등록·삭제 가드는 `src/application/llm/modelRegistry.ts` | 코드 |
| 사용자별 Agent 추천 요청 수의 분·일 상한과 공유 카운터 | `src/infrastructure/db/repositories/agentRecommendationQuota.ts`의 원자적 일일 행 | 코드 |
| 배포의 표시 이름과 로고 폴더·자산 URL | `src/shared/branding.ts`; 환경 읽기와 부팅 시 자산 검사는 `src/lib/config.ts` | 코드 |
| 어떤 스토리지 에러가 조건부 쓰기의 실패를 뜻하는가 | `src/application/errors.ts` | 구조 |
| audit 행을 어떻게 쓰는가 | `src/application/audit/recordAudit.ts` | 구조 |
| 감사 기록의 날짜 범위·페이지 상한·cursor | `src/application/audit/auditUseCases.ts`; 날짜별 조회는 `src/infrastructure/db/repositories/auditRepository.ts` | 코드 |
| Agent 관리 자료·산출물·Trace·호출자별 Usage를 읽을 수 있는 사람. 쓰기와 같은 규칙, 쓰기 감사 행은 남기지 않는다 | `src/application/agent/agentUseCases.ts` 의 `assertAgentOwnerOrAdminReadable` | 구조 |
| Capability catalog reindex의 설치 전역 직렬화 lease | `src/domain/catalog/reindexLock.ts` 계약과 `src/infrastructure/db/repositories/catalogReindexLock.ts` 구현 | 구조 |
| Bedrock 에 닿기 | `src/infrastructure/llm/bedrockClient.ts` | 구조 |
| 호출자가 요청한 페이지 크기를 읽는 법과, 한 페이지가 커질 수 있는 상한 | `src/shared/pageLimit.ts`의 `parsePageLimit` / `boundedPageLimit` / `MAX_PAGE_LIMIT`. 각 자원은 자기 상한을 전달한다. 전체 열거는 repository별 자연 키·시간·seq cursor로 페이지를 순회한다 | 구조 |
| UTC 날짜를 시각으로 읽는 법, 하루의 길이, 그리고 날짜 범위를 걸어가는 법 | `src/shared/date.ts`의 `isUtcDay` / `daySpan` / `daysBetween`. 날짜 유효성·범위 계산을 공유하고 순회 방향은 호출자가 선택한다 | 구조 |
| presence penalty의 허용 범위 | `src/domain/llm/channel.ts`의 `PRESENCE_PENALTY_RANGE`. Agent 설정 API 검증과 편집기가 함께 사용한다 | 구조 |
| schedule 이 언제 발화하는지 판정하기 | `src/domain/trigger/cron.ts` | 구조 |
| Agent 의 webhook 이 어디로 전달되는가 | `src/domain/trigger/types.ts` 의 `agentWebhookPath` | 구조 |
| Agent optimistic update 가 경쟁에서 졌을 때의 오류 계약 | `src/application/agent/agentUpdate.ts` 의 `persistAgentUpdate` | 구조 |
| managed workload 이름 규칙 | `src/domain/naming.ts` 의 `MANAGED_NAME` | 구조 |
| 동시에 도는 generator 를 병합하기 | `src/shared/mergeGenerators.ts` | 구조 |
| 사람이 읽을 달러 금액 | `src/app/_lib/formatUsd.ts` 의 `formatUsd`. `SINGLE_OWNERS` 행이 아니라 그 자체가 하나의 규칙으로 강제된다: `app` 안 어디에도 `${…toFixed(…)}` 는 없고 두 `_lib` 포매터만 있다 | 구조 |
| 저장된 시각 문자열을 밀리초로 읽기 | `src/shared/date.ts` 의 `parsedInstant`. 읽을 수 없는 `createdAt` 은 값이 없는 것이라는 판단을 포매터들과 나눠 갖는다 | 구조 |
| 런이 왜 끝났는지를 그 chunk 들로부터 도출하기 | `src/domain/llm/types.ts` 의 `chunkTermination`/`runTermination` | 구조 |
| 런이 무엇을 잃었는지를 그 chunk 들로부터 모으기 | `src/domain/llm/types.ts` 의 `collectedWarning` | 구조 |
| 콘솔에 쓰기 | `src/shared/logger.ts` | 구조 |
| 가져온 URL 이 턴 안에서 어떻게 감싸이는가 | `src/application/llm/documentParts.ts` 의 `framedFetchedUrl` | 구조 |
| 가져온 URL 을 얼마나 유지하는가 | `src/application/llm/urlContent.ts` 의 `MAX_FETCHED_TEXT_CHARS` | 구조 |
| 모든 항목이 불리는 이름 | `src/domain/naming.ts` 의 `isSlug` | 구조 |
| SDK span 부모 관계의 OTLP 변환 | `src/infrastructure/telemetry/otelTraceExport.ts`; 완료 순서와 무관하게 저장된 부모 관계를 사용한다 | 코드 |
| 실행 전 도구 JSON Schema 검증 | `src/domain/llm/toolSchema.ts`의 포트, `src/infrastructure/llm/toolSchema.ts`의 검증기; 선언은 기존 도구 소유자가 유지한다 | 코드 |
| 아이템 테이블에 쓰는 방법. 행 잠금 아래에서 평가되는 조건, 키 순서로 잠그는 트랜잭션, 접두사 쿼리의 상한(U+10FFFF), 만료 행의 sweep | `src/infrastructure/db/store.ts`. 리포지토리는 이 계약을 통해 조건부 쓰기·키 순서 잠금·접두사 범위·만료 삭제를 수행한다 | 코드 |
| 떠나 버린 소비자로부터 스트림을 떼어내기 | `src/shared/detachOnReturn.ts` | 코드 |
| 바이트 상한 아래에서 HTTP 본문 읽기 | `src/shared/httpBody.ts` | 코드 |
| 백그라운드 타이머가 프로세스를 붙잡아 두지 않게 하기 | `src/shared/unrefTimer.ts` | 코드 |
| 목록 읽기. 매치 전체를 답하고, 경계는 호출자의 `limit`, 만료 필터는 `LIMIT` 보다 먼저 도는 `notExpiredAt`, 호출자가 가져온 값·속성 유무 필터도 같은 자리에서 도는 `filter` / `jsonContains` / `attributePresence` | `src/infrastructure/db/store.ts`의 `queryItems`. 호출자의 limit과 만료·조건 필터를 같은 쿼리에 적용한다 | 코드 |
| chunk 가 top-level 인지 여부 | `src/domain/llm/types.ts` 의 `isTopLevelChunk()` | 코드 |
| 현재 Agent 설정의 접근·저장·실행 시점 snapshot | `src/application/agent/configurationUseCases.ts`; Agent repository의 META CAS와 runtime Session fingerprint 검사 | 코드 |
| 행의 `expiresAt`. 보존 창과 그것을 초로 바꾸는 헬퍼 | `src/infrastructure/db/ttl.ts` | 코드 |
| usage 행의 키가 되는 UTC 날짜 | `src/shared/date.ts` 의 `utcDay` | 코드 |
| repo sync 가 무엇을 했고, 무엇을 사람에게 남겼는가 | `src/domain/sync/types.ts` | 코드 |
| 브랜드 팔레트와 컴포넌트 기본값 | `src/app/theme.ts` | 코드 |
| 페이지·섹션 제목과 경로 탭 | `src/app/_components/PageHeader.tsx`, `SectionHeading.tsx`, `PageTabs.tsx` | 코드 |
| Agent 상세의 분할 페이지 가로 비율 | `src/app/agents/[name]/AgentPageColumns.module.css` | 코드 |
| 카탈로그 행/그리드 보기와 브라우저 저장 키 | `src/app/_components/CatalogView.tsx`; 상태 표현은 `CatalogCollection.tsx`, 컨테이너 기준 열 배치는 `CatalogLayout.module.css`, 항목 스타일은 `CatalogRows.module.css` / `ModelCollection.module.css` | 코드 |
| 연동 이력의 읽기 수명과 Schedule 이력의 병합·페이지 크기·동시 읽기 상한 | `src/app/agents/[name]/integrations/IntegrationHistory.tsx` / `scheduleRuns.ts` | 코드 |
| 외부 키의 교체 초안과 저장된 마스크 구분 | `src/app/_components/SecretInput.tsx` | 코드 |
| 앱 발급 키의 표시·숨기기·복사와 변경 확인 | `src/app/_components/SecretControl.tsx`; API 기능·권한은 각 호출자가 제공한다 | 코드 |
| tool 호출을 그에 답한 결과와 짝짓기 | `src/app/_lib/toolPairs.ts` | 코드 |
| 한 tool 의 트래픽을 한 행으로 그리기 | `src/app/_components/ToolRow.tsx` | 코드 |
| 런의 추론을 한 블록으로 그리기 | `src/app/_components/ReasoningRow.tsx` | 코드 |
| 토큰 속도로 오는 텍스트를 커밋 단위로 묶기 | `src/app/_lib/textPacer.ts` | 코드 |
| tool 호출이 사람에게 무엇으로 읽히는가 | `src/app/_lib/toolCalls.ts` 의 `describeTool` | 코드 |
| 콘솔이 사람에게 보여주는 모든 문자열 | `src/app/_i18n/messages/en.ts` | 코드 |
| 요청이 어떤 언어로 서빙되는가 | `src/app/_i18n/locale.ts` | 코드 |

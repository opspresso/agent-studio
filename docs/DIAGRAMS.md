# 아키텍처 다이어그램

Agent Studio 전체를 그림으로 본다. 각 그림은 요약이고, 정본은 옆에 링크한 문서다 — 그림과 문서가
어긋나면 문서가 맞다. 그림은 [ARCHITECTURE.md](ARCHITECTURE.md) 의 순서를 따른다: 계층 → 요청
흐름 → 런 브래킷 → 엔진 루프 → 메시징 표면 → 조립 지점 → 저장 모델.

## 1. 계층과 의존 방향

`app → application → domain ← infrastructure`. 화살표는 import 가 허용되는 방향이다.
`tests/architecture.test.ts` 가 빈 허용 목록으로 강제한다 ([ARCHITECTURE.md#레이어](ARCHITECTURE.md#레이어)).

```mermaid
flowchart TB
  app["<b>app</b><br/>페이지 · API 라우트 핸들러 · 콘솔 컴포넌트"]
  application["<b>application</b><br/>유스케이스 · LLM 엔진 · 실행 파사드 · 표면(chat/slack/telegram/a2a/trigger) · messaging"]
  domain["<b>domain</b><br/>엔티티 · 리포지토리 포트 · 한계값 — 순수 TS"]
  infrastructure["<b>infrastructure</b><br/>DynamoDB · LLM 채널 · MCP · Slack · Telegram · Teams · A2A · S3 · net · crypto"]
  lib["<b>lib</b><br/>composition root(container.ts) · auth/session · runtime settings · config"]
  shared["<b>shared</b><br/>의존성 없는 헬퍼 — @/ 를 import 하지 않는다"]

  app --> application
  app --> domain
  application --> domain
  infrastructure --> domain
  infrastructure --> lib
  app -->|"wiring site 를 통해서만"| lib
  lib --> domain
  lib -->|"container.ts 가 유스케이스를 조립"| application
  lib -->|"wiring 모듈만"| infrastructure
  application -.->|"순수 leaf(runMetrics)만"| lib
  app --> shared
  application --> shared
  infrastructure --> shared
  lib --> shared
```

## 2. 요청 흐름 — 열 진입점, 하나의 파사드

모든 실행은 `src/application/execution/runProject.ts` 로 모인다. 표면은 *어떻게 들어오는지*
(HTTP 형태, 인증, 응답 모양)만 결정하고, *어떤 프로젝트 타입이 어떻게 도는지*는 파사드가
한 번 결정한다 ([ARCHITECTURE.md#요청-흐름](ARCHITECTURE.md#요청-흐름)).

```mermaid
flowchart LR
  subgraph surfaces["진입점 (요청부)"]
    direction TB
    predict["POST …/predict"]
    cc["POST …/chat/completions"]
    agentsse["POST …/agent (SSE)"]
    chat["POST /api/chats/{id}/messages"]
    slack["POST /api/slack/events/{project}"]
    telegram["POST /api/telegram/webhook/{project}"]
    teams["POST /api/teams/messages/{project}"]
    a2a["POST /api/a2a/{name} (JSON-RPC)"]
    agui["POST /api/agui/{name} (AG-UI SSE)"]
    webhook["POST /api/webhook/{project}"]
    schedule["POST /api/triggers/scan"]
  end

  subgraph facade["실행 파사드 — runProject.ts"]
    direction TB
    dispatch["projectType 디스패치<br/>agent → 툴 루프 · llm → 단발 · image → generateImage"]
    fns["streamProjectRun (청크 소비자, 이미지 포함)<br/>executeProjectStream / executeProject (완성 응답, 이미지 거부)<br/>executeAgent (에이전트 전용)"]
  end

  bracket["런 브래킷 — openRun<br/>모델 정책 → 프로젝트 비용 가드 → 멤버 월 상한 → 동시성 슬롯 → 메트릭·상관 id·아티팩트 레코더"]
  resolve["바인딩 해석 (prepare span)<br/>스킬 · MCP 세션 · 서브에이전트 · (옵트인) 카탈로그 검색 · 메모리 회상"]
  engine["엔진 — runAgent / runPrompt(Stream)"]
  channel["OpenAI 호환 채널 (LLM 공급자)"]
  imagechannel["이미지 채널"]
  tools["도구: MCP(≤5 동시) · Skill · transfer_to_agent / dispatch_agents · 이미지 · FetchUrl · SaveFile · Slack 읽기"]
  usage["사용량 기록 (런 종료 시 1회 flush)"]
  trace["트레이스 (에이전트 항상, 그 외 샘플링)"]

  predict --> facade
  cc --> facade
  agentsse --> facade
  chat -->|"ChatDeps.runAgent"| facade
  slack -->|"handleTurn → runAgent"| facade
  telegram -->|"handleTurn → runAgent"| facade
  teams -->|"handleTurn → runAgent"| facade
  a2a --> facade
  agui -->|"streamAguiRun"| facade
  webhook -->|"triggerRunnerDeps.run"| facade
  schedule -->|"triggerRunnerDeps.run"| facade
  facade --> bracket
  bracket -->|"agent"| resolve --> engine
  bracket -->|"llm"| engine
  bracket -->|"image"| imagechannel
  engine <--> channel
  engine <--> tools
  engine --> usage
  engine --> trace
```

응답 모양은 표면마다 다르다: `predict`·`chat/completions` 는 완성 응답(또는 SSE), `agent` 는
원시 청크 SSE, chat 은 자체 프레임 + 재생 로그, Slack·Telegram·Teams 는 플랫폼 메시지, A2A 는 태스크
이벤트, AG-UI 는 프로토콜의 이벤트 스트림, 트리거는 이력 행. 청크의 계약은
[ARCHITECTURE.md#enginechunk-계약](ARCHITECTURE.md#enginechunk-계약).

## 3. 런 브래킷 — 최상위 런을 감싸는 한 곳

네 함수(`executeVersion` · `executeVersionStream` · `executeAgent` · `generateImage`)가 최상위
런을 admit 하고, 각각 브래킷을 연다. 가드는 메트릭 *앞*에서, `close()` 는 사용량 flush *뒤*에서
([ARCHITECTURE.md#런-브래킷](ARCHITECTURE.md#런-브래킷)).

```mermaid
sequenceDiagram
  participant S as 표면 (라우트 · 어댑터)
  participant F as executeAgent
  participant B as openRun (runBracket)
  participant E as engine.runAgent
  participant T as 도구 · MCP · 서브에이전트
  S->>F: executeAgent(deps, {project, version, messages, actor, caller, conversation})
  F->>B: openRun — 모델 정책 · 비용 가드(fail-open) · 멤버 상한(fail-open) · 동시성 슬롯(fail-closed) · 메트릭 · 상관 id · 아티팩트 레코더
  B-->>F: bracket
  F->>F: resolveRunTools (스킬 / MCP / 서브에이전트 병렬) · recallForRun<br/>각각 prepare span 으로 기록 — 첫 model span 은 그 뒤에서 시작한다
  F-->>S: {warning} 청크 (쓸 수 없던 바인딩)
  F->>E: runAgent(agentDeps, input)
  loop tool_calls 가 없거나 turn 가드에 걸릴 때까지
    E->>E: 채널 스트림 (첫 청크 전 fallback 1회)
    E-->>S: EngineChunk (delta / toolCalls / usage)
    E->>T: 도구 호출 (builtin 순서대로 · MCP 동시)
    T-->>E: 도구 결과
    E-->>S: EngineChunk (toolResult / image / file)
  end
  E-->>S: {done} 또는 {finishReason}
  F->>F: usage.flush() → bracket.close() → settleTransferred → finishTrace
```

## 4. 메시징 표면 — 게이트웨이와 어댑터

Slack·Telegram·Teams 는 같은 파이프라인 위에 있다. 어댑터는 플랫폼이 결정하는 것만 갖고,
파이프라인은 플랫폼과 무관한 것을 한 번 갖는다 ([design/messaging.md](design/messaging.md),
[design/slack.md](design/slack.md), [design/telegram.md](design/telegram.md),
[design/teams.md](design/teams.md)).

```mermaid
flowchart LR
  subgraph route["라우트 — app/api/{platform}/…"]
    verify["플랫폼 인증<br/>Slack: HMAC 서명 · Telegram: secret token · Teams: Bot Framework JWT"]
    gate["게이트 (dedup claim 앞)<br/>classifySlackEvent · classifyTelegramUpdate · classifyTeamsActivity"]
    tail["admitInboundEvent<br/>claim → 즉시 ack → after() → settle<br/>(app/api/_lib/inboundEvent.ts)"]
  end
  subgraph adapter["어댑터 — application/slack · application/telegram · application/teams"]
    normalise["정규화<br/>이벤트 → text · attachments · history · actor · caller · conversation"]
    render["ReplyChannel 구현<br/>Slack: 스트림/편집 + 상태선/체크리스트<br/>Telegram: 편집·4,096 분할·HTML 1회 렌더 · Teams: 편집·20,000 분할·Markdown 그대로"]
    after["사후처리<br/>Slack: markEngaged · Telegram/Teams: transcript append"]
  end
  subgraph shared["공통 — application/messaging"]
    turn["handleTurn<br/>첨부 제한 → turnContent → runAgent → 청크 fold(step/stepDone/push)<br/>→ 그림 · 파일 링크 · 경고 꼬리 → finish"]
    edit["editInPlaceReply<br/>편집 답변의 장부: 페이싱 · 분할 · 재시도 간격 · 마감"]
    transcript["transcriptHistory<br/>턴 수·문자 예산 · 턴 상한 · 화자 라벨 옵트인"]
  end
  subgraph ports["포트 — domain/messaging"]
    p1["ReplySink · ReplyChannel"]
    p2["InboundAttachment · HistoryTurn"]
    p3["InboundEventClaims"]
    p4["ConversationTranscriptRepository"]
  end
  facade["executeAgent"]

  verify --> gate --> tail --> normalise --> turn --> facade
  render -.-> turn
  render -.-> edit
  after -.-> transcript
  turn --> after
  turn -.-> p1
  turn -.-> p2
  tail -.-> p3
  after -.-> p4
```

## 5. 조립 지점 — 일곱 곳

유스케이스는 어댑터 위에 정확히 일곱 곳에서 조립된다. 라우트는 조립된 객체를 받는다
([ARCHITECTURE.md#조립은-의도적으로-고른-몇-곳에서만](ARCHITECTURE.md#조립은-의도적으로-고른-몇-곳에서만)).

```mermaid
flowchart TB
  container["src/lib/container.ts<br/>리포지토리 · 도메인 포트 · 레지스트리 슬라이스 · projectSlack/Telegram/TeamsUseCases<br/>executionDeps · imageDeps · triggerRunnerDeps"]
  chatdeps["src/app/api/chats/_deps.ts<br/>ChatDeps (runAgent 바인딩)"]
  slackdeps["src/app/api/slack/events/_lib/<br/>SlackEventDeps"]
  tgdeps["src/app/api/telegram/webhook/_lib/<br/>TelegramEventDeps"]
  teamsdeps["src/app/api/teams/messages/_lib/<br/>TeamsEventDeps"]
  a2aroute["src/app/api/a2a/[name]/route.ts<br/>요청별 A2A SDK 핸들러 조립"]
  boot["src/instrumentation.ts<br/>부트: 설정 검증 · 감사 싱크 · managed MCP 재개"]

  container --> chatdeps
  container --> slackdeps
  container --> tgdeps
  container --> teamsdeps
  container --> a2aroute
  boot -.->|"런타임이 Node 서버일 때만 로드"| container
```

## 6. 저장 모델 — 단일 테이블

한 테이블(`PK`/`SK` + `GSI1`/`GSI2`). 항목 단위 접근은 기본 키로, "종류별 목록" 은 GSI1 로.
전체 키 맵은 [ARCHITECTURE.md#dynamodb-단일-테이블-설계](ARCHITECTURE.md#dynamodb-단일-테이블-설계).

```mermaid
flowchart LR
  subgraph project["PROJECT#{name} 파티션"]
    meta["META (프로젝트, publishedVersion 포인터)"]
    ver["VERSION#{v}"]
    tok["APITOKEN"]
    trig["TRIGGER#{id} · TRIGGERRUN#…"]
    conn["MCPCONN#{server} · REMOTECTX#…"]
  end
  subgraph chat["CHAT#{chatId} 파티션"]
    cmeta["META (nextSeq, activeRunId)"]
    msg["MSG#{seq}"]
    runlog["RUNLOG#{runId}#{seq} (짧은 TTL)"]
  end
  subgraph registry["레지스트리 (GSI1 TYPE#…)"]
    skill["SKILL#{name}"]
    mcp["MCP#{name}"]
    agent["AGENT#{name}"]
    plugin["PLUGIN#{name}"]
  end
  subgraph runs["런의 흔적"]
    usage["USAGE#{project} / DATE#… · ACTOR#…"]
    trace["TRACE#{id} (GSI1 TRACEPROJECT#)"]
    artifact["ARTIFACT#{id} (GSI1 프로젝트 · GSI2 소유자)"]
    slot["RUNSLOT#{actor} / SLOT#nnn"]
  end
  subgraph inbound["인바운드 표면"]
    sev["SLACKEVENT#{eventId}"]
    sthread["SLACKTHREAD#{project}#{channel}#{ts}"]
    transcript["PROJECT 파티션 안: TELEGRAMUPDATE#… · TELEGRAMALBUM#… · TEAMSACTIVITY#… · TRANSCRIPT#{conversation}#TURN#…"]
    a2atask["A2ATASK#{project}#{taskId}"]
  end
```

키 문자열은 `src/infrastructure/db/keys.ts` 만 만든다. 자라는 행은 `expiresAt` 을 갖고
([OPERATIONS.md#행-보존](OPERATIONS.md#행-보존)), 목록 조회는 페이지네이션한다.

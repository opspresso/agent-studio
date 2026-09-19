# AG-UI

사용자를 마주하는 애플리케이션이 설정된 Agent 를 자기 화면 안에 넣는 프로토콜.
MCP 가 agent 에 tool 을 주고 A2A 가 agent 끼리 말하게 한다면, AG-UI 는 agent 를 사람이 쓰는
앱 안으로 가져온다 — CopilotKit 같은 프론트엔드가 이 표면을 호출한다.

HTTP 계약은 [API.md](../API.md#ag-ui-인바운드) 에, 인증은
[SECURITY.md](../SECURITY.md#머신-호출자의-요청-인증) 에 있다. 이 문서는 *왜* 이런 모양인지를 적는다.

## 표면

`POST /api/agui/{project}` 가 프로토콜의 `RunAgentInput` 을 받아 이벤트 스트림(SSE, `data:`
프레임 하나에 이벤트 하나, `[DONE]` 없음)으로 답한다. 세 가지 결정만 이 표면의 것이다.

- **누가 부르는가.** 실행 엔드포인트 셋과 같은 게이트(`authenticateExecution`) — project API
  토큰 또는 콘솔 세션. 호출자는 이 project 를 자기 앱에 넣는 소유자의 앱이고, project 토큰이
  정확히 그것을 위한 자격 증명이다. 런은 토큰 소유자(`project-token:{email}`) 또는 세션
  사용자에게 귀속된다.
- **어떤 설정으로 답하는가.** Project와 함께 읽은 현재 Agent 설정을 사용한다. 없으면 404.
- **어느 대화인가.** 클라이언트의 `threadId` 가 런의 conversation 이다 —
  `agui:{caller}:{threadId}`. `X-Conversation-Id` 헤더와 같은 가명 네임스페이스(호출자 actor
  키의 keyed digest)라서, 스레드를 1 부터 세는 두 앱은 두 대화이고 토큰 뒤의 이메일이 MCP
  서버에 키로 닿지 않는다. 프로토콜에서 스레드는 필수이므로, 너무 긴 id 는 헤더처럼 400 으로
  거절하지 대화 없이 돌리지 않는다.

런 자체는 `streamProjectRun`의 Agent 도구 루프로 실행한다. 이미지 생성·편집도 같은 실행의
도구와 출력 축이며 이 표면은 별도의 실행 분기를 만들지 않는다.

## 청크에서 이벤트로

엔진은 필드 하나가 축 하나인 청크로 답하고, AG-UI 는 *라이프사이클* 로 답한다 — 메시지는
열리고, 흐르고, 닫힌다. 열린 적 없는 메시지의 content delta 를 받은 클라이언트는 스트림을
거부한다. 그래서 번역기(`src/application/agui/events.ts`)는 무엇이 열려 있는지를 들고, 다음
청크가 함의하는 경계에서 닫는다.

| 청크 | 이벤트 |
|---|---|
| top-level `delta.content` | `TEXT_MESSAGE_START` (처음) → `TEXT_MESSAGE_CONTENT` … → `TEXT_MESSAGE_END` (tool 호출·step·종료가 닫는다) |
| top-level `delta.reasoningContent` (Agent가 `reasoningTrace` 를 켰을 때만 온다) | `REASONING_START` + `REASONING_MESSAGE_START` → `REASONING_MESSAGE_CONTENT` … → `REASONING_MESSAGE_END` + `REASONING_END` (답변이 시작되면 닫힌다) |
| top-level `delta.toolCalls` | 호출마다 `TOOL_CALL_START` → `TOOL_CALL_ARGS` (인자가 있을 때) → `TOOL_CALL_END`. 그 턴이 처음 말하거나 부를 때 만든 assistant 메시지 id 를 모든 호출이 `parentMessageId` 로 공유한다 |
| top-level `toolResult` | `TOOL_CALL_RESULT` (`role: "tool"`). Runtime이 만든 native 도구 결과를 그대로 전달한다. 자식 delta를 다시 누적해 결과를 만들지 않는다 |
| authored 청크의 첫 등장 / `authorDone` | `STEP_STARTED` / `STEP_FINISHED` (`stepName` 은 `authorPath` 체인). 자식의 텍스트와 호출은 이벤트가 되지 않는다 — 그 답은 부모의 tool 결과로 돌아온다 |
| `image` (author 무관) | `ACTIVITY_SNAPSHOT` `activityType: "agent-studio.image"`, `content: { mimeType, dataUrl, prompt?, model?, artifactId? }` |
| `file` (author 무관) | `ACTIVITY_SNAPSHOT` `activityType: "agent-studio.file"`, `content: { fileId?, name, mimeType, url, byteSize? }` — 바이트는 브래킷이 걷어냈으므로 `VIEW_URL_TTL_SECONDS` 로 서명한 주소. 주소를 만들 수 없으면 경고가 된다 |
| `warning` (author 무관, `collectedWarning` 으로 중복 제거) | `CUSTOM` `agent-studio.warning` `{ message }` — 그리고 `RUN_FINISHED.result.warnings` 에 모인다 |
| `usage` (모든 호출) | 합산해 `RUN_FINISHED.usage[0]` (`inputTokens`, `outputTokens`, `totalTokens`, `reasoningTokens?`, `cachedInputTokens?`). 여러 모델의 호출을 합산할 수 있으므로 aggregate에 단일 `model`을 붙이지 않는다 |
| top-level `done` / `finishReason` | 열린 것을 전부 닫고 종료 사유를 기억해 둔다. `RUN_FINISHED` 는 **소스가 소진될 때** 나간다 — artifact recorder 는 엔진 스트림이 끝난 *뒤에* 보관하지 못한 그림을 말하므로, `done` 에서 끝내면 그 경고 하나를 잃는다. `result.termination` 은 엔진의 어휘(`completed` / `turn-limit` / `output-limit`) 그대로 |
| top-level `error`, 스트림 도중의 throw, terminal 청크 없는 소스 종료 | 열린 것을 전부 닫고 `RUN_ERROR` |

프로토콜에는 경고 프레임도 종료 사유 필드도 없는데, 둘 다 답을 읽는 데 필요하다 — 턴 한도에서
잘린 런과 끝까지 간 런은 텍스트 축에서 똑같아 보인다. 그래서 경고는 `agent-studio.` 로
네임스페이스를 가진 `CUSTOM` 이벤트이고, `RUN_FINISHED.result` 가 종료 사유와 잃은 것을 싣는다.

**그림과 파일은 `CUSTOM` 이 아니라 `ACTIVITY_SNAPSHOT` 이다.** 클라이언트의 `apply` 는 custom
이벤트를 subscriber 에게만 전하고 스레드에는 넣지 않는다 — Agent가 이미지를 출력하면
화면은 빈 런이었다. activity 는 스레드의 메시지가 되고(`activityType` 별 렌더러), 클라이언트가
다음 런 입력에서 제거하므로 "바이트는 모델로 돌아가지 않는다" 는 설계가 그대로 성립한다.

**턴 하나는 assistant 메시지 하나다.** 턴이 처음 말하거나 부르는 순간 id 를 만들고, 그 턴의 모든
`TOOL_CALL_START` 가 그것을 `parentMessageId` 로 싣는다 — 턴이 먼저 말했든 아니든. parent 없는
호출을 받은 클라이언트는 호출마다 assistant 메시지를 지어내므로, tool 둘만 부른 턴이 빈 말풍선
둘이 되고 다음 런의 history 도 둘로 쪼개졌다. tool 결과가 오면 턴이 끝나고, 다음 말은 다음
메시지다. step 이름은 `authorPath`를 `/`로 이은 Agent 경로다. 각 도구 호출과 결과의
식별자는 별도의 `toolCallId`로 보존한다.

**첫 청크는 `RUN_STARTED` 보다 먼저 당긴다.** 런은 첫 `next()` 에서 거절된다 — 비용 가드,
동시성 가드 — 그리고 라우트는 그 throw 를 429 와 `Retry-After` 로 바꾼다. 이벤트 스트림이
이미 시작돼 있었다면 거절은 200 안의 `RUN_ERROR` 가 됐을 것이다. 그 뒤의 throw 는 런의 실패이고
`RUN_ERROR` 로 보고된다 — 번역기가 보지 못한 실패(첫 청크가 `FIRST_CHUNK_GRACE_MS` 를 넘긴
뒤 실패한 경우, 응답은 이미 만들어져 있다)도 라우트가 `sseResponseRaw` 의 `errorFrame` 으로
같은 프레임을 쓴다; 프로토콜 밖의 `{error}` 프레임은 클라이언트에게 에러가 아니라 거부할
스트림이다. 같은 이유로 스트림은 끝까지 **소진** 하지 중간에 return 하지 않는다: 제너레이터를
중간에 return 하면 그 정리가 취소로 돌고, 브래킷은 끝난 런을 호출자가 버린 런으로 기록한다.

**독자가 떠나면 소스를 닫는다.** 끊긴 클라이언트는 *이* 제너레이터를 return 시키고, 그것이
소스에 닿는 것은 루프가 소스에 위임하고 있는 동안뿐이다 — `RUN_STARTED` 나 선행 경고가
대기 중인 yield 일 때는 아니고, 그것이 모든 런이 가장 먼저 보내는 것이다. 번역기의 `finally`
가 어느 yield 에서 떠났든 `source.return()` 을 부르므로 브래킷과 MCP 세션이 닫힌다; 그러지
않으면 동시성 슬롯이 데드라인까지 붙들린다.

## 클라이언트 tool

AG-UI 의 고유한 것: 앱이 `tools` 로 자기 tool 을 선언하고, 모델이 그것을 부르면 앱이 자기
쪽에서 실행한다(지도 보여 주기, 폼 채우기). 이것이 엔진에 닿는 방식은
`src/application/runtime/AGENTS.md`가 불변식으로 소유한다. 요지는:

- Agent의 서버 도구 뒤에 붙고 `MAX_TOOLS_PER_REQUEST`에 남은 자리만큼 제공한다.
  builtin 또는 MCP alias와 이름이 충돌하거나 한도를 넘은 도구는 제외하고 경고한다.
- 시스템 프롬프트의 `## Application Tools` 섹션이 한 가지만 말한다: 이 tool 은 상대편에서
  돌고, 부르면 턴이 끝나며, 결과는 대화와 함께 돌아온다.
- 실행 가능한 클라이언트 tool 호출은 SDK `needsApproval`로 런을 중단한다. 호출 인자는
  자르지 않으며 같은 턴의 서버 도구는 실행하고 결과를 전달한다. SDK 중단을 표면의 전송 종료로
  알린 뒤 앱이 클라이언트 도구를 수행한다. 호출 인자가 잘못되면 SDK가 오류 결과를 만들고
  모델이 다시 답할 수 있으므로, tool-call delta만 보고 모든 경우에 런이 끝났다고 가정하지 않는다.
- 클라이언트가 실행할 호출에는 서버가 성공 결과를 만들지 않는다. 다음 요청의 `messages`에
  assistant의 `toolCalls`, 클라이언트 실행 결과와 서버의 `TOOL_CALL_RESULT`를 함께 보낸다.
  AG-UI의 이력은 이 입력이 소유하며 영속 Chat Session을 자동으로 연결하지 않는다.
- 위임의 답은 native 도구 결과에 들어 있다. 서버 도구의 그림은 해당 실행에서 전달되지만 다음
  AG-UI 입력으로 자동 재생되지 않는 경우 경고한다.
- Agent 설정의 `approvalTools`는 영속 Chat용 HITL 정책이다. AG-UI frontend tool의 중단/후속 요청과
  별개의 기능이며 이 표면에는 Chat 승인 API가 연결되지 않는다.

## 입력

- `developer`·`system` → system 턴. `user`는 문자열이거나 parts — `text`, `image` (유효한 base64
  data 소스만, `data:` URL로 변환), `document` (유효한 base64 data 소스만; chat 첨부와 같은
  `DocumentExtractor`
  와 예산으로 텍스트가 되어 `turnContent` 의 순서대로 턴 앞에 선다; 읽지 못한 것은 경고).
  audio·video part 와 URL 로 온 document 는 400 으로 그 이름을 대며 거절한다: 보지 못한 첨부에
  대해 답하는 런보다 낫다. `messages` 는 비어 있어도 된다. `assistant` 의
  `toolCalls` → `tool_calls`, `tool` 의 `toolCallId` → `tool_call_id`, `error` 가 있으면
  엔진 규약대로 `Error: ` 접두사.
- `reasoning` 메시지는 바로 뒤의 assistant 턴에 `reasoning_content` 로 되돌린다 — 엔진은 턴의
  사고를 그 턴과 그 턴이 선언한 tool 호출에 붙여 두고, 클라이언트 tool 로 끝난 턴이 정확히
  다음 런이 재생하는 턴이다. assistant 턴이 뒤따르지 않는 것은 버린다. `activity` 메시지는
  앞선 런이 보여 준 것의 기록이라 버린다.
- `context` (`{ description, value }[]`) 는 history **앞** 의 system 턴 하나가 된다. 앱이
  세션에 대해 아는 사실 — 지금 보는 페이지, 열어 둔 레코드 — 이고, 답하는 턴 밖에 두어야
  검색 질의나 이미지 프롬프트가 그것을 요청으로 읽지 않는다.
- `state` 는 비어 있지 않으면 context 와 같은 system 턴에 읽기 전용 JSON 으로 실린다(20,000자
  상한, 잘리면 표시). CopilotKit 의 `useCoAgent` 가 준 상태를 모델이 읽기는 하지만 **갱신하지는
  않는다** — `STATE_SNAPSHOT`/`STATE_DELTA` 는 나가지 않고, 턴이 그렇게 말한다. `forwardedProps`
  는 받아들이고 무시한다. `parentRunId` 는 `RUN_STARTED` 에 되돌려 준다. 프로토콜의 `resume`
  입력은 interrupt 상태를 보관하고 이어 가는 구현이 없으므로 400 으로 명시적으로 거절한다 —
  값을 걷어내고 새 런으로 실행하지 않는다.

## SDK 를 쓰지 않는 이유

와이어 형태는 `src/domain/agui/types.ts` 에 직접 선언하고, 입력은 라우트에서 이 앱의 zod 로
검증한다(`src/app/api/agui/_lib/schema.ts`). 현재 앱이 읽고 내보내는 프로토콜 부분집합만
유지하며 `@ag-ui/core` 패키지는 사용하지 않는다. 새 이벤트나 resume·state 갱신을 지원하려면
타입 선언뿐 아니라 입력 변환·Runtime·이벤트 소비자의 계약을 함께 구현하고 검증해야 한다.

## 콘솔

Integrations 탭의 AG-UI 섹션이 주소와 `@ag-ui/client` 예시를 보여 주고, API Reference 에
`agui` 항목이 있다. 둘 다 현재 Agent 설정 유무를 검사한다. 설정할 것은 없다 — 표면은 토큰이
있는 모든 설정된 Agent 에 항상 열려 있다.

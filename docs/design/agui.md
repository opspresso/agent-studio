# AG-UI

사용자를 마주하는 애플리케이션이 published 된 Project 를 자기 화면 안에 넣는 프로토콜.
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
- **어느 version 이 답하는가.** published 된 것만(`resolveRunnableVersion`, draft 폴백 없음).
  앱은 A2A 와 같은 외부 표면이고, draft 가 그 사용자에게 새어 나가면 안 된다. 없으면 404.
- **어느 대화인가.** 클라이언트의 `threadId` 가 런의 conversation 이다 —
  `agui:{caller}:{threadId}`. `X-Conversation-Id` 헤더와 같은 가명 네임스페이스(호출자 actor
  키의 keyed digest)라서, 스레드를 1 부터 세는 두 앱은 두 대화이고 토큰 뒤의 이메일이 MCP
  서버에 키로 닿지 않는다. 프로토콜에서 스레드는 필수이므로, 너무 긴 id 는 헤더처럼 400 으로
  거절하지 대화 없이 돌리지 않는다.

런 자체는 파사드의 것이다. `streamProjectRun` 을 부르므로 agent project 는 tool 루프를 돌고,
prompt project 는 한 번 답하고, image project 는 그림을 그린다 — 채팅 패널은 셋 다 보여 줄 수
있다. 새 진입점이 `projectType` dispatch 를 다시 쓰지 않는다는 규칙 그대로다.

## 청크에서 이벤트로

엔진은 필드 하나가 축 하나인 청크로 답하고, AG-UI 는 *라이프사이클* 로 답한다 — 메시지는
열리고, 흐르고, 닫힌다. 열린 적 없는 메시지의 content delta 를 받은 클라이언트는 스트림을
거부한다. 그래서 번역기(`src/application/agui/events.ts`)는 무엇이 열려 있는지를 들고, 다음
청크가 함의하는 경계에서 닫는다.

| 청크 | 이벤트 |
|---|---|
| top-level `delta.content` | `TEXT_MESSAGE_START` (처음) → `TEXT_MESSAGE_CONTENT` … → `TEXT_MESSAGE_END` (tool 호출·step·종료가 닫는다) |
| top-level `delta.reasoningContent` (version 이 `reasoningTrace` 를 켰을 때만 온다) | `REASONING_START` + `REASONING_MESSAGE_START` → `REASONING_MESSAGE_CONTENT` … → `REASONING_MESSAGE_END` + `REASONING_END` (답변이 시작되면 닫힌다) |
| top-level `delta.toolCalls` | 호출마다 `TOOL_CALL_START` → `TOOL_CALL_ARGS` (인자가 있을 때) → `TOOL_CALL_END`. 그 턴이 호출 전에 말한 텍스트 메시지가 `parentMessageId`; 호출만 한 턴은 부모가 없고, 클라이언트가 그 자리에 assistant 메시지를 만든다 |
| top-level `toolResult` | `TOOL_CALL_RESULT` (`role: "tool"`). transfer 의 display-only 마커도 그대로 — 다음 런에 tool 메시지로 돌아와도 해가 없다 |
| authored 청크의 첫 등장 / `authorDone` | `STEP_STARTED` / `STEP_FINISHED` (`stepName` 은 author). 자식의 텍스트와 호출은 이벤트가 되지 않는다 — 그 답은 부모의 tool 결과로 돌아온다 |
| `image` (author 무관) | `CUSTOM` `agent-studio.image` `{ mimeType, dataUrl, prompt?, model?, artifactId? }` |
| `file` (author 무관) | `CUSTOM` `agent-studio.file` `{ name, mimeType, url, byteSize? }` — 바이트는 브래킷이 걷어냈으므로 `VIEW_URL_TTL_SECONDS` 로 서명한 주소. 주소를 만들 수 없으면 경고가 된다 |
| `warning` (author 무관, `collectedWarning` 으로 중복 제거) | `CUSTOM` `agent-studio.warning` `{ message }` — 그리고 `RUN_FINISHED.result.warnings` 에 모인다 |
| `usage` (모든 호출) | 합산해 `RUN_FINISHED.usage[0]` (`inputTokens`, `outputTokens`, `totalTokens`, `reasoningTokens?`, `cachedInputTokens?`) |
| top-level `done` / `finishReason` | 열린 것을 전부 닫고 종료 사유를 기억해 둔다. `RUN_FINISHED` 는 **소스가 소진될 때** 나간다 — artifact recorder 는 엔진 스트림이 끝난 *뒤에* 보관하지 못한 그림을 말하므로, `done` 에서 끝내면 그 경고 하나를 잃는다. `result.termination` 은 엔진의 어휘(`completed` / `turn-limit` / `output-limit`) 그대로 |
| top-level `error`, 또는 스트림 도중의 throw | 열린 것을 전부 닫고 `RUN_ERROR` |

프로토콜에는 경고 프레임도 종료 사유 필드도 없는데, 둘 다 답을 읽는 데 필요하다 — 턴 한도에서
잘린 런과 끝까지 간 런은 텍스트 축에서 똑같아 보인다. 그래서 `CUSTOM` 이벤트 셋은
`agent-studio.` 로 네임스페이스를 갖고, `RUN_FINISHED.result` 가 종료 사유와 잃은 것을 싣는다.

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
`src/application/llm/AGENTS.md` 가 불변식으로 소유한다. 요지는:

- agent project 에만 제공된다. prompt project 에는 끝낼 턴이 없고 image project 에는 제공할
  모델이 없으므로, 그런 project 에 선언된 tool 은 버리지 않고 **경고로 보고** 한다 — 앱은
  올 수 없는 호출을 기다리고 있을 것이기 때문이다.
- 런 자신의 tool 뒤에 붙고, 요청 전체 `MAX_TOOLS_PER_REQUEST`(프로바이더의 128) 에 남은
  자리만큼만 제공되며, 빌트인이나 MCP alias 가 이미 쓰는 이름은 제공되지 않는다 — 루프가 둘을
  구분할 수 없다. 어느 쪽이든 경고가 된다. 파사드는 prompt·image project 에 client tool 이
  오면 **거절** 한다(`ValidationError`) — 확인하지 않은 호출자를 위한 것이고, 이 표면은
  확인한 뒤 걷어내며 경고한다.
- 시스템 프롬프트의 `## Application Tools` 섹션이 한 가지만 말한다: 이 tool 은 상대편에서
  돌고, 부르면 턴이 끝나며, 결과는 대화와 함께 돌아온다.
- **클라이언트 tool 을 부른 턴이 런의 마지막 턴이다.** 호출은 모두 알려지고 — 클라이언트
  호출의 인자는 **자르지 않는다**, 알림이 곧 호출이라서 — 그 턴의 런 자신의 호출(MCP, 빌트인)은
  평소처럼 돌아 결과를 보고한 뒤, 루프는 `done` 으로 끝난다(프로바이더가 턴을 출력 한도에서
  잘랐으면 `output-limit`: `done` 은 완전한 호출 계획을 주장한다). 같은 턴의 transfer 는 답을
  display-only 마커 대신 **자기 결과로** 내보낸다 — "For context" 턴은 런과 함께 죽고, 앱의
  재생은 tool 결과만 싣기 때문이다; MCP tool 이 돌려준 그림은 모델이 다시 보지 못한다고
  경고한다(독자는 이미 받았다). 클라이언트 호출에는 결과를 만들지 않는다 — 앱의 답이 history
  에 들어갈 결과다. 다음 런의 `messages` 는 그 assistant 턴(`toolCalls`)과 tool 메시지들(앱이
  만든 것, 그리고 `TOOL_CALL_RESULT` 로 받은 서버 쪽 것)을 싣고, 엔진은 거기서 이어 간다.

## 입력

- `developer`·`system` → system 턴. `user` 는 문자열이거나 parts — `text` 와 `image` 만
  (data 소스는 `data:` URL 로, url 소스는 https 만). audio·video·document part 는 400 으로
  그 이름을 대며 거절한다: 보지 못한 첨부에 대해 답하는 런보다 낫다. `assistant` 의
  `toolCalls` → `tool_calls`, `tool` 의 `toolCallId` → `tool_call_id`, `error` 가 있으면
  엔진 규약대로 `Error: ` 접두사.
- `reasoning` 메시지는 바로 뒤의 assistant 턴에 `reasoning_content` 로 되돌린다 — 엔진은 턴의
  사고를 그 턴과 그 턴이 선언한 tool 호출에 붙여 두고, 클라이언트 tool 로 끝난 턴이 정확히
  다음 런이 재생하는 턴이다. assistant 턴이 뒤따르지 않는 것은 버린다. `activity` 메시지는
  앞선 런이 보여 준 것의 기록이라 버린다.
- `context` (`{ description, value }[]`) 는 history **앞** 의 system 턴 하나가 된다. 앱이
  세션에 대해 아는 사실 — 지금 보는 페이지, 열어 둔 레코드 — 이고, 답하는 턴 밖에 두어야
  검색 질의나 이미지 프롬프트가 그것을 요청으로 읽지 않는다.
- `state`·`forwardedProps` 는 받아들이고 무시한다. 런 사이에 상태를 보관하지 않는다.

## SDK 를 쓰지 않는 이유

와이어 형태는 `src/domain/agui/types.ts` 에 직접 선언하고, 입력은 라우트에서 이 앱의 zod 로
검증한다(`src/app/api/agui/_lib/schema.ts`). `@ag-ui/core` 는 A2A SDK 처럼 프로토콜 자체가
계약이라 application 에 들일 후보였지만, zod 3 에 묶여 있고(이 앱은 zod 4) 아직 0.0.x 라인이다
— 유스케이스에 닿는 것이 두 번째 스키마 라이브러리와 그 밑에서 움직일 수 있는 형태다.
이벤트 이름과 필드는 공개된 프로토콜의 철자 그대로이고, 내보내거나 읽는 것만 선언한다.
프로토콜의 나머지(state, activity, raw) 는 그 전체 스키마로 쓰인 클라이언트가 부분집합으로
읽는다.

## 콘솔

Integrations 탭의 AG-UI 섹션이 주소와 `@ag-ui/client` 예시를 보여 주고, API Reference 에
`agui` 항목이 있다. 둘 다 published version 에 게이트된다. 설정할 것은 없다 — 표면은 토큰이
있는 모든 published project 에 항상 열려 있다.

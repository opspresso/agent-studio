# Chat

agent project 를 상대로 하는 소유자 범위(owner-scoped)의 비공개 대화이며 —
히스토리가 플랫폼 자신이 소유하는 무제한 입력인 유일한 표면이다. 첨부(attachment)가
여기에 있는 이유는 대부분의 첨부가 chat 으로 도착하기 때문이다.

> **영속화(persistence)와 재생(replay) 불변식은 코드 옆에 있다.**
> `run.ts` 와 `messageMapping.ts` 에 대한 정본은 `src/application/chat/AGENTS.md` 다 —
> 재개(resume)가 기대는 순서, 재생이 무엇을 거부하는지, 각 budget 이 어디에 적용되는지.
> 이 파일은 왜 런이 자기 연결보다 오래 사는지, 그리고 왜 그 로그가 기록(record)이 아니라
> 버퍼인지를 말한다.

```ts
Chat { chatId, title, ownerEmail, projectName?, createdAt, updatedAt }
```

메시지는 `seq` 를 갖는 append-only 다. Chat 실행은 agent 엔진을 직접 사용하고 — HTTP
self-call 은 없다 — 클라이언트로 SSE 를 스트리밍한다.

한 chat 은 **한 번에 하나의 런**만 가진다: `claimChatRun` (`src/application/chat/runLease.ts`)
이 chat 행에 conditional-write 리스(lease)를 잡고(`activeRunId`, `RUN_LEASE_SECONDS` 후
만료), 그 리스가 유지되는 동안 들어온 두 번째 전송은 `ChatConflictError` (409) 다. 이것은
호출자별 run-slot 가드와는 별개다: 그쪽은 *한 사람*의 동시성을 제한하고, 이쪽은 두 런이 한
chat 의 append-only 히스토리를 교차 기록하지 못하게 막는다.

## 런은 자기 연결보다 오래 산다

예전에는 chat 런이 브라우저와 함께 끝났다. SSE 계층이 `cancel()` 에서 런을 abort 했기
때문에, 새로고침·탭 닫기·하드 내비게이션은 반쯤 쓰인 답변과 매달린 사용자 턴을 남겼다.
지금은 대신 **분리(detach)한다**: `detachOnReturn` (`src/shared/detachOnReturn.ts`) 이
소비자의 `return()` 을 "읽던 사람이 떠났다"로 바꾸고, 백그라운드에서 런을 완료까지 계속
당기며, 라우트는 그 나머지를 `after()` 에 등록해 graceful shutdown 이 그것을 기다리게 한다.
그래서 chat 라우트는 `sseResponse` 에 **`AbortController` 를 넘기지 않는다** — 라우트가
만드는 controller 는 대신 취소 감시(cancel watch)에 연결된다.

그 결과 런을 멈추는 일은 명시적인 행위가 된다: `DELETE /api/chats/{chatId}/runs/{runId}` 가
chat 행에 `cancelRequestedAt` 을 쓰고 `watchChatCancel` 이 그것을 폴링한다. 누름을 받아 준
인스턴스가 답을 실행 중인 인스턴스라는 보장이 없기 때문이며 — A2A executor 가
`tasks/cancel` 에 쓰는 것과 같은 모양이다. 엔진은 자기가 받은 abort 를 그대로 다시 던지므로
그것이 *어느* 종류였는지가 signal 의 reason 에 남아 살아남고, `endNoticeFor` 가 그것을
되읽는다: 중지와 이미 넘어간 claim 은 각각, 끝난 런이 끝나는 방식 그대로 런을 끝내며, 자기
안내문이 스트리밍되고 **또한** 런이 방금 저장한 메시지에 영속화된다.

읽던 사람이 돌아올 수 있도록, `teeToRunLog` (`src/application/chat/runLog.ts`) 는
**재생 로그(replay log)** 를 유지한다: chat 자신의 파티션에 놓인 짧은 TTL 행들이고, 각 행은
그 런의 프레임 묶음을 나른다. 이 로그는 **읽는 사람이 붙어 있는 동안에는 아무것도 쓰지
않고** — 그들은 이미 모든 프레임을 보고 있다 — 연결이 끊기는 순간 지금까지의 런 전체를
flush 한 뒤, 그 후로는 500ms 마다 쓴다.
`GET /api/chats/{chatId}/runs/{runId}/stream` 은 그것을 처음부터 재생하고 이어서 따라가며,
`getChat` 은 `activeRun` 을 알려 주므로 새로고침한 브라우저는 무엇을 요청해야 하는지 안다.
순서가 곧 계약이다: **영속화 → 종료 항목 → 리스 해제**, 그래서 리스 해제는 `runAndPersist`
가 아니라 `runLog.ts` 에 있다.

로그가 의도적으로 하지 못하는 것이 둘 있다. 이미지 바이트는 절대 들어가지 않는다 (그 자리에는
안내문이 들어간다; 그림은 영속화된 메시지와 함께 도착하거나, object storage 가 설정돼 있지
않으면 아예 오지 않는다 — 그 사실을 안내문이 말한다). 그리고 한 창이 붙어 있는 동안 로그는
비어 있으므로, 같은 런을 보고 있는 두 번째 창은 첫 창이 닫힐 때까지 아무것도 보지 못한다 —
멈춘 것처럼 보이도록 두는 대신 5초 뒤에 그 사실을 알린다.

클라이언트에서 스트림은 라우터보다 위에 있는 모듈 레벨 store
(`src/app/chats/_lib/runStore.ts`) 가 소유한다. 그래서 내비게이션이 한 턴을 끊을 수 없다:
컴포넌트는 `useSyncExternalStore` 로 구독하고, 다시 마운트된 뷰는 런이 여전히 진행 중임을
발견한다. store 는 도착하는 모든 프레임을 자기 항목에 접어 넣지만 **수집 윈도(collection
window) 단위로 구독자에게 알린다**. 알림 하나가 곧 스레드 전체의 렌더이기 때문이고, 답변이
길어질수록 윈도도 넓어지는 것은 다시 파싱할 markdown 이 많아질수록 그 알림이 예약하는 렌더가
비싸지기 때문이다. `MessageView` 는 참조가 안정적인 메시지 배열에 대해 메모이즈돼 있어,
스트리밍 중인 답변만 자기를 다시 그리고 나머지는 그리지 않는다.

**뷰포트는 effect 가 아니라 `use-stick-to-bottom`** (`ChatThread`) 의 것이다: 읽는 사람이
이미 맨 아래에 있을 때만 답변을 따라가고, 그렇지 않을 때는 최신으로 점프하는 컨트롤을
제공하며, 이것을 뒤집는 것은 정확히 하나 — 메시지를 보내는 일뿐이다. 이것이 대체한 코드는
매 렌더마다 스크롤했고, 그래서 읽는 사람을 맨 아래에 가두는 동시에, 초당 수십 번 다시
시작되는 `smooth` 스크롤이 되어 스레드를 떨리게 만들었다. 이 라이브러리가 부과하는 제약 둘은
실수로 되돌리기 쉬워서 각각 그 자리에 주석이 달려 있다: 점프 컨트롤은 `isAtBottom`(의도이고,
리사이즈 중에는 쓸 수 없다) 이 아니라 `isNearBottom`(기하)을 읽는다는 것, 그리고 스레드 안의
어떤 것도 양쪽 축 모두에서 스크롤 컨테이너가 되어서는 안 된다는 것 — 그러면 라이브러리가
따라가는 wheel 이벤트를 삼킨다. `{ ended: true }` 프레임 없이 끝난 스트림은 끝난 런이 아니라
끊긴 연결이므로, store 는 `GET /api/chats/{chatId}/runs/{runId}` 로 런이 아직 진행 중인지
묻고 재생 엔드포인트에 다시 붙는다 — 처음부터 붙으며, `reduceChunk` 가 순수 fold 이므로
그래도 안전하다. 재접속 예산은 *연속* 실패를 센다: 10분짜리 답변은 깔끔하게 재접속되는 한
몇 번을 끊겨도 살아남고, 생애 상한이 있어서 열릴 때마다 죽는 스트림은 결국 끝난다.

`ChatMessage` 는 `role` (`user` | `assistant` | `tool`) 에 대한 discriminated union 이다:
tool 행은 항상 `toolCallId` 를 나르고, assistant 행은 `toolCalls`/`images`/`files` 를 나를 수
있으며, user 행은 `images`/`documents` 를 나를 수 있고, 불법인 조합은 표현 자체가 불가능하다.
`files` 는 런이 만들어 낸 것이자 읽는 사람이 내려받는 것이다. 그것을 주소로 해석하는 것은
오직 뷰뿐인데, 이미지와 달리 파일은 재생되는 턴 안으로 fetch 되는 일이 결코 없기 때문이다.

한 런은 누적된 텍스트와 그 런의 top-level `toolCalls`, 그리고 그 런이 보고한 `warnings` 를
담은 **평탄화된 assistant 메시지 하나**를 영속화하고, 그 앞에 자기 tool 행들을 둔다 —
subagent 의 것과 transfer 의 것도 포함하며, 이들은 `author`/`displayOnly` 를 나르므로 읽는
사람은 무엇이 실행됐는지 보되 재생은 그것들을 거부한다.

**tool 트래픽은 재생된다.** 이것이 chat 을 다른 모든 표면과 다르게 만드는 결정이다: chat 은
이 플랫폼이 소유하면서 제한 없이 자라도록 두는 유일한 입력원이므로, 나중 턴이 무엇을 볼 수
있는지를 호출자가 아니라 여기서 정해야 한다. 세 가지 budget 이 그것을 제한한다 — 마지막
N개의 assistant 턴, tool 텍스트 budget, 그리고 런 전체 단위의 히스토리 budget — 그리고 오직
세 번째만 **자기가 버린 것을 `warning` chunk 로 보고한다**. 앞의 둘은 설계대로 버리는
것인 반면 세 번째는 읽는 사람이 쓴 것을 버리기 때문이다.

거기서 따라 나오는 메커니즘(한 턴 안의 저장 순서는 wire 순서의 역순이라는 것, tool-call id 가
한 런 안에서만 유일하므로 짝짓기는 한 런으로 범위가 한정된다는 것, 저장된 결과가 없는 호출은
미아로 남기지 않고 버린다는 것)은 설계라기보다 함정이고, `src/application/chat/AGENTS.md` 가
그것들을 편집에 필요한 만큼 상세히 담고 있다.

## 첨부

한 턴은 두 종류의 첨부를 나를 수 있고, 둘은 서로 다른 경로를 탄다.

**이미지**는 바이트로 이동한다. `image_url` content part 가 되고, 런이 이미지를 편집할 수
있도록 엔진이 각각에 핸들을 등록하며, 모델은 `imageInput` 을 선언해야 한다 — 텍스트 전용
모델이 거부하는 part 를 보내면 턴 전체가 실패한다.

**문서는 그것을 받은 표면에서 텍스트가 된다.** PDF, 평문 텍스트, Markdown, CSV/TSV, JSON,
YAML, XML, HTML 은 provider 고유의 file part 가 아니라 텍스트 part 로 턴 안에 읽힌다. 이것은
단순화가 아니라 이 배포에 대한 결정이다: 하나의 model id 는 기본 라우터가 서빙할 수도 있고
그 provider 자신의 OpenAI 호환 엔드포인트(`LLM_PROVIDER_<NAME>_BASE_URL`)가 서빙할 수도
있는데, 그 둘은 file part 를 어떻게 — 또는 보낼 수 있는지 자체를 — 두고 서로 다르게 말한다.
반면 `ModelCapabilities` 는 *모델* 단위라서 채널에 속한 차이를 표현하지 못한다. 텍스트는
capability 게이트가 아예 필요 없고, chat 영속화·재생·PII 필터를 그대로 통과해 살아남는다.

| 조각 | 소유자 |
|---|---|
| 캡(cap), 그리고 어떤 파일이 문서인지 (`documentKind`) | `src/domain/llm/documentLimits.ts` |
| 추출 (포트 — PDF 파서가 필요하다) | `src/domain/llm/documentExtractor.ts`, `src/infrastructure/llm/` 의 `unpdf` 기반 어댑터 |
| budget, warning, 그리고 모델이 읽는 래퍼 | `src/application/llm/documentParts.ts` |
| 바이트가 애초에 텍스트인지 | `src/shared/utf8Text.ts` 의 `decodeUtf8Text` |
| 전송될 때와 재생될 때의 user 턴 본문 | `src/application/llm/documentParts.ts` 의 `turnContent` |

**전부 텍스트인 턴은 문자열로 남는다.** content-parts 배열을 필요하게 만드는 것은 이미지뿐이고,
모델이 받을 수 있다고 선언해야만 통과하는 게이트가 걸리는 것도 이미지뿐이다. 문서가 있다는
이유만으로 텍스트를 part 로 감싸면, 이전에는 어떤 턴도 쓰지 않던 모양을 wire 에 올리면서 얻는
것은 없고 — 어차피 part 들은 이어 붙여진다 — 텍스트를 옳은 선택으로 만들었던 바로 그 채널
독립성을 도로 내주게 된다. `turnContent` 가 그것을 소유하며, 전송과 재생 모두에 대해 그렇다.

하중을 받는 성질이 둘 있다. **아무것도 조용히 사라지지 않는다** — 잘린 문서, 파싱에 실패한
문서, 턴당 개수를 넘은 문서: 각각은 `warning` 이 된다. 아무것도 기여하지 못한 문서는 그 문서를
무시한 모델과 정확히 똑같아 보이기 때문이다. 그리고 **텍스트가 하나도 나오지 않는 파일은
보고된 실패이지, 결코 빈 성공이 아니다**: "이것은 텍스트 레이어가 없는 스캔본이다"는 조치할 수
있는 정보인 반면, 빈 문자열은 "그 문서는 비어 있다"로 읽힌다.

`decodeUtf8Text` 가 존재하는 이유는 `Buffer.toString("utf-8")` 이 결코 throw 하지 않기
때문이다 — 잘못된 시퀀스는 U+FFFD 가 된다 — 그래서 순진한 디코드는 PDF 를 대체 문자로 바꿔
놓고는 성공했다고 보고한다. 이 함수는 바이트를 보고 판정하며(UTF-8 왕복, 그리고 ASCII
UTF-16 을 걸러내기 위한 NUL 검사), 선언된 content type 으로는 결코 판정하지 않는다 — 그 값은
없거나 틀린 경우가 잦아서 진짜 파일을 잃게 만든다. 같은 판정이 MCP tool 결과도 지킨다:
이미지가 아닌 `resource.blob` 이 텍스트가 아니면 `MAX_TOOL_FILE_BYTES` 안에 들어가는 동안은
`file` chunk 로 이동하고(사용자에게 전달된 것으로 결과 텍스트에 이름이 적힌다), 그 크기를
넘으면 통째로 쏟아내는 대신 이름만 적고 생략한다.


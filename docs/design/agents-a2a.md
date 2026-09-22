# 외부 Agent 와 A2A

이 배포 바깥의 엔드포인트를 가리키는 registry 항목, 그리고 양방향 모두가 제공되는
프로토콜. inbound 는 설정된 Agent 가 남이 호출하는 agent 가 되는 쪽이고, outbound 는
transfer 가 그런 agent 에 도달하는 쪽이다.

호출자가 inbound 표면에 어떻게 인증하는지는
[SECURITY.md](../SECURITY.md#머신-호출자의-요청-인증) 에 있고, JSON-RPC
표면은 [API.md](../API.md#a2a-인바운드) 에 있다.

## 외부 Agent (registry)

```ts
ExternalAgent { name, url, protocol?: 'openai' | 'a2a' (absent = openai),
                description, headers (encrypted like MCP), createdAt, updatedAt }
```

`type: 'remote'` subagent 로 쓸 수 있고, 테스트 메시지 엔드포인트로도 쓸 수 있다. `url` 은
MCP 와 마찬가지로 SSRF 가드를 거친다. headers 는 등록된 주소에 귀속되므로 URL 이 바뀌면
기존 값을 버리고 같은 저장에서 새로 입력한 값만 유지한다.

## A2A

**Inbound**: 표면이 켜져 있는 배포에서는(공유 `A2A_API_KEY` 또는 이름 붙은 클라이언트 키가
하나 이상 — 아니면 두 라우트 모두 503 으로 답한다) 현재 설정을 가진 Agent 가
JSON-RPC 엔드포인트를 제공한다. 공개 Agent Card 는 public Project 만 제공하며, private Project 는
무인증 card 요청을 `404`로 숨긴다. 키를 가진 JSON-RPC 호출은 visibility 와 무관하게 허용된다.
카드는 엔드포인트가 요구하는
`X-A2A-Key` 스킴을 `securitySchemes`/`securityRequirements` 로 선언하고 401 은 `WWW-Authenticate` 로 같은
것을 말한다 — 카드에서 자격 증명을 고르는 표준 클라이언트가 그것 없이는 매 호출 401 을 받았다.
SDK 의 request handler 는 세 가지 결정을 덧씌운다(`ProjectRequestHandler`): 읽을 수 없는 part
(data, 그림 아닌 file)는 `ContentTypeNotSupported` 로 **실행 전에** 거절하고, 아직 `working` 인
task 를 `taskId` 로 잇는 메시지는 거절하며(이 executor 는 메시지마다 자기 런을 돌리고
`input-required` 에 들어가지 않으므로, 둘째 런이 같은 `result` artifact 를 서로 리셋했을
것이다), `ResubscribeTask` 는 요청별 event bus 대신 **저장소를 따라간다** — 스냅샷, 도착하는
artifact, 종단 status — 인스턴스가 달라도 되는 유일한 방식이다. 스트리밍 메서드가 첫 이벤트
전에 거절되면 라우트가 JSON-RPC 에러로 답한다. 입력 이미지는 지원되는 `image/*`의 raw bytes만
허용하며 URL·data·다른 media type은 거절한다. `result` artifact는 비어 있지 않은 실제 마지막 update에
`lastChunk: true` 를 붙여 닫힌다. Task 상태는 Project·tenant·인증된 client 단위로 단일
테이블에 저장되므로(`createA2aTaskStore`) 재배포를 견디고 인스턴스 간에 공유되며, terminal
상태를 지키는 조건부 쓰기가 붙어 있어 동시에 들어온 complete/cancel 이 이미 끝난 task 를
되돌리는 일이 없다. 행은 TTL 로 만료된다. `ListTasks` 는 인증된 client 의 partition 안에서
status timestamp 내림차순의 GSI 와 opaque cursor 로 페이지를 잇는다. payload 는 `pageSize + 1`
행만 읽어 다음 페이지 유무를 판정하고, 정확한 `totalSize` 는 task 를 적재하지 않는 별도 count 로
계산한다. context·status·timestamp·만료 조건은 모두 SQL 의 `LIMIT` 전에 적용된다.

라우트는 선택적인 `tenant`가 문자열인지 검증하고, SDK transport가 요청의 `ServerCallContext`에
한 번만 설정한다. executor도 같은 context를 공유하므로 취소를 포함한 저장소 접근의 범위가 일치한다.

실행 중 cancel 은 공유 task store 를 순차 폴링한다. 한 읽기가 끝난 뒤 다음 간격을 시작하므로
저장소가 느려져도 같은 task 의 조회가 중첩되지 않고, 실행이 끝난 뒤 돌아온 읽기는 상태를
바꾸지 않는다.

**Outbound**: 프로토콜 `A2A` 와 자신의 Agent Card URL 로 등록된 agent 다. 커스텀 헤더는 카드
해석과 RPC 호출에 함께 보낸다 — 단 **카드가 지목한 `url` 의 origin 이 등록된 카드 URL 의
origin 과 같을 때만**: 헤더는 등록된 주소를 위한 자격 증명이고, 다른 origin 을 지목하는 카드는
제3자가 서빙하는 문서가 리다이렉트와 같은 말을 JSON 으로 한 것이다. **task 의 상태가 먼저
결정한다.** `failed`/`rejected`/`canceled` 는 그 status 메시지를 이유로 한 실패이고(텍스트만
읽으면 "Agent execution error: …" 가 부모 모델의 답이 됐다), `input-required`/`auth-required` 는 질문이다 —
질문이 tool 에러로 부모에 닿고, `taskId` 가 `contextId` 옆에 기억되어 같은 대화의 다음 transfer
가 새 task 를 여는 대신 그 task 에 답한다. 블로킹 `SendMessage` 가 아직 살아 있는 task 로
답하면 `GetTask` 로 종단까지 따라가고, 응답은 누적 중에도 2MB 에서 끊는다. transfer 는
**`SendStreamingMessage`** 를 요청하고, 받은 이벤트들을
blocking send 였다면 돌려받았을 task 로 도로 접어 넣는다. 그래서 두 경로를 같은 두 extractor
가 읽고, artifacts-over-status 규칙의 사본이 둘로 갈리지 않는다. `capabilities.streaming` 이
없는 카드는 blocking `SendMessage` 한 번으로 폴백한다 — SDK 가 요청이 나가기 전에 거절하고,
그 점이 이 폴백을 안전하게 만든다. **스트리밍 카드에서 한계는 침묵에 걸리지, 교환 전체에
걸리지 않는다**: 원격의 조사는 그 업데이트 사이의 어떤 간격보다도 훨씬 오래 이어질 수 있고,
총합은 런 자신의 데드라인이 제한한다. blocking 폴백에는 그 타이머를 되돌릴 이벤트가 없으므로,
거기서는 같은 120초가 예전부터 그랬듯 요청 전체의 한계다. 첫 이벤트 이후 끊어진 스트림은
재시도하지 않고 보고한다. 원격은 이미 일하고 있고, 두 번째 send 는 위임을 두 번 실행하게 되기
때문이다.

**transfer 는 원격의 대화를 이어 간다.** 프로토콜의 장치는 `contextId` 다. 원격이 첫
메시지에서 하나를 발급하고, 그것을 실어 오는 이후 메시지들을 같은 대화로 묶는다. 어느 것을
실을지는 `RunOrigin.conversation` 이 답한다 — MCP 헤더가 이름 붙이는 것과 같은 키다 —
*transfer 하는 project × agent × conversation* 마다 하나씩인 행을 통해서다(`REMOTECTX#…`,
`RemoteConversationRepository` 가 소유하고 `runRemoteSubagent` 가 쓴다). 응답의 `contextId` 는
성공한 transfer 마다 기억해 두었다가 같은 대화에서 나가는 다음 transfer 에 도로 실어 보낸다.
Project 로 키를 잡은 것은 의도적이다 — 한 Slack 스레드에서 답하는 두 Project 의 봇은 원격
agent 를 부르는 서로 다른 두 호출자이고, 컨텍스트가 하나면 서로에게 상대의 턴이 보인다 —
그리고 원격의 대화가 아니라 이쪽의 대화로 키를 잡는데, 원격의 키는 바로 지금 조회하려는
대상이기 때문이다. 이것은 일주일 TTL 을 가진 힌트이고 쓸 때마다 갱신된다. 하나를 잃으면 다음
transfer 가 cold start 를 치르는데, 그것은 이 행이 생기기 전 모든 transfer 가 겪던 바로
그것이며, 읽을 수 없는 저장소는 transfer 를 실패시키지 않고 cold 로 시작한다. 컨텍스트를
*이어받아* 진행하다 실패한 transfer 는 힌트를 버린다 — 원격이 그 컨텍스트를 폐기했을 수 있고,
잘못된 힌트를 계속 들고 있으면 만료될 때까지 모든 transfer 가 대가를 치르는 반면 버리면 cold
start 한 번으로 끝난다. 그 자리에서 재시도하지는 않는다. 원격이 이미 일하고 있을 수 있고, 두
번째 send 는 위임을 두 번 실행하게 되기 때문이다. OpenAI 형태의 원격은 이어 갈 대화가 없어서
아무것도 받지 않는다. 대화가 없는 런 — 트리거 발화, `X-Conversation-Id` 를 보내지 않은 API
호출 — 은 예전과 같이 cold 로 transfer 한다.

이어 가는 transfer 에서도 transcript 는 여전히 함께 간다. 둘은 같은 것이 아니다. transcript
는 마지막 hand-off 이후 *이쪽에서* 오간 말 — 원격이 본 적 없는 턴들 — 이고, 원격의 컨텍스트는
그쪽이 말하고 행한 것이다. 두 번째 질문은 둘 다를 나르며, 겹치는 부분은 앞선 턴들이고 그 양은
transcript 자신의 8,000자로 제한된다. 이어 갈 때 transcript 를 버리면 그 겹침을 아끼자고 로컬
턴들을 잃게 되고, 자기 이력을 남기지 않는 원격 — 이 플랫폼의 inbound 쪽은 메시지 하나하나를
단독으로 실행한다 — 은 그러면 아무것도 보지 못한다.

SSE 프레이밍은 프로토콜마다 다르다. `sseResponse` 는 OpenAI 의 `[DONE]` 종료자를 쓰고,
`sseResponseRaw` 는 A2A JSON-RPC 프레이밍을 쓴다(`src/app/api/_lib/sse.ts`).

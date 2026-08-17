# 외부 Agent 와 A2A

이 배포 바깥의 엔드포인트를 가리키는 registry 항목, 그리고 양방향 모두가 제공되는
프로토콜. inbound 는 published 된 Project 가 남이 호출하는 agent 가 되는 쪽이고, outbound 는
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
MCP 와 마찬가지로 SSRF 가드를 거친다.

## A2A

**Inbound**: 표면이 켜져 있는 배포에서는(공유 `A2A_API_KEY` 또는 이름 붙은 클라이언트 키가
하나 이상 — 아니면 두 라우트 모두 503 으로 답한다) published 된 Version 을 가진 모든 Project
가 공개 Agent Card 와 JSON-RPC 엔드포인트를 제공한다. Task 상태는 Project 단위로 단일
테이블에 저장되므로(`createA2aTaskStore`) 재배포를 견디고 인스턴스 간에 공유되며, terminal
상태를 지키는 조건부 쓰기가 붙어 있어 동시에 들어온 complete/cancel 이 이미 끝난 task 를
되돌리는 일이 없다. 행은 TTL 로 만료된다.

**Outbound**: 프로토콜 `A2A` 와 자신의 Agent Card URL 로 등록된 agent 다. 커스텀 헤더는 카드
해석과 RPC 호출에 함께 보낸다. transfer 는 **`message/stream`** 을 요청하고, 받은 이벤트들을
blocking send 였다면 돌려받았을 task 로 도로 접어 넣는다. 그래서 두 경로를 같은 두 extractor
가 읽고, artifacts-over-status 규칙의 사본이 둘로 갈리지 않는다. `capabilities.streaming` 이
없는 카드는 blocking `message/send` 한 번으로 폴백한다 — SDK 가 요청이 나가기 전에 거절하고,
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

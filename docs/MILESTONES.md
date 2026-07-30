# 마일스톤

Agent Studio는 프로젝트·버전 관리, LLM/에이전트 실행, Skills/MCP/외부 에이전트,
Slack/A2A 연동, 사용량 집계와 트레이스를 갖추고 있다. 이 문서는 구현 이력이 아니라
프로덕션 운영에 남은 작업만 우선순위대로 관리한다.

기반 정리는 끝났다. 레이어 경계는 `tests/architecture.test.ts`가 강제한다 — 일곱 개
규칙 모두 허용 목록이 비어 있고, 이름 붙인 불변식은 저마다 소유 파일이 하나씩 지정돼
사본이 생기면 실패한다. 아래 기능 작업은 그 위에 얹는다: 새 어댑터는 포트 뒤로 가고,
조립은 `lib/container.ts`에서만 하며, 새 실행 정책은 `runStrategyFor`가 있는 파사드
한 곳에 붙는다.

**규약**

- 각 마일스톤은 **완료 조건**을 자동으로 확인할 수 있어야 한다. 확인 방법이 정해지지
  않은 작업은 마일스톤에 넣지 않는다.
- "한 곳에만 있다"는 완료 조건은 **테스트로 고정한다** — `tests/architecture.test.ts`의
  single-owner 불변식이 그 자리다. 서술로만 남은 단일 소유는 다음 진입점이 생길 때
  조용히 깨진다.
- **선행**이 있는 마일스톤은 선행이 끝나기 전에 착수하지 않는다.
- 완료된 마일스톤은 이 문서에서 제거한다. 이력은 git log와 태그별 GitHub Release
  (`.github/workflows/release.yml`가 커밋 목록으로 생성)가 source다.
- 식별자는 **재사용하지 않는 slug**를 쓴다. 완료된 마일스톤을 지우는 규약 때문에 번호는
  반드시 재사용되고, 실제로 `M4`는 세 가지 서로 다른 기능을 가리킨 이력이 있다
  (API Reference 탭 → 프로젝트별 MCP 헤더 오버라이드 → 비용 임계값). 커밋 메시지의
  `(M4)`는 지금 어느 것도 가리키지 못한다.
- 동작 보존 작업은 기존 테스트를 수정해서 통과시키면 완료가 아니다.

**선행 관계**

```
schedule-trigger   (durable worker 결정 대기)
context-budget     (run-termination 선행 — 예산 소진으로 루프를 끝내려면 종료 이유가 먼저)
```

---

## run-termination — run이 왜 끝났는지 말한다

**이유**: 이 저장소는 잃은 것을 반드시 말하는 규약을 일관되게 지킨다 — tool 결과 절단은 결과
텍스트에 적히고, transcript 절단·해석 실패한 스킬/에이전트/MCP·채팅 히스토리 절단은 모두
`warning` chunk가 된다. 그런데 **가장 큰 절단인 "답 없이 run이 끝난다"만 조용하다.** turn
guard는 `engine.ts`의 루프 첫머리에서 `return;` 한 줄이다(`turn >= maxTurn`). warning도,
`done`도, 아무 chunk도 없이 스트림이 닫힌다.

그 침묵이 아래로 번진다:

- **OpenAI 레이어가 `finish_reason`을 부재로 역산한다.** `src/app/api/projects/_lib/openai.ts`는
  `done`이 오면 `stop`, 안 오면 `length`를 보낸다. 그런데 `done`이 없는 경우는 turn guard만이
  아니다 — 취소(abort)와 mid-stream 에러도 `done`을 내지 않는다. **사용자가 중단한 run이
  "출력 길이 초과"로 보고된다.**
- **트레이스가 turn guard 종료를 성공으로 기록한다.** generator가 정상 반환하므로
  `executeAgent`의 `completed`가 `true`가 되고, `finishTrace`는 에러도 취소도 아닌 완료로
  남긴다. 답을 주지 못한 run이 관측 위에서 정상이다.
- 채팅·Slack·콘솔은 애초에 구분할 방법이 없다. 사용자는 답이 왜 없는지 알 수 없다.

**근본 원인**: 종료 이유에 소유자가 없다. `done: true` 하나가 정상 종료만 표현하고 나머지는
전부 *부재로부터의 추론*이며, 그 추론이 소비자마다 흩어져 있다. `isTopLevelChunk`가 author
semantics를 한 곳에 소유해 재유도를 막은 것과 정확히 같은 문제이고, 같은 해법이 필요하다.

**선행**: 없음. `context-budget`이 이것을 선행으로 갖는다.

**범위**

- 종료 이유를 `EngineChunk`에 **명시적으로** 싣는다 — 정상 종료, turn 한도, 취소, 에러가
  서로 다른 값이다. `src/domain/llm/types.ts`가 그 값의 단일 소유자이며, 판별은
  `isTopLevelChunk`처럼 owned predicate로 노출한다.
- turn guard가 이유와 함께 `warning`을 내고 끝낸다.
- `openai.ts`가 역산을 멈추고 이유를 읽는다. 취소는 `length`가 아니다.
- 트레이스가 turn 한도 종료를 정상 완료와 구분해 기록한다.
- 채팅·Slack·콘솔이 이유를 사용자에게 보여준다.
- 하위 호환: 지금 `done`을 읽는 소비자가 전부 있으므로, 기존 필드의 의미를 바꾸는 대신
  이유를 더하는 쪽이 안전한지 먼저 판단하고 결정을 기록한다.

**완료 조건**

- `maxTurn`에 걸린 run이 turn 한도를 이유로 든 종료 chunk와 `warning`을 낸다.
- 취소된 run과 mid-stream 에러가 `finish_reason: "length"`로 보고되지 않는다.
- 트레이스에서 turn 한도로 끝난 run이 정상 완료와 구분된다.
- 어떤 소비자도 `done`의 부재로 이유를 추론하지 않는다 —
  `tests/architecture.test.ts`의 single-owner 불변식으로 고정한다.
- 정상 종료 경로의 출력은 바이트 단위로 동일하다.

---

## context-budget — run이 컨텍스트에 쌓는 총량의 소유자

**이유**: 상한은 많지만 **합계를 보는 곳이 없다.** 지금 있는 것은 전부 항목별·turn별이다 —
tool 결과 `MAX_TOOL_RESULT_CHARS_PER_TURN`(200,000자, **turn당**), 이미지
`MAX_ATTACHMENTS`(4, turn당), transcript `MAX_TRANSFER_CONTEXT_CHARS`(8,000자), 그리고 채팅
진입에만 있는 `MAX_HISTORY_CHARS`/`MAX_HISTORY_MESSAGES`. 루프의 `messages` 배열은 turn마다
자라고 `maxTurn`은 기본 50이다. 즉 **한 run이 컨텍스트에 넣을 수 있는 총량에는 상한이 없다.**
transfer가 자식 답변을 넣는 `postContextMessages`는 상한이 아예 없는 자리다.

`contextWindow`는 이미 모델마다 정의돼 있다(`src/domain/llm/models.ts`). **엔진이 그것을 읽지
않는다** — 정보는 있는데 쓰이지 않는 상태다. 그래서 컨텍스트 초과는 예산 초과로 처리되지
못하고 provider의 400으로 나타나며, 첫 chunk 이후라면 재시도 없이 `{error}` chunk가 된다.
도구를 많이 쓰는 긴 run이 원인 불명으로 죽는다.

**진입점별 방어도 고르지 않다.** 채팅만 히스토리 예산을 갖고, predict / OpenAI 호환 /
Slack / A2A / webhook trigger는 받은 `messages`를 그대로 넘긴다. 같은 모델에 같은 크기의
입력을 주면서 한 경로만 보호된다.

**선행**: `run-termination`. 예산 소진을 이유로 루프를 끝내는 선택지를 쓰려면 종료 이유를
말할 수 있어야 한다. 절단만으로 끝낼 수 있다면 선행 없이 착수 가능하며, 어느 쪽인지 설계
단계에서 먼저 정한다.

**범위**

- run 단위 누적 예산의 **단일 소유자**를 만든다. 모델의 `contextWindow`에서 유도하고,
  기존 항목별 상한은 그 아래에 남긴다 — 상한을 없애는 작업이 아니라 합계를 아는 작업이다.
- `postContextMessages`(transfer 답변, MCP 반환 이미지의 동반 메시지)를 예산 안으로 넣는다.
- 절단은 기존 규약대로 `warning`으로 보고한다. 조용히 버리지 않는다.
- 문자 수와 토큰의 관계를 어떻게 근사할지 결정하고 기록한다. 정확한 토큰 계산은 provider별
  tokenizer를 요구하므로, 보수적 문자 기반 근사로 시작할지 판단한다.
- 진입점별 불균형을 정리한다 — 히스토리 예산을 모든 진입점이 지나는 자리로 옮길지, 아니면
  채팅 전용임을 근거와 함께 문서에 남길지 결정한다.

**설계 메모**: `MAX_TOOL_RESULT_CHARS_PER_TURN`이 200,000자라는 것은 **한 turn만으로도** 작은
컨텍스트 창을 넘길 수 있다는 뜻이다. 즉 이 마일스톤은 "긴 run"만의 문제가 아니라 per-turn
상한이 모델과 무관하게 정해져 있다는 문제이기도 하다. 예산을 모델에서 유도하면 두 문제가
같은 곳에서 해결된다.

**완료 조건**

- 작은 `contextWindow`를 가진 모델로 도구를 반복 호출하는 run이 provider 400 대신 예산
  절단과 `warning`으로 처리된다.
- transfer 답변이 예산에 포함된다 — 자식 답변을 크게 만든 fake로 절단이 보고되는 것을
  확인한다.
- 예산 계산은 한 곳에만 있다. `tests/architecture.test.ts`의 single-owner 불변식으로 고정한다.
- 예산에 여유가 있는 run의 요청 본문은 바이트 단위로 동일하다.

## schedule-trigger — 스케줄 트리거

**이유**: 정기 작업으로 published project를 실행할 수 있어야 한다. Webhook과 달리
단일 Next.js process 내부 timer로는 만족스럽게 구현할 수 없어 durable scheduler/worker
경계가 필요하며, 이 인프라 결정이 `webhook-trigger`와 규모를 다르게 만든다.

**선행**: 없음. 트리거 저장 구조·실행 이력·중복 제거 규약은 webhook 쪽이 확정했다
(`domain/trigger/`, `PROJECT#{name} / TRIGGER#…` 및 `TRIGGERRUN#…`).

**범위**

- 실행 환경에 맞는 durable scheduler/worker 경계를 선택하고 그 결정을
  `docs/ARCHITECTURE.md`에 기록한다. **이 선택이 끝나기 전에는 구현에 착수하지 않는다.**
- 프로젝트별 schedule 트리거: cron expression과 timezone.
- 동일 schedule 시각의 중복 실행 방지(조건부 쓰기 기반).
- 실행 이력·중첩 정책은 webhook 트리거의 구조를 재사용한다 — `TriggerRepository`,
  `TriggerRun`, 그리고 중첩 방지에 쓰는 run slot lease.
- `TriggerKind`에 `"schedule"`을 더하고, cron 평가만 새로 만든다.

**설계 메모 — 이 결정에는 이미 고객이 둘 더 있다.** Slack 이벤트와 webhook 딜리버리는
모두 즉시 ack하고 `after()`로 백그라운드에서 돈다. 그래서 작업을 claim한 인스턴스가
급사하면 처리가 중단된다 — Slack은 claim lease가 회수되지만 재처리는 없고, webhook은
이력 row가 `running`인 채로 남는다. 같은 durable worker 경계가 두 공백을 함께 메운다.
후보를 평가할 때 schedule 하나가 아니라 **세 소비자**(schedule, Slack, webhook)를 놓고
판단하고, 앞의 둘을 옮길지 여부를 결정에 함께 기록한다.

이 마일스톤이 남아 있는 이유도 이것이다: 나머지는 코드 결정이지만 이건 배포 환경
결정이고(EKS + ArgoCD가 현재 타깃), 무엇을 쓸지는 저장소 안에서 판단할 수 없다.

**완료 조건**: schedule이 published version을 지정 시각에 실행하고, 비활성 트리거는
실행하지 않는다. 여러 Agent Studio 인스턴스가 동시에 동작해도 동일 schedule 시각에
실행이 정확히 한 번 일어난다. 중복 제거·실패·재시작 후 복구를 테스트로 검증한다.

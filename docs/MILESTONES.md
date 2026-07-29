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
webhook-trigger ──→ schedule-trigger        run-observability
```

---

## webhook-trigger — Webhook 트리거

**이유**: 현재 실행은 사용자 요청, Slack, A2A 호출에 의존한다. 외부 시스템이 이벤트로
published project를 실행할 수 있어야 운영 워크플로에 연결된다. Webhook은 기존 요청·응답
경계 안에서 처리되므로 새 인프라 없이 도입할 수 있다.

**선행**: 없음. 트리거 실행의 주체는 `RunActor`에 `webhook` kind를 더해 표현한다 —
사람이 없는 호출도 주체가 있다는 규약은 이미 서 있다.

**범위**

- 프로젝트별 webhook 트리거 생성·활성화·비활성화.
- 프로젝트별 인증 URL과 secret. secret은 암호화 저장하고 조회 시 masking
  (`SecretCipher` 포트 사용).
- 항상 published version만 실행. published version이 없으면 실행하지 않는다.
- 고정 입력과 trigger payload를 project variables 또는 agent message로 전달.
- `Idempotency-Key` 기반 중복 실행 방지.
- 동시 실행 시 중첩 허용 여부를 명시적으로 설정.
- 실행 상태, 시작·종료 시각, 결과·오류, `traceId`를 이력으로 저장.
- 콘솔에서 트리거 설정과 최근 실행 결과를 확인.

**설계 메모**: 실행 이력 item은 `schedule-trigger`가 그대로 재사용한다. 키 구조와 TTL은
여기서 확정되므로, 프로젝트 파티션 안에서 트리거 종류(webhook/schedule)를 구분할 수 있게
설계한다. 나머지 run 관련 row와 마찬가지로 `expiresAt`을 붙여 무한 증식을 막는다.

**완료 조건**: webhook 호출이 published version을 실행하고, 비활성 트리거와 published
version이 없는 프로젝트는 실행하지 않는다. 같은 `Idempotency-Key`가 재전달돼도 실행
이력이 중복 생성되지 않는다. 성공·실패·중복 제거·인증 실패·동시 실행 정책을 테스트로
검증하고, 콘솔에서 설정과 최근 실행 결과를 확인할 수 있다.

---

## schedule-trigger — 스케줄 트리거

**이유**: 정기 작업으로 published project를 실행할 수 있어야 한다. Webhook과 달리
단일 Next.js process 내부 timer로는 만족스럽게 구현할 수 없어 durable scheduler/worker
경계가 필요하며, 이 인프라 결정이 `webhook-trigger`와 규모를 다르게 만든다.

**선행**: `webhook-trigger`. 트리거 저장 구조, 실행 이력, 중복 제거 규약을 그쪽이
확정한다.

**범위**

- 실행 환경에 맞는 durable scheduler/worker 경계를 선택하고 그 결정을
  `docs/ARCHITECTURE.md`에 기록한다. **이 선택이 끝나기 전에는 구현에 착수하지 않는다.**
- 프로젝트별 schedule 트리거: cron expression과 timezone.
- 동일 schedule 시각의 중복 실행 방지(조건부 쓰기 기반).
- 실행 이력·중첩 정책은 `webhook-trigger`의 구조를 재사용한다.

**설계 메모 — 이 결정에는 이미 고객이 하나 더 있다.** Slack 이벤트 처리는 3초 ack 후
`after()`로 백그라운드에서 돌기 때문에, 이벤트를 claim한 인스턴스가 급사하면 작업이
중단된다(claim은 lease라 회수는 되지만 재처리는 없다). 같은 durable worker 경계가 이
공백도 메운다. 후보를 평가할 때 schedule 하나가 아니라 두 소비자를 놓고 판단하고,
Slack 경로를 옮길지 여부를 결정에 함께 기록한다.

**완료 조건**: schedule이 published version을 지정 시각에 실행하고, 비활성 트리거는
실행하지 않는다. 여러 Agent Studio 인스턴스가 동시에 동작해도 동일 schedule 시각에
실행이 정확히 한 번 일어난다. 중복 제거·실패·재시작 후 복구를 테스트로 검증한다.

---

## run-observability — 실행 상관 id와 실패 신호

**이유**: `/api/metrics`는 in-flight run 수, unknown model, draining만 낸다 — 실패율도
지속시간 분포도 없어 "느려졌다 / 실패하고 있다"를 알람으로 잡을 수 없다. 로그는 49곳의
`console.*`가 `[run]` `[mcp]` `[slack]` 같은 임의 접두사로 나가고 실행 식별자가 붙지
않아, 한 실행에서 나온 로그를 모을 수 없다.

**선행**: 없음. `run-attribution`과 짝을 이루지만(주체를 로그에도 남길 수 있게 된다)
그쪽을 기다릴 이유는 없다.

**범위**

- run 단위 상관 id. **trace id와 별개여야 한다** — trace는 비-agent 경로에서
  `TRACE_SAMPLE_RATE`(기본 0.1)로 샘플링되므로, trace id를 상관 id로 쓰면 그 경로 로그의
  90%는 붙일 id가 없다. trace가 있으면 상관 id와 서로 연결한다.
- `console.*` 직접 호출의 소유자를 한 곳으로 모으고, 그 사실을
  `tests/architecture.test.ts`의 single-owner 불변식으로 고정한다.
- `/api/metrics`에 실행 실패 카운터와 지속시간 히스토그램을 추가한다.
- 라벨 규칙은 지금 것을 유지한다: 프로젝트·사용자·모델을 라벨로 쓰지 않는다. unknown
  model을 라벨이 아니라 개수로 세는 현재 선택과 같은 이유(카디널리티)다.

**완료 조건**: 한 run에서 나온 모든 로그 라인이 같은 상관 id를 달고, 샘플링돼 trace가
없는 run도 마찬가지임을 테스트로 검증한다. 로거 소유 파일 밖의 `console.*` 직접 호출이
architecture test에서 실패한다. 스크레이프 출력에 실패 수와 지속시간 분포가 있고, 어떤
metric도 프로젝트·사용자·모델을 라벨로 담지 않음을 테스트로 고정한다.

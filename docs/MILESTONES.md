# 마일스톤

Agent Studio는 프로젝트·버전 관리, LLM/에이전트 실행, Skills/MCP/외부 에이전트,
Slack/A2A 연동, 사용량 집계와 트레이스를 갖추고 있다. 이 문서는 구현 이력이 아니라
프로덕션 운영에 남은 작업만 우선순위대로 관리한다.

기반 정리(M1~M3)는 끝났다. 레이어 경계는 `tests/architecture.test.ts`가 강제한다 —
일곱 개 규칙 모두 허용 목록이 비어 있고, 이름 붙인 불변식은 저마다 소유 파일이 하나씩
지정돼 사본이 생기면 실패한다. 아래 기능 작업은 그 위에 얹는다: 새 어댑터는 포트 뒤로
가고, 조립은 `lib/container.ts`에서만 하며, 새 실행 정책은 `runStrategyFor`가 있는
파사드 한 곳에 붙는다.

**규약**

- 각 마일스톤은 **완료 조건**을 자동으로 확인할 수 있어야 한다. 확인 방법이 정해지지
  않은 작업은 마일스톤에 넣지 않는다.
- **선행**이 있는 마일스톤은 선행이 끝나기 전에 착수하지 않는다.
- 완료된 마일스톤은 이 문서에서 제거한다. 이력은 git log와 CHANGELOG가 source다.
- 동작 보존 작업은 기존 테스트를 수정해서 통과시키면 완료가 아니다.

---

## M4 — 비용 임계값 알림 및 차단

**이유**: 프로젝트별·모델별 일간 비용은 집계되지만 이를 사용하는 보호 장치가 없다.
폭주하는 루프나 대량 호출자가 턴 제한 안에서 계속 비용을 발생시킬 수 있다.

**선행**: 없음(기반 정리 완료).

**범위**

- 프로젝트별 `alertThresholdUsd`와 `blockThresholdUsd` 설정(선택 사항).
- 일간(UTC) 비용이 알림 임계값을 넘으면 조건부 쓰기로 하루 한 번 Slack 알림 전송.
- 차단 임계값을 넘으면 그날 남은 시간 동안 추가 실행 거부.
- 실행 파사드 진입 시 사전 검사하고 사용량 flush 후 사후 검사.
- 보호 장치 조회·쓰기 실패는 실행을 막지 않는 fail-open 처리.

**완료 조건**: 차단 임계값을 초과한 프로젝트는 UTC 기준 해당 날짜의 남은 시간 동안
모든 실행 진입점(predict, chat/completions, agent, chat, Slack, A2A, 이미지 생성)에서
거부되고, 알림은 하루에 정확히 한 번 발생한다. 임계값 초과·중복 제거·fail-open 동작을
테스트로 검증한다. 가드가 파사드 한 곳에만 있어, 진입점을 새로 추가해도 자동으로 적용된다.

---

## M5 — Webhook 트리거

**이유**: 현재 실행은 사용자 요청, Slack, A2A 호출에 의존한다. 외부 시스템이 이벤트로
published project를 실행할 수 있어야 운영 워크플로에 연결된다. Webhook은 기존 요청·응답
경계 안에서 처리되므로 새 인프라 없이 도입할 수 있다.

**선행**: 없음(기반 정리 완료).

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

**완료 조건**: webhook 호출이 published version을 실행하고, 비활성 트리거와 published
version이 없는 프로젝트는 실행하지 않는다. 같은 `Idempotency-Key`가 재전달돼도 실행
이력이 중복 생성되지 않는다. 성공·실패·중복 제거·인증 실패·동시 실행 정책을 테스트로
검증하고, 콘솔에서 설정과 최근 실행 결과를 확인할 수 있다.

---

## M6 — 스케줄 트리거

**이유**: 정기 작업으로 published project를 실행할 수 있어야 한다. Webhook과 달리
단일 Next.js process 내부 timer로는 만족스럽게 구현할 수 없어 durable scheduler/worker
경계가 필요하며, 이 인프라 결정이 M5와 규모를 다르게 만든다.

**선행**: M5. 트리거 저장 구조, 실행 이력, 중복 제거 규약을 M5가 확정한다.

**범위**

- 실행 환경에 맞는 durable scheduler/worker 경계를 선택하고 그 결정을
  `docs/ARCHITECTURE.md`에 기록한다. **이 선택이 끝나기 전에는 구현에 착수하지 않는다.**
- 프로젝트별 schedule 트리거: cron expression과 timezone.
- 동일 schedule 시각의 중복 실행 방지(조건부 쓰기 기반).
- 실행 이력·중첩 정책은 M5의 구조를 재사용한다.

**완료 조건**: schedule이 published version을 지정 시각에 실행하고, 비활성 트리거는
실행하지 않는다. 여러 Agent Studio 인스턴스가 동시에 동작해도 동일 schedule 시각에
실행이 정확히 한 번 일어난다. 중복 제거·실패·재시작 후 복구를 테스트로 검증한다.

---

## M7 — Managed local MCP

**이유**: 현재 Tools에는 이미 실행 중인 public streamable-HTTP MCP server만 등록할 수
있다. 운영자가 승인한 MCP server를 Agent Studio가 배포하고 수명 주기를 관리하면 별도
MCP 인프라를 수동으로 운영하지 않아도 된다.

**선행**: M6. workload provisioner는 M6이 도입하는 durable worker 경계 위에서 동작한다.
이 마일스톤을 먼저 하려면 그 경계를 여기서 함께 정해야 하며, 그 경우 규모가 두 배가 된다.

**범위**

- 이 마일스톤은 런타임 어댑터를 **하나만** 구현한다. 배포 환경에서 실제로 쓰는 것을
  선택하고, 나머지는 어댑터 계약만 정의한 채 남긴다. 세 런타임을 동시에 구현하지 않는다.
- MCP 유형을 `remote`와 `managed`로 구분하고 기존 원격 등록 동작은 유지.
- managed MCP에는 승인된 artifact(image 또는 task definition), 실행 설정, resource limit,
  health check, secret reference를 저장한다. 임의 command·image 실행은 허용하지 않는다.
- 명시적 runtime 설정을 우선하고, 설정이 `auto`일 때만 실행 환경을 탐지한다.
- desired/observed 상태와 workload identity를 영속화하고, 조건부 쓰기·lease 기반
  reconciler로 여러 인스턴스의 중복 생성·삭제를 방지한다.
- 생성·시작·중지·재시작·삭제와 health/status 조회를 지원하고, 실패 원인과 최근 상태
  변경 시각을 콘솔에 표시한다.
- managed endpoint는 provisioner가 반환한 workload identity로만 신뢰한다. 일반 remote
  MCP의 SSRF 검증(`UrlPolicy` 포트)을 우회하거나 임의 private URL 등록을 허용하지 않는다.
- 최소 권한 IAM/RBAC와 network policy를 적용하고, application container에 host Docker
  socket을 직접 노출하지 않는다.

**완료 조건**: 구현한 어댑터의 계약 테스트와 실제 runtime 통합 테스트에서 managed MCP를
생성해 `tools/list`와 `tools/call`을 수행하고 삭제할 수 있다. 두 Agent Studio 인스턴스가
동시에 reconcile해도 workload가 하나만 생성되며, 재시작 후 기존 workload를 재발견한다.
권한 부족·이미지 pull 실패·health check 실패·중복 요청·삭제 재시도를 검증하고,
remote MCP 동작과 SSRF 보호가 그대로 유지된다.

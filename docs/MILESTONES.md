# 마일스톤

Agent Studio는 프로젝트·버전 관리, LLM/에이전트 실행, Skills/MCP/외부 에이전트,
Slack/A2A 연동, 사용량 집계와 트레이스를 갖추고 있다. 이 문서는 구현 이력이 아니라
프로덕션 운영에 남은 필수 기능만 우선순위대로 관리한다.

## M1 — 비용 임계값 알림 및 차단

**이유**: 프로젝트별·모델별 일간 비용은 집계되지만 이를 사용하는 보호 장치가 없다.
폭주하는 루프나 대량 호출자가 턴 제한 안에서 계속 비용을 발생시킬 수 있다.

**범위**

- 프로젝트별 `alertThresholdUsd`와 `blockThresholdUsd` 설정(선택 사항).
- 일간(UTC) 비용이 알림 임계값을 넘으면 조건부 쓰기로 하루 한 번 Slack 알림 전송.
- 차단 임계값을 넘으면 그날 남은 시간 동안 추가 실행 거부.
- 실행 진입 시 사전 검사하고 사용량 flush 후 사후 검사.
- 보호 장치 조회·쓰기 실패는 실행을 막지 않는 fail-open 처리.

**완료 조건**: 차단 임계값을 초과한 프로젝트는 UTC 기준 해당 날짜의 남은 시간 동안
모든 실행 진입점(predict, chat/completions, agent, chat, Slack, A2A)에서 거부되고,
알림은 하루에 정확히 한 번 발생하며, 임계값 초과·중복 제거·fail-open 동작을
테스트로 검증한다.

## M2 — 자동화 트리거

**이유**: 현재 실행은 사용자 요청, Slack, A2A 호출에 의존한다. 정기 작업이나 외부
시스템 이벤트로 published project를 실행할 수 있어야 운영 워크플로에 연결할 수 있다.

**범위**

- 프로젝트별 automation 생성·활성화·비활성화.
- Trigger 유형:
  - `schedule`: cron expression과 timezone.
  - `webhook`: 프로젝트별 인증 URL과 secret.
- 항상 published version만 실행.
- 고정 입력과 trigger payload를 project variables 또는 agent message로 전달.
- 동일 schedule 시각이나 webhook `Idempotency-Key`의 중복 실행 방지.
- 동시 실행 시 중첩 허용 여부를 명시적으로 설정.
- 실행 상태, 시작·종료 시각, 결과·오류, `traceId`를 이력으로 저장.
- Webhook secret은 암호화 저장하고 조회 시 masking.
- 스케줄 실행기는 단일 Next.js process 내부 timer가 아니라 durable scheduler/worker
  경계를 사용.

**완료 조건**: schedule과 webhook이 각각 published version을 실행하고, 비활성
automation과 published version이 없는 프로젝트는 실행하지 않는다. 동일 trigger가
재전달돼도 실행 이력이 중복 생성되지 않으며 성공·실패·중복 제거·인증 실패·동시 실행
정책을 테스트로 검증한다. 콘솔에서 automation 설정과 최근 실행 결과를 확인할 수 있다.

## M3 — Managed local MCP

**이유**: 현재 Tools에는 이미 실행 중인 public streamable-HTTP MCP server만 등록할 수
있다. 운영자가 승인한 MCP server를 Agent Studio가 현재 실행 환경에 맞는 하위
workload로 배포하고 수명 주기를 관리하면 별도 MCP 인프라를 수동으로 운영하지 않고
프로젝트에서 사용할 수 있다.

**범위**

- MCP 유형을 `remote`와 `managed`로 구분하고 기존 원격 등록 동작은 유지.
- managed MCP에는 승인된 artifact(image 또는 task definition), 실행 설정, resource
  limit, health check, secret reference를 저장하고 임의 command·image 실행은 허용하지 않음.
- 명시적 runtime 설정을 우선하고, 설정이 `auto`일 때만 실행 환경을 탐지:
  - container/EC2: 제한된 container runtime adapter.
  - ECS: 별도 ECS task 또는 service.
  - Kubernetes: 별도 Deployment와 ClusterIP Service.
- desired/observed 상태와 workload identity를 영속화하고 조건부 쓰기·lease 기반
  reconciler로 여러 Agent Studio 인스턴스의 중복 생성·삭제를 방지.
- 생성·시작·중지·재시작·삭제와 health/status 조회를 지원하고 실패 원인과 최근 상태
  변경 시각을 콘솔에 표시.
- managed endpoint는 provisioner가 반환한 workload identity로만 신뢰하고, 일반 remote
  MCP의 SSRF 검증을 우회하거나 임의 private URL 등록을 허용하지 않음.
- 최소 권한 IAM/RBAC와 network policy를 적용하고 application container에 host Docker
  socket을 직접 노출하지 않음.

**완료 조건**: 지원 환경별 adapter 계약 테스트와 하나 이상의 실제 runtime 통합
테스트에서 managed MCP를 생성해 `tools/list`와 `tools/call`을 수행하고 삭제할 수 있다.
두 Agent Studio 인스턴스가 동시에 reconcile해도 workload가 하나만 생성되며, 재시작
후 기존 workload를 재발견한다. 권한 부족·이미지 pull 실패·health check 실패·중복
요청·삭제 재시도를 검증하고 remote MCP 동작과 SSRF 보호가 그대로 유지된다.

## M4 — 프로젝트 API Reference 탭

**이유**: 프로젝트를 외부에서 호출하는 방법(엔드포인트, 인증, 요청·응답 형태)은 현재
`docs/API.md`에만 있고 콘솔에서는 확인할 수 없다. 이용자는 프로젝트 이름·published
version·인증 헤더를 직접 조합해야 하고, 프로젝트 유형(agent·image 등)에 따라 어떤
엔드포인트가 유효한지 알기 어렵다.

**범위**

- 프로젝트 상세에 `API Reference` 탭 추가(Playground/Versions/Usage/Traces/Settings와
  동일 레벨). 프로젝트는 공유 카탈로그이므로 로그인 사용자 누구나 열람.
- 해당 프로젝트에 유효한 실행 엔드포인트만 노출: predict, OpenAI 호환
  `chat/completions`, agent, chat, 그리고 활성화된 경우 A2A·Slack 연동 엔드포인트.
- 각 엔드포인트에 프로젝트 이름과 published version이 채워진 경로, 인증 방식(세션 쿠키 /
  `X-A2A-Key` / Slack 서명), 요청·응답 예시, 스트리밍(SSE) 프레이밍, 주요 오류
  코드(400/401/403/404/409)를 표시.
- 복사 가능한 curl 예시 제공. 실제 시크릿·키·토큰은 노출하지 않고 플레이스홀더로 표기.
- `docs/API.md`를 문서 SSOT로 유지하고 탭은 프로젝트 맥락(이름·유형·published 여부)에
  맞는 부분만 렌더링해 두 곳이 어긋나지 않도록 한다.

**완료 조건**: 로그인 사용자가 임의 프로젝트의 API Reference 탭에서 그 프로젝트에 유효한
엔드포인트 목록과 프로젝트 이름이 채워진 curl 예시를 확인할 수 있고, published version이
없거나 유형상 지원하지 않는 엔드포인트는 표시되지 않는다. 예시에 실제 시크릿이 노출되지
않음을 테스트로 검증한다.

## M5 — 프로젝트별 MCP 헤더 재정의

**이유**: MCP 서버의 헤더(`McpServer.headers`)는 공유 레지스트리에 한 벌만 저장되고,
프로젝트 version은 `mcpList`로 이름만 참조한다. 같은 MCP 서버를 프로젝트마다 다른
자격 증명·헤더로 호출할 수 없어, 프로젝트별 토큰이 필요하면 서버를 중복 등록해야 한다.

**범위**

- version의 MCP 바인딩을 이름 문자열 배열에서 구조화된 바인딩으로 확장(`subagentList:
  SubagentRef[]` 선례를 따름). 각 바인딩에 선택적 header override map을 둔다.
- override 시맨틱: (1) 레지스트리 기본 헤더 값 덮어쓰기, (2) 새 헤더 추가, (3) 특정 기본
  헤더 삭제. dispatch 시 레지스트리 헤더에 바인딩 override를 병합해 최종 outbound 헤더 산출.
- override 값도 레지스트리 헤더와 동일하게 AES-256-GCM 암호화 저장(`enc:v1:`)·조회 시
  masking·masked 또는 빈 값 업데이트 시 저장값 보존. 저장 카운터파트가 없는 masked 값은 드롭.
- override 편집은 version 생성·수정과 동일하게 owner 전용.
- URL은 레지스트리 값을 그대로 사용하고 바인딩은 헤더만 재정의하며, 병합 결과에도 기존
  SSRF·시크릿 처리 경로를 그대로 적용.

**완료 조건**: 한 MCP 서버를 두 프로젝트에서 서로 다른 헤더로 호출할 수 있고, 바인딩에서
기본 헤더 덮어쓰기·추가·삭제가 dispatch 헤더에 반영된다. override가 없으면 레지스트리
기본 헤더로 동작(회귀 없음)하고, override 값이 masking·암호화되어 저장되며, 병합·masking
보존·삭제·owner 권한을 테스트로 검증한다.

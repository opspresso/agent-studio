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

## M3 — 평가(테스트 세트 × 버전 비교)

**이유**: 프롬프트나 모델 설정 변경으로 회귀가 발생하지 않았는지 확인할 방법이 없다.

**범위**

- 프로젝트별 테스트 세트(케이스별 변수 바인딩)와 CSV 가져오기·내보내기.
- 선택한 버전을 테스트 세트 전체에서 나란히 실행하고 셀별·버전별 재실행 지원.
- 케이스 ID와 버전 설정 fingerprint로 출력을 캐시하고 설정 변경 시 오래된 결과 표시.
- Playground의 현재 입력을 테스트 케이스로 저장.

**완료 조건**: 저장된 테스트 세트에서 두 버전을 실행해 열 단위로 비교할 수 있고,
버전을 수정하면 캐시된 셀이 오래된 상태로 표시된다.

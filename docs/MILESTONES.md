# 마일스톤

Agent Studio는 프로젝트·버전 관리, LLM/에이전트 실행, Skills/MCP/외부 에이전트,
Slack/A2A 연동, 사용량 집계와 트레이스를 갖추고 있다. 이 문서는 구현 이력이 아니라
프로덕션 운영에 남은 필수 기능만 우선순위대로 관리한다.

## M1 — A2A 작업 저장소 영속화

**이유**: inbound A2A의 `message/send`, `tasks/get`, `tasks/cancel` 작업 상태가 현재
Next.js process 메모리에 저장된다. 요청이 서로 다른 인스턴스로 라우팅되거나 인스턴스가
재시작되면 작업을 조회·취소할 수 없으므로 수평 확장 전에 공유 저장소가 필요하다.

**범위**

- `InMemoryTaskStore`를 대체하는 DynamoDB 기반 A2A `TaskStore` adapter 구현.
- A2A task를 기존 single table의 전용 key namespace에 저장하고 만료 시각을 TTL로 관리.
- 상태 변경은 현재 상태나 revision을 확인하는 조건부 쓰기로 처리해 여러 인스턴스의
  완료·실패·취소 경쟁에서 완료 상태가 덮어써지지 않도록 보장.
- `message/send`, `message/stream`, `tasks/get`, `tasks/cancel`이 동일한 공유 저장소 사용.
- 저장소 port는 application/domain 경계에 두고 A2A route에서 DynamoDB 구현을 주입.

**완료 조건**: 서로 다른 두 서비스 인스턴스에서 작업 생성 후 조회·취소가 가능하고,
인스턴스 재시작 뒤에도 TTL 전까지 작업을 조회할 수 있다. 동시 완료·취소 요청에서
유효한 상태 전이 하나만 반영되고 terminal 상태가 역행하지 않으며, task 격리·미존재
조회·TTL·조건부 쓰기 충돌을 테스트로 검증한다.

## M2 — 비용 임계값 알림 및 차단

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

## M3 — 자동화 트리거

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

## M4 — Managed local MCP

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

## M5 — 평가(테스트 세트 × 버전 비교)

**이유**: 프롬프트나 모델 설정 변경으로 회귀가 발생하지 않았는지 확인할 방법이 없다.

**범위**

- 프로젝트별 테스트 세트(케이스별 변수 바인딩)와 CSV 가져오기·내보내기.
- 선택한 버전을 테스트 세트 전체에서 나란히 실행하고 셀별·버전별 재실행 지원.
- 케이스 ID와 버전 설정 fingerprint로 출력을 캐시하고 설정 변경 시 오래된 결과 표시.
- Playground의 현재 입력을 테스트 케이스로 저장.

**완료 조건**: 저장된 테스트 세트에서 두 버전을 실행해 열 단위로 비교할 수 있고,
버전을 수정하면 캐시된 셀이 오래된 상태로 표시된다.

## M6 — Skill 부속 파일 동기화

**이유**: 현재 GitHub skill sync는 각 디렉터리의 `SKILL.md`만 저장하며, `Skill`
tool의 `file_path` 파라미터도 실제 파일을 조회하지 않고 항상 본문을 반환한다. 이 때문에
skill이 참조하는 세부 가이드·스키마·템플릿을 progressive disclosure로 불러올 수 없고,
모델에 노출된 tool 계약과 실제 동작도 일치하지 않는다.

**범위**

- GitHub snapshot에서 `SKILL.md`가 있는 디렉터리를 skill root로 정하고, 그 아래의
  지원되는 text 부속 파일을 상대 경로와 함께 수집.
- `Skill` 본문과 부속 파일을 분리 저장하고, skill 삭제·재동기화 시 같은 source의
  오래된 부속 파일을 제거.
- `Skill` tool의 `file_path`를 실제 상대 경로로 해석해 요청한 파일만 반환하고,
  누락·미지원 형식·크기 초과를 구분한 오류 제공.
- 경로 정규화와 skill root 경계 검사를 적용해 절대 경로, `..`, symlink 우회와
  다른 skill 파일 접근을 차단.
- 허용 확장자, 파일별·skill별 크기, 파일 수와 tool result 크기에 상한을 두고
  GitHub tree·blob 처리와 저장소 사용량을 제한.
- sync 결과에 본문·부속 파일의 추가·변경·삭제·건너뜀 수와 건너뛴 이유를 표시.
- 기존 `SKILL.md` 단독 skill과 API 응답 형식은 하위 호환으로 유지.
- 실행할 수 없는 script와 binary asset의 동기화·실행·배포는 이 마일스톤에서 제외.

**완료 조건**: `references/*.md`와 text template이 포함된 skill을 GitHub에서
동기화한 뒤 `Skill(skill_name, file_path)`로 정확한 파일을 로드할 수 있고, 재동기화에서
변경·삭제된 파일이 저장소에 일관되게 반영된다. 동일 파일명·중첩 경로·없는 경로·경로
순회·symlink·미지원 형식·파일 수 및 크기 상한·truncated tree를 테스트하며, 기존
`file_path` 없는 호출은 이전과 동일한 `SKILL.md` 본문을 반환한다.

## M7 — 데이터 수명(TTL) 및 보존

**이유**: `traceRepository`와 `usageRepository`가 쓰는 trace·usage 행에는 만료
속성이 없어 무기한 누적된다. TTL은 dedup 행(`slackEventRepository`의 `expiresAt`,
24시간)에만 적용돼 있고 chat은 실행 lock(`activeRunExpiresAt`)만 만료된다. 단일
테이블이 계속 커지면 저장 비용과 조회 지연이 늘고, chat·trace가 PII를 담을 수 있는데도
데이터 최소화 정책이 없다.

**범위**

- trace(및 `TRACE_REF` 색인 행), usage, chat/message에 unix epoch(초) `expiresAt`
  속성을 부여하고 테이블 TTL로 자동 삭제 — `slackEventRepository`의 기존 패턴 재사용.
- 데이터 종류별 보존 기간을 설정 값으로 두고 안전한 기본값 적용.
- 색인·참조 행(`TRACE_REF` 등)이 본체와 같은 만료 시각을 갖도록 해 dangling 참조를 방지.
- 물리적 TTL 삭제가 지연되는 동안에도 이미 만료된 행은 조회에서 부재로 처리.
- 진행 중인 usage 일간 집계나 활성 chat run은 조기 만료하지 않도록 경계 설정.

**완료 조건**: 각 데이터 종류에 보존 기간에 맞는 `expiresAt`가 설정되고 본체와 색인 행이
동일한 시각에 만료되며, 이미 만료된 행은 물리 삭제 이전에도 조회에서 제외되고 보존 기간
내 데이터는 유지된다. 만료 경계값·색인 동반 만료·활성 run 보호를 (주입한 clock으로)
테스트로 검증한다.

## M8 — Readiness probe와 종료 드레인

**이유**: `/api/health`는 정적 200을 반환하는 liveness probe로, 스스로 밝히듯
"다운스트림이 건강한가"가 아니라 "프로세스가 요청을 받는가"만 답한다
(`src/app/api/health/route.ts`). Dockerfile HEALTHCHECK와 LB가 이 엔드포인트를 가리키므로
DynamoDB나 LLM 채널이 도달 불가인 인스턴스도 healthy로 보고돼 트래픽을 계속 받는다.

**범위**

- liveness와 분리된 readiness 엔드포인트 추가 — DynamoDB 도달성과 LLM 채널 도달성을
  짧은 타임아웃으로 점검하고 실패 시 비정상 상태 코드 반환.
- 점검은 가볍고 비용이 낮아야 하며(저비용 DynamoDB 조회, LLM 채널은 실제 완성 호출 없이
  도달성만), 다운스트림 오류 세부를 그대로 노출하지 않음.
- LB/오케스트레이터 health check는 readiness로, 프로세스 재시작 판단(liveness)은 기존
  정적 probe로 분리.
- SIGTERM 수신 시 readiness를 먼저 unready로 전환해 신규 트래픽을 끊고 in-flight
  실행·SSE를 드레인하는 경계를 명시(현재는 Next standalone 기본 종료에만 의존).

**완료 조건**: 다운스트림(DynamoDB 또는 LLM 채널)이 도달 불가일 때 readiness가 비정상을,
정상일 때 200을 반환하고, liveness는 다운스트림과 무관하게 200을 유지한다. 도달성
성공·실패·타임아웃과 SIGTERM 후 unready 전환을 테스트로 검증한다.

## M9 — Fail-open 기본값 가드레일

**이유**: `isAdmin`은 admin 목록이 비면 로그인한 전원을 admin으로 취급하고
(`src/lib/session.ts`), 로그인 허용 도메인도 비면 아무 구글 계정이나 로그인된다
(`src/lib/auth.ts`). 두 값 모두 `BOOT_REQUIRED_ENV`에 없어(`src/lib/config.ts`)
강제되지 않으므로, 무설정으로 배포하면 인터넷의 임의 구글 계정이 admin이 될 수 있다.

**범위**

- `alpha`·`prod` STAGE에서 `ADMIN_EMAILS` 또는 `ALLOWED_EMAIL_DOMAINS`가 비어 있으면
  부팅 거부(`assertRequiredConfig`와 같은 boot 시점 검증).
- `local` STAGE는 무설정 개발 편의를 위해 기존 fail-open 유지.
- 거부 메시지에 어떤 변수가 비었는지와 현재 STAGE를 표시.
- fail-open의 의미를 config 주석에 STAGE 조건과 함께 갱신.

**완료 조건**: `alpha`·`prod` STAGE에서 admin 또는 allowed-domain 목록이 비면 부팅이
실패하고 두 값이 설정되면 정상 부팅하며, `local` STAGE는 비어 있어도 부팅한다. STAGE별
부팅 허용·거부와 누락 변수 보고를 테스트로 검증한다.

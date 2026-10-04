# 운영

배포하고, 프로브하고, 스케일링하고, 데이터베이스를 유한하게 유지하는 일.

관련 문서: localdev와 배포 저장소의 소유권, 폐쇄망 대체 경로는
[INSTALL.md](INSTALL.md) 다. 여기 이름이 나오는 모든 변수는
[CONFIGURATION.md](CONFIGURATION.md), 자격 증명 취급은 [SECURITY.md](SECURITY.md), 로컬
루프는 [DEVELOPMENT.md](DEVELOPMENT.md).

## 빌드 아티팩트

배포 대상은 컨테이너 이미지다. 빌드는 멀티스테이지이며 Next.js **standalone** 출력을 싣는다.
의존성과 문서·오디오·Workspace 워커 번들, PDF용 한글 폰트가 아티팩트 안으로 추적돼 들어가므로 런타임
스테이지에는 `node_modules` 설치나 폰트 다운로드가 없다. 문서 작업은 앱이 띄우는 자식
프로세스에서 실행하며 별도 MCP 서비스는 필요 없다. 실행 한계는 [문서 엔진](design/documents.md#실행-자원)을 보라.

```bash
docker build -t agent-studio .
docker compose up --build          # 로컬 앱 + PostgreSQL 18 + MinIO
```

런타임 스테이지는 비-root `app` 사용자로 실행되고 `/api/health` 에 대한 `HEALTHCHECK` 를
선언한다. 이미지 **빌드**에는 npm 레지스트리와 Google Fonts(`next/font/google`)가 닿아야
한다. 폐쇄망은 밖에서 빌드한 이미지를 들여온다 ([INSTALL.md](INSTALL.md#폐쇄망)).

**node 가 PID 1 로 실행된다** (exec 형식 `CMD`). 그래서 `SIGTERM` 이 셸에 삼켜지지 않고
곧바로 node 에 도달한다. 롤링 배포 중에 진행 중인 SSE 스트림이 빠져나갈 수 있는 이유가 그것이다.

AWS 자격 증명은 AWS 를 쓰는 기능(Bedrock, AWS S3 자체)에서만 필요하고, 역할이나 표준
`AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY` 쌍으로 온다. 오브젝트 스토어의 키는 그것과 별개인
`S3_ACCESS_KEY_ID`/`S3_SECRET_ACCESS_KEY` 다(compose 는 번들 MinIO 의 root 키로 채운다). 키를 이미지에 구워 넣지 마라.

## 오디오 작업 운영

오디오 worker는 HTTP 앱과 별도 process다. 같은 이미지에서 `node build/audio-worker.cjs`를 실행하고
DB·기존 `S3_BUCKET_NAME`의 비공개 Artifacts 저장소·암호화 키·전사 채널을 공유한다. [설치 조건](INSTALL.md#오디오-worker)과
[환경변수·고정 한계](CONFIGURATION.md#오디오-전사-설정)를 따른다. worker만 켜면 접수된 작업을 처리하며,
신규 녹음의 정기 탐색에는 Agent schedule과 [ticker](#schedule-티커)가 별도로 필요하다.

기본 운영 구성은 Agent 하나와 plugin skill이다. 후처리 대상 Agent의 현재 설정은 작업 접수 시
복사해 고정한다. 이후 설정 저장은 이미 접수된 작업을 바꾸지 않는다. 자동 수집의
외부 저장 대상은 비워두고, 개인 Memory·Document 기록은 요청한 Artifact에 대해서만 수행한다.

작업의 status와 stage를 구분한다. completed의 stage가 cleaning이어도 완료 상태다. waiting은
자동 재개하며 failed/blocked는 원인을 해결한 후 수동 retry한다. 수동 retry는 실행 구간만 새로
시작하고 성공한 단계·외부 receipt·파일 만료는 유지한다. 원본이 없어졌거나 연결이 바뀐 경우에는
그 원인을 복구해야 한다. 다른 모델·원본으로 새 처리가 필요하면 명시적 processingRevision을 사용한다.

원본과 최종 Artifact는 파일별 만료까지 보존하고 checkpoint만 완료 시 정리한다. 같은 버킷의 source-files 경로에 있는
삭제 표식은 유지한다. 일반 Artifact 객체의 일괄 만료 규칙을 이 경로에 적용하지 않는다. 작업 이력과
중복 방지 기록은 파일 만료와 별개이므로 파일을 지워도 다음 schedule이 같은 녹음을 다시 처리하지 않는다.

전체 초기화가 필요한 개발·운영 유지보수에서는 다음 범위만 정리한다. 전용 reset API나 화면 버튼은 없다.

1. 해당 Agent의 schedule과 신규 작업·재시도를 비활성화한다. 이미 시작된 실행과 worker 작업이
   끝나거나 취소되어 lease·활성 slot이 비어 있는지 확인한다.
2. `keys.ts`의 해당 Agent AUDIOJOB·AUDIOSOURCE·AUDIOOCCURRENCE·AUDIOSLOTS 행을 함께 정리한다.
   일부만 지워 중복 claim이 삭제된 job을 가리키게 하지 않는다. 다른 Agent의 행은 건드리지 않는다.
3. Artifact 삭제 여부는 별도로 결정한다. source-file 삭제 inventory·0바이트 표식은 유지해 지연된
   업로드가 지운 파일을 복원하지 못하게 한다. Agent·skill·인증·오디오 설정은 유지할 수 있다.
4. 빈 작업 목록과 중복 claim 정리를 확인하고 설정·schedule을 다시 켠다. 다음 실행은 설정된 수집
   시작 범위에서 한도 내의 녹음을 새로 처리한다. 이 작업은 외부 Memory·Document를 삭제하지 않는다.

## Workspace와 승인 후속 실행 운영

HTTP 앱과 Workspace worker는 같은 DB·암호화 키·Workspace 설정과 Sandbox 백엔드를 사용한다.
Docker는 같은 daemon, Kubernetes는 같은 실행 namespace·설치 identity와 namespaced RBAC가 필요하다.
worker는 native 작업 큐와 Chat 후속 실행 큐를 별도로 처리하며 각 큐의 동시성 설정을 적용한다.
`node build/workspace-health.cjs --worker`로 백엔드·채널과 heartbeat를 확인한다.
Kubernetes readiness는 Pod list 접근을 확인하고 liveness는 외부 API 장애로 재시작하지 않도록 heartbeat만 검사한다.
`node build/workspace-heartbeat-check.cjs`가 liveness를 담당하며 DB·백엔드·모델 코드를 로드하지 않는다.
프로세스가 살아 있다는 사실만으로 특정 작업의 성공을 판단하지 않고 Run·승인·전달 상태를 확인한다.

승인 결과의 알림은 DB에 남으므로 브라우저를 닫아도 대기한다. pending은 아직 소비하지 않은 알림,
waiting-ci는 등록된 PR HEAD의 검사 대기, running은 claim한 Chat 실행이다. claim 이후 중단되면
결과를 확인하기 전 자동 재실행하지 않는다. worker가 없으면 작업·TTL·승인 전달·CI 대기가 진행되지 않는다.
잘못된 저장소 이름·빈 저장소·접근 거절을 새 Workspace 생성으로 우회하지 않는다.

Sandbox 이미지는 Docker 모드에서 전용 Docker daemon에도 저장된다. rootless daemon을 쓰면 앱 daemon의 이미지
정리만으로 그 디스크가 비워지지 않는다. 해당 daemon의 image/container 목록과 여유 공간을 확인하고
사용 중인 이미지와 복구용 버전은 보존한다. 다시 받을 수 있는 미사용 이미지·빌드 캐시만 정리하며,
Workspace 체크포인트·DB·오브젝트 volume을 이미지 캐시와 함께 삭제하지 않는다.

## 릴리스 파이프라인

[`.github/workflows/release.yml`](../.github/workflows/release.yml)은 `v*` tag push에서 실행하며
모든 job은 GitHub-hosted `ubuntu-24.04`를 사용한다. 수동 dispatch는 없다.

| Job | 선행·동작 |
|---|---|
| `verify` | 타입·단위·전용 PostgreSQL 통합 검사 |
| `github-release` | verify 이후 커밋 메시지로 GitHub Release 노트를 생성·갱신한다 |
| `release` | verify 이후 Dockerfile로 빌드하고 ECR·GHCR에 앱 `{tag}`·`latest`, Sandbox `workspace-{tag}`를 게시한다 |
| `alpha` | 이미지 게시 이후 `v*` tag에서 `phase: alpha` 배포 이벤트를 자동 전달한다 |
| `prod` | alpha 전달 성공 후 `prod` Environment의 사용자 승인을 기다리고 같은 tag를 `phase: prod`로 전달한다 |


`prod` Environment의 승인자와 자기 배포 승인 허용 여부는 Repository Settings → Environments →
`prod`에서 확인한다. 권한이 있는 승인자가 Actions run의
**Review deployments → prod → Approve and deploy**를 선택해야 `prod`가 실행된다.
승인을 거절하면 prod dispatch는 실행되지 않는다. 승인 대기 중에도 alpha 배포는 완료된다.

prod dispatch는 기존 `argocd-env-demo`의 prod PR 절차를 사용한다. PR 반영과 Argo CD Sync는
별도 단계이며, 이 job은 이미지 재빌드나 클러스터 Sync를 실행하지 않는다.

`github-release`와 `release`는 서로 기다리지 않는다.
PR은 별도의 [pr.yml](../.github/workflows/pr.yml)에서 검증만 수행하며 게시 작업은 실행하지 않는다.

ECR은 workflow의 OIDC role, GHCR은 `GITHUB_TOKEN`, GitOps 전달은 `GHP_TOKEN`을 사용한다.
체크인된 [AWS trust policy](../.github/aws-role/trust-policy.json)는 `v*` tag subject와
audience를 요구한다. 정책 파일은 실제 AWS에 적용됐다는 증거가 아니므로 배포 관리자가 확인한다.
release tag 작성 권한과 registry 게시 권한도 배포의 GitHub·AWS 설정에서 제한한다.

### 실패한 릴리스를 다시 돌리기

같은 커밋의 실패한 작업은 원래 Actions run에서 재실행한다. `gh run view <run-id>`로 실패 지점을
확인하고 `gh run rerun <run-id> --failed`를 사용한다. 성공한 Release 생성·이미지 push까지 무조건
반복하지 않는다. 특정 job은 `gh run view <run-id> --json jobs`의 `databaseId`로 지정한다.
기존 tag나 GitHub Release를 삭제하는 것은 재실행의 전제가 아니다.

코드·의존성·빌드 설정을 고쳐야 하면 수정 커밋과 다음 patch tag로 릴리스한다. 공개된 tag를 다른
커밋으로 옮기지 않는다. 릴리스 게시, 앱 이미지, Sandbox 이미지, GitOps 전달과 실제 rollout 상태를
각각 확인한다. GitHub Release가 존재한다는 사실만으로 이미지 빌드·배포까지 완료됐다고 판단하지 않는다.

Actions 자체가 막혀 있으면(결제 한도, 러너 다운) 릴리스는 로컬에서 같은 순서로 할 수 있다:
검증 → 태그 → `linux/amd64` 빌드 → ECR·GHCR push → GitOps tag 전달.

앱과 Sandbox는 현재 `linux/amd64`로 빌드한다. 다른 CPU 아키텍처는 이 릴리스 산출물의
지원 범위에 포함하지 않는다. workflow는 `provenance: false`, `sbom: false`를 지정한다.
registry 정리 정책은 tag뿐 아니라 이미지가 참조하는 manifest와 layer도 보존해야 한다.

## 헬스 프로브

| 엔드포인트 | 종류 | 동작 |
|---|---|---|
| `GET /api/health` | liveness | 정적 `200`. 의존성이 없고 인증도 없다. "프로세스가 서빙 중인가" 에 답한다. |
| `GET /api/ready` | readiness | PostgreSQL(`SELECT 1 FROM items LIMIT 1`)의 연결·자격 증명·스키마를 검사한다. 전용 connection 하나에서 연결 대기·클라이언트 응답·서버 실행을 각각 2초로 제한하고 시간 초과 connection을 폐기한다. DB 검사 실패 또는 draining 중이면 `503`이며 오류 상세는 노출하지 않는다. |

재시작 검사는 `/api/health`에, 로드 밸런서는 `/api/ready`에 연결한다.
모델 프로바이더는 readiness에서 호출하지 않는다. 외부 모델 장애나 공개 인터넷 단절로
설정 변경·로그인·콘솔까지 사용할 수 없게 되는 것을 막기 위해서다.
모델 자격 증명과 추론은 실제 Agent 실행으로 검증한다.

### Draining

`SIGTERM`/`SIGINT` 를 받으면 인스턴스는 draining 으로 전환된다 (`src/shared/lifecycle.ts`):
`/api/ready` 가 즉시 `503` 을 답해 로드 밸런서가 새 트래픽을 보내지 않게 하고, 그동안
standalone 서버는 진행 중인 요청을 끝낸다. 이 모듈은 결코 `process.exit` 를 호출하지 않는다.
그것은 런타임의 몫이다.

여기에 컨테이너 `stopTimeout` 을 적어도 `MAX_RUN_DURATION_MS` 만큼(기본 10분이므로 660s 면
데드라인과 그 뒤의 drain 까지 덮는다) 맞춰 짝지어라. 배포 체크리스트가 요구하는 것이 그것이다.
유예 시간이 그보다 짧으면 끝났을 스트림이 잘린다.

## 메트릭

`GET /api/metrics` 는 Prometheus 스크레이프 엔드포인트다. 파드 주소로 클러스터 안에서
스크레이프되므로 `/api/health` 처럼 인증이 없고 의존성도 없다.

| 메트릭 | 타입 | 용도 |
|---|---|---|
| `agent_studio_build_info` | gauge | 배포된 package version·stage. |
| `agent_studio_active_runs` | gauge | **오토스케일링 신호.** |
| `agent_studio_active_workspace_model_requests` | gauge | 이 웹 프로세스가 처리하는 native Workspace 모델 요청. 응답 본문 종료·취소·실패까지 집계한다. |
| `agent_studio_active_execution_requests` | gauge | 일반 Agent 실행과 native Workspace 모델 요청의 합. **웹 오토스케일링 신호.** |
| `agent_studio_oldest_active_run_seconds` | gauge | 멈추거나 deadline에 접근한 런 감지. |
| `agent_studio_runs_started_total` | counter | 처리량. |
| `agent_studio_runs_finished_total` | counter | 처리량. |
| `agent_studio_runs_failed_total` | counter | **알림 신호.** 취소는 실패가 아니다. |
| `agent_studio_run_duration_seconds` | histogram | **알림 신호.** 버킷 `0.5 … 600`. |
| `agent_studio_unknown_model_calls_total` | counter | 정확성 신호. 아래 참고. |
| `agent_studio_unknown_models` | gauge | 관측된 미등록 model id 의 가짓수. |
| `agent_studio_draining` | gauge | 셧다운이 시작되면 `1`. |
| `process_resident_memory_bytes` | gauge | Node.js process RSS. |
| `process_cpu_seconds_total` | counter | Node.js process 누적 user+system CPU. |
| `nodejs_heap_size_{total,used}_bytes` | gauge | V8 heap 할당·사용량. |
| `nodejs_external_memory_bytes` | gauge | Buffer 등 V8 heap 밖의 메모리. |
| `nodejs_eventloop_delay_{p95,max}_seconds` | gauge | 메트릭 수집 시작 이후 event loop 지연. |

웹 replica는 `agent_studio_active_execution_requests`로 장시간 I/O 부하를 확장한다. 런으로
포화된 인스턴스도 CPU는 유휴로 읽힐 수 있다. `agent_studio_active_runs`만 사용하면 별도 worker가
실행하는 Workspace의 native 모델 요청을 놓친다. 웹 컨테이너의 CPU 지표도 함께 적용하면
요청 파싱·파일 처리·콘솔 트래픽 증가를 감지할 수 있다. 여러 HPA 지표는 필요한 replica 수 중
최댓값을 선택한다.

`agent_studio_oldest_active_run_seconds` 는 동시 런을 시작 handle 별로 추적한다. 새 런이 먼저
끝나도 더 오래된 런의 나이를 잃지 않으며, active run이 없으면 `0`이다. 기본 설정에서 600초를
넘으면 run deadline과 어긋난 실행이므로 원인을 조사하라. `MAX_RUN_DURATION_MS`를 바꿨다면 그
설정값을 기준으로 판단한다.

Chat은 화면 이동·탭 닫기 후에도 실행되므로 active-run gauge에 계속 포함된다
([Chat 연결 수명](design/chat.md#런은-자기-연결보다-오래-산다)). 실행 중인 Chat은 비용을 기록하고
사용자별 동시성 슬롯을 유지한다. 명시적 Stop, 실행 데드라인과 권한 검사는 계속 적용된다.

실패율과 지속 시간에 알림을 설정한다. 명시적 취소는 실패로 세지 않으며 데드라인 초과는 실패다.
`/predict`·`/agent`·`/chat/completions`는 연결 종료를 실행 취소로 전달한다.
Slack 이벤트는 접수 후 백그라운드에서 실행하며 HTTP 연결 종료로 취소하지 않는다.
Slack 중단 명령과 버튼은 별도의 실행 중단 신호를 전달한다.
히스토그램의 유한한 최상단 버킷은 고정된 `600`초다. `MAX_RUN_DURATION_MS`를 바꾸면
`+Inf` 버킷과 duration 합계를 실제 설정값에 맞춰 해석한다.

**`agent_studio_unknown_model_calls_total` 의 rate 가 0 이 아니면 알림을 걸어라.**
등록 모델의 가격을 알 수 없으면 가격 계산은 $0이며 이 경로가 경고·카운터를 남긴다.
provider 보고 비용을 사용하는 텍스트 호출은 이 계산을 거치지 않을 수 있으므로 카운터를
전체 호출 수로 해석하지 않는다. `UNKNOWN_MODEL_POLICY=refuse` (env 또는 런타임
설정)는 런 브래킷의 모델 정책 검사에서 가격 미지정 모델의 새 실행을 `400`으로 거부한다.

카운터는 프로세스 단위이며 **agent 도 user 도 model 도 이름 붙이지 않는다**. 라벨은
히스토그램의 `le`와 build 정보의 유한한 `version`·`stage`뿐이다. 값의 범위가 무한한 라벨은
메트릭 하나를 값마다 하나씩의 시계열로 바꿔 놓는데, unknown model id 를 라벨로 달지 않고
카운트하는 이유도 그것이다.

## 로깅

`src/shared/logger.ts`가 로그 형식과 실행 문맥을 소유한다. 공통 run bracket은 Trace 저장과
독립적인 correlation ID를 만들며 Trace가 있으면 함께 기록한다.

```text
[mcp run=… trace=…] skipping server 'shared-mcp': …
```

Webhook·메신저 접수 작업은 delivery/event ID도 문맥으로 사용한다.
Trigger 실패 로그는 Agent·trigger·run ID와 리뷰 대상 커밋을 기록하며 상세 오류는 Trigger 이력에서
확인한다. PR 리뷰 필수 설정 누락은 claim 전에 warning과 skipped 이력을 남기고 HTTP 409로 반환한다.
`apiError`는 알 수 없는 예외를 error, 설명 가능한 5xx를 warn으로 기록하고 4xx는 일반적으로
기록하지 않는다. scan token 거절처럼 별도 운영 신호가 필요한 경계는 자체 경고를 남긴다.
비스트리밍 호출자가 응답 전에 떠난 것은 info이며 upstream 실패로 분류하지 않는다.

원문 프롬프트와 credential을 로그에 넣지 않는다. 라이브러리·provider 오류 문자열에도
민감 정보가 포함될 수 있으므로 로그 접근과 보존을 제한한다.
domain의 제한된 경고와 브라우저 오류 경계 등 예외는 구조 테스트가 관리한다.

## 트레이싱

Agent 런은 **항상** 트레이싱되며 이미지 도구도 같은 실행 Trace에 포함된다.

트레이스는 Agent 소유자(`assertAgentOwner` 기준)에게 보인다. SDK span은 이름·종류·상태·시간,
native ID와 부모 ID, 모델 토큰·비용을 저장한다. `prepare`에는 skill·Agent·MCP·도구의 수와
발견한 capability 이름 최대 20개를 기록한다. 원본 프롬프트와 도구 결과는 span에 저장하지 않는다.
다만 Trace의 `error`와 `warnings`는 원문 오류를 최대 1,000자로 보관하므로 민감 정보가 포함될
수 있다. Trace에는 실행을 일으킨 `actor`와 대화의 `conversation`도 기록한다.

`OTEL_EXPORTER_OTLP_ENDPOINT`를 설정하면 저장된 Trace를 OTLP로 내보낸다.
[설정](CONFIGURATION.md#관측성과-보존-기간)에 따라 endpoint와 headers를 주입한다. exporter는
앱 런을 root로 만들고 저장된 `parentSpanId` 관계를 따라 span 계층을 내보낸다. 자식이 먼저
완료되어 저장됐어도 부모부터 생성하며, 생략된 부모는 root에 연결한다. 타임스탬프·이름·상태와
`app.span_id`·`app.parent_span_id`·`app.span.kind`·`app.span.author`, root의
`app.trace_id`·Agent·호출자·대화 속성을 전송한다. OTLP 자체 ID는 새로 생성하며
원래 SDK ID는 위 속성으로 대응한다. 세부 사용량과 원문을 제외한 native 메타데이터는 DB Trace에서 조회한다.

기록의 정본은 DB 행이다. collector 장애는 `[otel]` 로그로 보고하고 실행을 실패시키지 않는다.
export 배치는 draining 시 flush한다.

SDK의 기본 공개 exporter는 사용하지 않는다. `runtime/tracing.ts`가 로컬 native span을 수집하고,
승인 대기 실행은 `awaiting-approval`로 저장한다. SDK 모델·도구의 원문 데이터는 수집하지 않는다.

### 승인 대기 실행

Chat 소유자가 도구별 인자를 확인하고 승인·거절한다. 재개는 정확한 revision을 원자적으로
선점하며, 중복 재개와 변경된 Agent 설정·연결·바인딩을 거부한다. 승인 후 인스턴스가 종료되어 체크포인트가
`running`으로 남으면 자동 재실행하지 않는다. 도구 효과를 확인한 뒤 실행 잠금이 만료되었거나
해제된 상태에서 폐기한다. 폐기는 화면 기록을 남기고 미완료 실행을 모델 문맥에서 제외한다.

## 행 보존

보존 기간과 기본값의 정본은 [CONFIGURATION](CONFIGURATION.md#관측성과-보존-기간),
행 만료 계산은 `src/infrastructure/db/ttl.ts`다. 만료는 다음과 같이 서로 다른 경로가 수행한다.

| 데이터 | 삭제를 수행하는 경로 | 운영 조건 |
|---|---|---|
| `items.expires_at` | schedule scan의 `sweepExpiredRows`, 최대 5,000행/틱 | `SCHEDULE_SCAN_TOKEN`과 반복 POST가 필요하다 |
| Better Auth `session` | 같은 sweep, 최대 5,000행/틱 | 만료 세션 정리이며 user·account 삭제가 아니다 |
| SDK `runtime_sessions` | 같은 sweep, 최대 1,000행/틱 | Chat 보존 기간; 삭제 tombstone은 run-log 보존 기간 |
| 일반 Artifact bytes | 객체 저장소의 prefix별 lifecycle | DB 만료 삭제는 객체 삭제를 호출하지 않는다 |
| 비공개 오디오 `source-files/` | audio worker의 파일별 만료·삭제 처리 | 0바이트 삭제 표식을 보존하고 일괄 객체 만료를 적용하지 않는다 |
| Workspace Sandbox | Workspace worker의 정리·체크포인트 | worker가 멈추면 compute 정리도 멈춘다 |
| 종료·중지 Workspace 상태와 자식 기록 | DB 만료 sweep | `WORKSPACE_RETENTION_DAYS`; 실행 중 META는 먼저 compute 정리가 필요하다 |

schedule scan이 없으면 위 DB sweep이 실행되지 않는다. 읽기는 만료를 별도로 검사하지만
저장 공간은 줄지 않는다. 삭제량이 틱 상한을 넘으면 여러 틱이 필요하므로 실제 purge 지연은
호출 주기와 backlog에 달려 있다. sweep 실패는 로그에 남고 다음 호출에서 다시 처리한다.
Session 정리는 삭제 잠금 대기 후에도 만료 시각을 확인해 그동안 갱신된 행을 보존한다.

고정 수명의 보조 상태에는 webhook 중복 claim, 메신저 delivery·참여·transcript,
MCP OAuth state와 동시성 슬롯이 있다. 수명은 기능 계약의 일부이며
[고정 제한](CONFIGURATION.md#코드에-고정된-제한)과 해당 설계 문서에서 확인한다.
Chat replay log는 장기 이력이 아니라 실행 lease보다 오래 남는 재접속 버퍼다.

일반 객체에는 다음 lifecycle을 구성한다. 갤러리의 명시적 삭제와 TTL 정리는 별개다.

| Prefix | 보존 기준 | 내용 |
|---|---|---|
| `artifacts/image/` | `ARTIFACT_RETENTION_DAYS` | 생성·첨부 이미지 |
| `artifacts/document/` | `ARTIFACT_RETENTION_DAYS` | 첨부 원본과 생성·편집 파일 |
| `images/` | `CHAT_RETENTION_DAYS` | 아직 읽을 수 있는 이전 이미지 저장 경로 |

행보다 객체가 오래 남으면 참조 없는 bytes가 쌓이고, 먼저 사라지면 목록의 파일을 읽을 수 없다.
비공개 오디오 파일은 같은 버킷에 있어도 `source-files/` 전용 보존 계약을 적용한다.
만료 파일을 재다운로드하거나 완료 job·중복 claim을 자동 초기화하지 않는다.

## 백업과 복원

PostgreSQL, 객체 bytes, `AES_ENCRYPTION_KEY`와 인증 secret을 같은 배포의 복구 단위로 관리한다.
DB만 복원하면 파일 참조가 끊길 수 있고 암호화 키를 잃으면 credential·SDK Session·checkpoint를
읽을 수 없다. 실제 backup 도구·주기·보관 장소·접근 권한은 배포 저장소가 소유한다.

복원은 격리된 환경에서 검증한다. worker와 ticker를 먼저 켜지 말고 DB 스키마·키 복호화·
대표 파일·로그인·Agent 실행을 확인한 뒤 외부 연결을 재개한다. 복원한 승인·job이
이미 수행된 외부효과를 반복하지 않는지 확인한다. `catalog_vectors`는 재색인할 수 있지만
Agent·Session·Usage·Audit와 원본 파일은 파생 캐시가 아니다.

## 지출 가드와 부하 가드

둘 다 런 브래킷(`src/application/run/runBracket.ts`)에 매달려 있고 **의도적으로 서로 반대
방향으로 실패한다**. 그 사이에 세 번째 가드가 있다: **member tier 의 월간 상한**
(Settings → Access에서 설정하며 초기값은 `member` $20, `guest` 조회 전용, admin 무제한)은 모든 출처의
Studio 사용자 ID에 대해 Agent 비용 가드 다음, 슬롯 이전에 검사된다. 그래서 예산을 넘긴 사람은 어차피
거부될 런의 슬롯을 기다리는 대신 그 사실을 바로 듣게 된다. 이 가드도 나머지 둘처럼 `429` 를
답한다. 개인 등급·사용량 조회 실패는 새 실행을 차단한다. tier 모델과 함께
[SECURITY.md](SECURITY.md#인가-모델) 에 문서화돼 있다.

### 비용 가드: fail-open

**Agent Settings → Cost limits** 아래에서 설정하는, 두 개의 UTC 윈도우에 걸친 Agent별
임계값:

- `alertThresholdUsd` / `monthlyAlertThresholdUsd`. 알림을 한 번 올리고 계속 실행한다.
- `blockThresholdUsd` / `monthlyBlockThresholdUsd`. 그 윈도우가 끝날 때까지 모든 런을
  거부한다. 모든 실행 진입점이 `429` 를 답하며 `Retry-After` 에는 윈도우가 넘어갈 때까지의
  초가 담긴다. 일간이면 00:00 UTC, 월간이면 다음 달 1일. 그 시점이 바로 그 거부가 더 이상
  참이 아니게 되는 때다. 한 달의 지출은 그달의 일별 행을 더한 값이다: 유한한 질의 하나,
  어긋날 별도의 집계값 없음. `USAGE_RETENTION_DAYS` 의 하한이 한 달 전체인 이유가 그것이다
  ([CONFIGURATION.md](CONFIGURATION.md#관측성과-보존-기간) 참고); 달 중간에 행이
  만료되면 그 윈도우를 조용히 과소 계산하게 된다.

알림은 `alertDestinations` 에 선택한 Agent 자신의 Slack·Telegram·Teams 연동으로 가며,
윈도우당 임계값당 한 번씩 간다 (조건부 쓰기다, 일간은 그날의 usage 행에, 월간은
`MONTHCLAIM#{yyyy-MM}` 행에. 그래서 두 인스턴스가 동시에 넘어서도 게시는 한 번이다).
목적지는 플랫폼마다 하나씩 선택하며 각 전송은 독립적으로 시도한다. **목적지나 연동이 설정돼
있지 않아도 임계값은 여전히 차단한다**. 알림 경로가 없다고 해서 가드가 꺼져서는 안 된다.

**무엇을 묶고, 무엇을 묶지 않는가.** agent 런은 usage 를 버퍼에 모았다가 끝에 한 번 flush
하므로, 런을 admit 하는 검사는 이미 실행 중인 런들이 얼마를 썼는지 볼 수 없다: 함께 시작한
런들은 모두 통과하고, 차단은 그 flush 다음에 오는 검사에서 참이 된다. 이것은 폭주하는 루프나
무거운 caller 에 대한 윈도우 단위 백스톱이지. 단단한 상한도, rate limit 도 아니다. 그 안의
모든 읽기·쓰기 실패는 fail-open 이고, 각 윈도우는 저마다 독립적으로 fail-open 한다: 월간 질의가
스로틀되면 월간 검사만 건너뛰고 일간 검사는 결코 건너뛰지 않는다. 이 가드가 스토리지의 일시적
문제로 플랫폼을 멈추는 두 번째 경로가 되어서는 안 된다.

### 동시성 가드: fail-closed

caller 당 Settings → Service의 동시 실행 한도(`MAX_CONCURRENT_RUNS_PER_ACTOR` 폴백, 기본 10)를 적용한다. `0` 은 그 한도를 끈다. 한도를 넘으면 런은
`429` 와 짧은 `Retry-After` 로 거부되는데, **시작되기 전에** 거부되므로 usage 도 트레이스도
남기지 않는다. 상한의 최대값은 저장 slot index가 표현하는 1000이다.

운영상 중요한 성질이 둘이다. 슬롯은 프로세스 메모리가 아니라 **데이터베이스의 리스된 행**이므로
한도가 정확하고 인스턴스 수만큼 **곱해지지 않으며**, 런 도중에 죽은 인스턴스는 그 점유를
영원히 흘리는 대신 리스가 만료될 때 놓는다. 그리고 이 가드는 **fail-closed** 다. 스토어에
닿을 수 없을 때 열어 주는 것은 스토어가 감당할 수 없는 바로 그 순간에 부하를 더하는 일이다.
설계는 [ARCHITECTURE.md](ARCHITECTURE.md#런-브래킷) 에 있다.

이 한 쌍은 한 세트에서 빠르게 반응하는 절반이다. 런 단위의 경계(`MAX_RUN_DURATION_MS`, 턴 가드,
도구 결과 상한)는 런 하나를, chat 런 리스는 chat 하나를 묶지만, 어느 쪽도 같은 사람이 chat 을
스무 개 열거나 `/predict` 를 루프로 부르는 것을 막지는 못한다. 그리고 일간 비용 가드는 돈이
이미 쓰인 뒤에야 반응한다.

## Schedule 티커

`X-Scan-Token: $SCHEDULE_SCAN_TOKEN`으로 `POST /api/triggers/scan`을 1분 이하 간격으로
호출한다. localdev는 `deploy/local/scripts/tick.sh`, 배포 환경은 `../dockpad`와
`../argocd-env-demo`가 ticker를 소유한다. 이 호출이 [DB 만료 sweep](#행-보존)도 예약한다.
Kubernetes 배포는 하나의 지속 실행 ticker Pod에서 주기적으로 호출한다. 매분 새 Job Pod를 만들지
않으며 HTTP 실패는 endpoint별로 기록하고 다음 정기 tick에서 다시 호출한다. 유지보수 중에는 ticker도 중지한다.

- 최근 10분의 발생만 catch-up한다. 그보다 오래된 발생은 자동 실행하지 않는다.
- 조건부 claim이 겹친 tick의 같은 발생을 중복 접수하지 않게 한다. 생성·편집 이전 발생과
  겹침 금지 상태의 오래된 catch-up은 [트리거 설계](design/triggers.md#schedule)를 따른다.
- 한 tick의 admission과 실행은 각각 최대 8건을 동시에 처리한다. 여러 tick·전체 배포의
  전역 동시 실행 상한은 아니며, 전체 접수 수를 8건으로 제한하지 않는다.
- 응답·로그의 `fired`는 queued 접수 수다. 실행 시작·성공은 trigger 이력에서 확인한다.
  `repaired`는 만료된 queued lease 또는 마지막 소유 lease와 여유 시간이 지난 running 이력을
  failed로 마감한 수다. `invalid`는 cron·시간대 오류, `errors`는 복구·admission 처리 오류 수다.
  저장소 페이지 조회 실패는 요청을 실패시킨다.
- scan token 미설정은 `503`, 잘못된 token은 `401`과 서버 경고로 확인한다.

복구는 UTC 분이 5의 배수인 scan에서 모든 trigger를 확인하며, Webhook 전달 완료 시에도
자기 trigger를 확인한다. ticker와 다음 Webhook 전달이 모두 없으면 자동 복구가 진행되지 않는다.
복구는 이력만 마감하고 불확실한 모델·도구 실행을 재시도하지 않는다.
running heartbeat는 준비·모델·Workspace 정리·결과 전송·완료 저장까지 소유 lease와 겹침 예약을
갱신한다. 오래된 `startedAt`만으로 살아 있는 실행을 유실로 판정하지 않는다. 소유권 검사 실패는
기존 실행을 취소하고 새 외부 효과를 차단하며, 완료 저장과 복구는 같은 소유 CAS로 보호한다.
running 시작부터 모델 실행 상한에 준비·완료 여유 5분을 더한 전체 수명 상한에 도달하면
소유권 갱신을 중단한다. 정리·전송·저장 요청이 멈춰도 마지막 lease 이후 이력 복구가 가능하며
불확실한 요청을 자동 재실행하지 않는다.

## 카탈로그 재색인

`X-Scan-Token`으로 `POST /api/catalog/reindex`를 매시간 호출한다. 현재 레지스트리 전체를
재색인하므로 누락된 tick은 다음 성공한 tick이 반영한다. 분 단위 호출은 모든 MCP 서버의
discovery와 문서 embedding을 반복한다.

- 설치 전역 DB lease가 재색인을 직렬화한다. 겹친 요청은 재색인을 거절하고 로그에 남긴다.
  검색은 lease 활성 상태와 generation을 확인해 재색인과 겹친 결과를 사용하지 않는다.
- MCP tool discovery는 동시에 최대 8개 서버에서 진행한다.
- 응답의 `{ started: true }`는 background 작업 예약이며 lease 획득·완료를 보장하지 않는다.
  로그의 `indexed`·`removed`와 discovery 실패 서버 목록인 `undiscovered`를 확인한다.
  실패 서버는 도구 없이 서버 항목만 색인한다. OAuth 미연결도 이 목록에 포함될 수 있다.
- `503`은 scan token 미설정 또는 `CATALOG_ENABLED` 미설정이다. 응답 body로 구분한다.
  카탈로그가 없는 배포는 Agent의 명시적 binding을 사용한다.
- GitHub·아카이브 Plugin sync는 보고서 저장 후 재색인을 예약한다. 실패는
  `reindex after plugins sync failed` 로그로 남으며 다음 reindex tick이 복구한다.

인덱스는 같은 DB의 `catalog_vectors`에 저장한다. 백업·복원에 포함하거나 재색인으로
재구축할 수 있다. 모델 전환과 검색 보류 조건은 [카탈로그 설계](design/capabilities.md#색인과-모델-전환)를 따른다.

## Plugins sync 티커

`POST /api/plugins/sync/scan`, 역시 같은 `X-Scan-Token`, 세 번째 CronJob. Agent Plugins
저장소(`PLUGINS_REPO`)를 두 레지스트리 모두로 당겨 오므로, admin 이 콘솔에 들어오지 않아도
머지가 반영된다. 1분 간격이어도 괜찮다. 아무것도 찾지 못한 틱의 비용은 요청 하나이기 때문이다.

- **head SHA 가 지름길이다.** 틱은 저장소의 head 를 먼저 읽고, 그것이 마지막으로 적용된 sync 와
  같으면 전체 스냅샷의 파일별 조회를 생략한다.
  차단된 쓰기 실패를 담고 있는 저장된 리포트는 이 지름길의 자격을 박탈하므로, 그것을 복구하는
  것은 재실행이다.
- **중복은 안전하다.** 저장소당 한 번에 하나의 sync 만 실행되고, 리스는 두 번째가 모든 GitHub
  읽기를 두 배로 만들게 두는 대신 그것을 *거부한다*. 그 경합에서 진 틱은 이미 `202` 를 답한
  뒤이고, warn 레벨로 `sync tick did not run` 을 남긴다. 결함이 아니라 흔한 겹침이다. 콘솔
  경로는 같은 거부를 `409` 로 드러낸다.
- **틱은 결코 삭제하지 않는다.** 저장소가 더는 담고 있지 않은 것은 orphaned 로 *보고*되며,
  매달린 채로 남게 될 Agent 바인딩도 함께 보고된다; 삭제 대상 선택은 콘솔에만 있다. 따라서
  플러그인을 없앤 머지가 레지스트리 행을 아무도 지켜보지 않는 채로 함께 가져갈 수는 없다.
  그것이 토큰 자체에 대해 무엇을 뜻하는지는
  [SECURITY.md](SECURITY.md#머신-호출자의-요청-인증) 를 보라.
- 결과는 저장된 리포트(`GET /api/plugins/sync`)와 로그 라인에 남는다.
- **아카이브가 마지막 sync 면 틱은 보류된다.** 사람이 올린 snapshot 을 다음 분의 자동 sync 가
  덮지 않도록 `{ started: false, held: "archive" }` 로 답한다. GitHub 가 다시 소유하게 하려면
  admin 이 `POST /api/plugins/sync` 를 명시적으로 실행한다. 예약된 자동 실행도 리스를 얻은
  직후 리포트를 다시 확인하므로 접수 이후 완료된 업로드를 덮지 않는다. 이 조회가 실패하면
  원격 스냅샷 조회·변경 없이 실행을 중단하고 리스를 해제한다.
  실행 중에는 100초마다 5분 리스를 갱신하고, 각 레지스트리·리포트 쓰기도 같은 DB 트랜잭션에서
  현재 소유권을 확인한다. 만료되거나 다른 작업에 넘어간 리스는 되살리지 않으며 남은 변경을 중단한다.
  재색인 예약은 이 소유권 범위 밖에서 수행한다.
- 503 은 `SCHEDULE_SCAN_TOKEN` 또는 `PLUGINS_REPO`/`GITHUB_TOKEN`이 설정되지 않았거나,
  마지막 sync 리포트를 읽을 수 없다는 뜻이다. 보류 상태를 확인할 수 없으면 자동 sync를 시작하지 않는다.
- **GitHub 에 닿지 않는 배포에는 이 틱이 없다.** 그런 배포는 admin 이 `/plugins` 에서
  체크아웃의 `.tar.gz` 를 올리는 것이 sync 이고(`POST /api/plugins/sync/upload`), 같은 리포트와
  같은 리스를 쓴다. GitHub 쪽 sync 와 동시에 돌 수 없다. 저장된 마지막 리포트는 설정된
  저장소 이름, 없으면 `archive` 아래에서 읽힌다.

## 배포 환경 소유권

이 저장소는 배포 manifest를 소유하지 않는다. IDC Compose, backup, secret, rollout은
`../dockpad`가 관리하고 EKS/Kubernetes manifest와 GitOps rollout은 `../argocd-env-demo`가
관리한다. Release workflow는 이미지를 ECR/GHCR에 발행하고 `argocd-env-demo`에 tag를 전달한다.

환경마다 database, object store, secret, ticker, webhook URL, MCP OAuth callback을 독립적으로
구성한다. `AES_ENCRYPTION_KEY`를 잃으면 그 환경의 저장 credential을 복호화할 수 없다.

## 다중 인스턴스 주의사항

아래는 **한 배포 안에서 인스턴스가 여럿일 때**의 이야기다. 같은 데이터베이스를 보는 프로세스들
사이의 문제다. 공유 설정·lease·이력은 DB에 있지만 실행 중인 SDK Runner와 HTTP background 작업은 해당 프로세스에 있다.
레플리카 간 중복 방지는 DB의 조건부 쓰기가 담당하고 migration은 advisory lock으로 직렬화한다.
프로세스 교체가 진행 중인 실행의 자동 복구를 뜻하지는 않는다.

| 동작 | 무엇에 묶이는가 | 결과 |
|---|---|---|
| 런타임 설정 전파 | `SETTINGS_CACHE_TTL_MS` (5s) | 관리자 설정은 설정 캐시가 만료될 때까지 다른 곳에서 이전 값으로 동작할 수 있다. email 기반 member tier의 캐시는 별도 30초이며 쓰기 시 무효화는 프로세스 안에서만 일어난다. |
| MCP 도구 목록 전파 | `MCP_DISCOVERY_CACHE_TTL_MS` / `MCP_MAX_SERVER_TTL_MS` | 다른 인스턴스가 같은 URL·헤더로 캐시한 도구 목록은 만료까지 유지될 수 있다. |
| 관리형 MCP | — | **호스트당 앱 인스턴스 하나.** 관리형 컨테이너가 게시하는 호스트 루프백 포트를 앱이 공유한다. |
| 메트릭 카운터 | — | 프로세스 단위. 인스턴스들 사이의 집계는 스크레이프 계층에서 하라. |
| 백그라운드 작업 (`after()`) | 해당 프로세스 | 중단된 메신저 이벤트·트리거 발화를 자동 재실행하지 않는다. 트리거 이력은 [복구 호출](#schedule-티커)이 있을 때 만료 lease를 failed로 마감한다. 메신저 이벤트에는 이 복구를 적용하지 않는다. |

### 재배포 이후의 관리형 MCP

관리형 컨테이너는 앱이 자기 호스트의 Docker CLI 로 띄우고(`MANAGED_MCP_RUNTIME=docker`)
`127.0.0.1:<port>` 매핑을 **게시**하므로, 앱 프로세스와 컨테이너가 같은 루프백을 봐야 한다.
앱이 호스트에서 돌거나, 컨테이너라면 호스트 네트워크를 공유해야 한다. 네임스페이스를 합류시키는
방식이 아니라서 앱을 교체해도 컨테이너의 주소는 그대로이고, 같은 이유로 **호스트당 앱 인스턴스
하나**가 전제다.

`reconcile` (`src/application/mcp/managedMcpUseCases.ts`) 은 부팅 시 `instrumentation.ts` 에서
발화되며 **결코 await 되지 않는다**: 모든 관리형 항목을 프로브해 답하지 않는 것들을 재시작한다.
await 하지 않는 이유는 재시작 한 번이 이미지를 당겨 오는 데 몇 분이 걸릴 수 있기 때문이고,
거기서 블록하면 서버가 listen 하기 전에 붙들려. 배포가 의존하는 바로 그 컨테이너 헬스체크를
실패시킨다.

`401` 은 답으로 친다: 자격 증명 문제 때문에 컨테이너를 다시 만드는 것은 아무것도 고치지 못한다.
`status` 가 도달 가능성(reachability)을 liveness 와 따로 보고하는 이유도 같다. liveness 만
보고하던 것이 이 부류의 실패를 보이지 않게 만든 원인이다.

## 운영 체크리스트

설치. 무엇을 띄우고 어떤 값을 채우는지. 는 [INSTALL.md](INSTALL.md) 가 단계별로 답한다.
아래는 설치가 끝난 배포를 *운영하는* 쪽의 항목이다.

- [ ] **시크릿.** `AES_ENCRYPTION_KEY` 와 `BETTER_AUTH_SECRET` 을 시크릿으로 프로비저닝하고
      백업할 것. 앞의 것을 잃으면 저장된 모든 자격 증명을 읽을 수 없고, proxied 오브젝트
      주소도 전부 무효가 된다(서명 키가 거기서 파생된다)
- [ ] **티커.** 다음 중 하나라도 쓴다면 `SCHEDULE_SCAN_TOKEN` 을 시크릿으로 프로비저닝하고
      배포 저장소의 ticker를 켤 것. 토큰 하나가 세 틱을 모두
      인증하고, 그중 하나(plugins sync)는 두 레지스트리에 쓴다:
      - `/api/triggers/scan` 을 최대 1분 간격으로. schedule 트리거, **그리고 행 보존의 sweep**.
        티커 없는 배포는 `expiresAt` 이 지난 행을 영원히 쌓는다
      - `CATALOG_ENABLED=true` 라면 `/api/catalog/reindex` 를 매시간. 레지스트리 쓰기는 결코
        재색인하지 않으므로 수동 등록 항목의 자동 반영에 이 tick이 필요하다.
        명시적 reindex 요청·Embedding 모델 변경·완료된 Plugin sync도 인덱스를 갱신한다
      - `PLUGINS_REPO` 가 설정됐다면 `/api/plugins/sync/scan`. 할 일이 없는 틱은 head SHA
        하나만 읽으므로 1분 간격이어도 괜찮다
- [ ] **백업.** 배포 저장소가 PostgreSQL과 object store backup·restore 절차를 소유해야 한다.
      `catalog_vectors`는 복원 대신 재색인으로도 충분하다
- [ ] **보존.** `*_RETENTION_DAYS` 를 정하고. 기본값은 [행 보존](#행-보존). 오브젝트 스토어의
      `artifacts/image/`, `artifacts/document/`, 레거시 `images/` prefix 에 같은 구간의
      lifecycle 규칙을 붙일 것. 새 prefix 에 규칙이 빠지면 조용한 누수가 된다: 행은 만료되는데
      오브젝트는 만료되지 않는다
- [ ] **오브젝트 스토어.** `S3_BUCKET_NAME` 을 쓴다면 `ARTIFACT_ACCESS_MODE` 를 고를 것.
      설치형은 `proxied`(스토어가 앱에게만 닿으면 된다). `authenticated` 라면 브라우저가 스토어에
      직접 닿아야 하고, `public` 이라면 `artifacts/*` 와 레거시 `images/*` 에 공개 읽기를
      명시적으로 허용해야 한다. 어느 모드든 스토어 자격 증명에는 `artifacts/*` 의 put·get·delete
      가 있어야 한다: `images/*` 로 좁힌 권한은 모든 쓰기를 실패시키는데 런은 그것을 겪고도
      *살아남고*(그림은 보여 주고 보관되지 않았다는 경고만 뜬다), get 이 없으면 갤러리와 chat
      트랜스크립트의 **모든** 이미지가 403 이 되며, delete 가 없으면 갤러리의 삭제가 실패하고
      행이 남는다
- [ ] **프록시.** `PUBLIC_BASE_URL` 을 바깥에서 보이는 주소로(Agent 실행 URL, Slack 매니페스트,
      Telegram webhook, Teams messaging endpoint 표시, OAuth 콜백, proxied 오브젝트 주소),
      `TRUSTED_PROXY_CIDRS` 에 앞단 프록시의 범위를(비워 두면 프록시 둘 뒤에서 rate limit 이
      함대 전체를 하나의 버킷으로 조인다), 그리고 프록시의 idle timeout 을 SSE keepalive(15초)
      보다 길게
- [ ] LB 헬스 체크 → `/api/ready`, 재시작 검사 → `/api/health`
- [ ] 컨테이너 `stopTimeout` ≥ `MAX_RUN_DURATION_MS` (Compose 예: `stop_grace_period: 660s`)
- [ ] Prometheus 가 `/api/metrics` 를 스크레이프할 것; `agent_studio_runs_failed_total`, `agent_studio_run_duration_seconds`, `agent_studio_unknown_model_calls_total` 에 알림
- [ ] 관리형 MCP 를 쓴다면 호스트당 앱 인스턴스 하나, 그리고 앱이 호스트의 Docker CLI 와 루프백에 닿을 것

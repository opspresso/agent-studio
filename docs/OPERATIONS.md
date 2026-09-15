# 운영

배포하고, 프로브하고, 스케일링하고, 데이터베이스를 유한하게 유지하는 일.

관련 문서: localdev와 배포 저장소의 소유권, 폐쇄망 대체 경로, 옛 AWS 배포 이관은
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

기본 운영 구성은 Agent 하나와 plugin skill이다. 후처리 대상을 자기 Agent의 `published`로 두면
작업 접수 시 실제 버전이 고정된다. 새 배포는 이미 접수된 작업을 바꾸지 않는다. 자동 수집의
외부 저장 대상은 비워두고, 개인 Memory·Document 기록은 요청한 Artifact에 대해서만 수행한다.

작업의 status와 stage를 구분한다. completed의 stage가 cleaning이어도 완료 상태다. waiting은
자동 재개하며 failed/blocked는 원인을 해결한 후 수동 retry한다. 수동 retry는 실행 구간만 새로
시작하고 성공한 단계·외부 receipt·파일 만료는 유지한다. 원본이 없어졌거나 연결이 바뀐 경우에는
그 원인을 복구해야 한다. 다른 모델·원본으로 새 처리가 필요하면 명시적 processingRevision을 사용한다.

원본과 최종 Artifact는 파일별 만료까지 보존하고 checkpoint만 완료 시 정리한다. 원본 bucket의
삭제 표식은 유지한다. 일반 Artifact bucket 수명주기를 이 bucket에 적용하지 않는다. 작업 이력과
중복 방지 기록은 파일 만료와 별개이므로 파일을 지워도 다음 schedule이 같은 녹음을 다시 처리하지 않는다.

전체 초기화가 필요한 개발·운영 유지보수에서는 다음 범위만 정리한다. 전용 reset API나 화면 버튼은 없다.

1. 해당 프로젝트의 schedule과 신규 작업·재시도를 비활성화한다. 이미 시작된 실행과 worker 작업이
   끝나거나 취소되어 lease·활성 slot이 비어 있는지 확인한다.
2. `keys.ts`의 해당 프로젝트 AUDIOJOB·AUDIOSOURCE·AUDIOOCCURRENCE·AUDIOSLOTS 행을 함께 정리한다.
   일부만 지워 중복 claim이 삭제된 job을 가리키게 하지 않는다. 다른 프로젝트의 행은 건드리지 않는다.
3. Artifact 삭제 여부는 별도로 결정한다. source-file 삭제 inventory·0바이트 표식은 유지해 지연된
   업로드가 지운 파일을 복원하지 못하게 한다. Agent·skill·인증·오디오 설정은 유지할 수 있다.
4. 빈 작업 목록과 중복 claim 정리를 확인하고 설정·schedule을 다시 켠다. 다음 실행은 설정된 수집
   시작 범위에서 한도 내의 녹음을 새로 처리한다. 이 작업은 외부 Memory·Document를 삭제하지 않는다.

## Workspace와 승인 후속 실행 운영

HTTP 앱과 Workspace worker는 같은 DB·암호화 키·Workspace 설정과 Docker daemon을 사용한다.
worker는 native 작업 큐와 Chat 후속 실행 큐를 별도로 처리하며 각 큐에 workerConcurrency 상한을
적용한다. `node build/workspace-health.cjs --worker`로 Docker·이미지·채널과 heartbeat를 확인한다.
프로세스가 살아 있다는 사실만으로 특정 작업의 성공을 판단하지 않고 Run·승인·전달 상태를 확인한다.

승인 결과의 알림은 DB에 남으므로 브라우저를 닫아도 대기한다. pending은 아직 소비하지 않은 알림,
waiting-ci는 등록된 PR HEAD의 검사 대기, running은 claim한 Chat 실행이다. claim 이후 중단되면
결과를 확인하기 전 자동 재실행하지 않는다. worker가 없으면 작업·TTL·승인 전달·CI 대기가 진행되지 않는다.
잘못된 저장소 이름·빈 저장소·접근 거절을 새 Workspace 생성으로 우회하지 않는다.

Sandbox 이미지는 전용 Docker daemon에도 저장된다. rootless daemon을 쓰면 앱 daemon의 이미지
정리만으로 그 디스크가 비워지지 않는다. 해당 daemon의 image/container 목록과 여유 공간을 확인하고
사용 중인 이미지와 복구용 버전은 보존한다. 다시 받을 수 있는 미사용 이미지·빌드 캐시만 정리하며,
Workspace 체크포인트·DB·오브젝트 volume을 이미지 캐시와 함께 삭제하지 않는다.

## 릴리스 파이프라인

`.github/workflows/release.yml`, `v*` 태그 push 로만 트리거된다. 임의 ref 를 고를 수 있는 수동
dispatch는 제공하지 않는다. 검증·릴리스는 GitHub-hosted Ubuntu runner에서 실행하며
OIDC·registry·GitOps 자격 증명은 해당 릴리스 작업에만 제공한다:
ECR role 의 trust 도 `Release` workflow 와 `v*` tag subject 를 함께 요구하며, 권한은 이 account 와
region 의 `agent-studio` repository 에 image 를 push 하는 action 으로 한정된다. 적용할 policy 와 별도
model-check role 은 `.github/aws-role/` 에 있다. `v*` tag 를 release operator 만 만들도록 보호하는
것은 이 trust가 전제하는 GitHub 설정이다.

1. **verify**. 전용 PostgreSQL test database 에 대해 `pnpm typecheck` + `pnpm test` +
   `pnpm test:integration`.
2. verify 가 통과하면 다음 둘이 **병렬**로 돈다.
   - **github-release**. GitHub Release 를 만든다. 릴리스 노트는 직전 태그와 이번 태그 사이의
     `git log` 로 생성된다 (`chore: release` 커밋은 걸러낸다). 이것이 이 프로젝트의 변경
     이력이다: 완료된 마일스톤은 [MILESTONES.md](MILESTONES.md) 에 보관되는 것이 아니라
     *삭제*되므로, git log 와 Releases 페이지가 그 기록이다.
   - **release**. `linux/amd64` 를 한 번 빌드해 두 레지스트리에 `:{tag}` 와 `:latest` 로
     푸시한다: **`ghcr.io/opspresso/agent-studio`**(`GITHUB_TOKEN` 으로 로그인, 이 AWS 계정 밖의
     설치가 pull 하는 경로이고, 폐쇄망 레지스트리로 미러링을 시작하는 지점이다)와 ECR(GitHub
     OIDC 로 AWS role 을 assume, 장기 키 없음). 같은 작업이 Sandbox 이미지를
     `workspace-{tag}`로 두 레지스트리에 게시한다.

3. **GitOps 트리거**. `release` 의 이미지 push 뒤 `argocd-env-demo` 에 새 tag 를 전달한다.
   `github-release` 의 성공 여부는 기다리지 않는다. 배포 manifest 와 rollout 은 그 저장소가
   소유하며, 이 저장소는 tag 전달만 담당한다.

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

자명하지 않은 빌드 설정이 둘 있다:

- **amd64 전용.** 현재 릴리스 workflow가 앱과 Sandbox 이미지를 `linux/amd64`로 빌드한다.
  다른 아키텍처가 필요한 배포는 별도 빌드·실행 검증이 필요하다.
- **`provenance: false`, `sbom: false`.** BuildKit 은 기본적으로 provenance attestation 을
  붙이는데, attestation 은 이미지 인덱스 안의 추가 매니페스트로 실려 간다. 그래서 단일 플랫폼
  빌드조차 인덱스 하나와 태그 없는 자식 둘을 푸시했다. 릴리스마다 ECR 엔트리가 하나가 아니라
  셋씩 들었고, 태그가 실제로 가리키는 것이 바로 그 태그 없는 것들이라, "태그 없는 이미지를
  만료시킨다" 는 뻔한 lifecycle 규칙이 릴리스된 태그가 필요로 하는 이미지를 지워 버린다.

## 헬스 프로브

| 엔드포인트 | 종류 | 동작 |
|---|---|---|
| `GET /api/health` | liveness | 정적 `200`. 의존성이 없고 인증도 없다. "프로세스가 서빙 중인가" 에 답한다. |
| `GET /api/ready` | readiness | PostgreSQL(`SELECT 1 FROM items LIMIT 1`, 연결·자격 증명·스키마를 한 번에)과 LLM 채널을 프로브한다 (각 2초 타임아웃, 상세는 노출하지 않는다). DB 프로브는 전용 connection 하나에서 연결 대기·클라이언트 응답·서버 실행을 모두 제한하고, 시간 초과 connection을 폐기한다. LLM 프로브는 `/models`의 **HTTP 연결만** 확인하고 응답 status나 API key의 유효성은 검사하지 않는다. 네트워크로 다운스트림에 닿을 수 없거나 **또는** 인스턴스가 draining 중이면 `503`. |

재시작 검사는 `/api/health` 에, 로드 밸런서는 `/api/ready` 에 붙여라.

### 수평 확장된 배포에서의 readiness

여러 인스턴스가 프로바이더 하나를 공유할 때 LLM 검사는 게이트로 삼기에 틀린 대상이다:
프로바이더가 한 번 삐끗하면 **플릿 전체**가 한꺼번에 unready 로 표시된다. 프로바이더가 전혀
필요 없는 콘솔·chat·대시보드까지 포함해서.

그런 배포에서는 readiness 도 `/api/health` 로 향하게 하고, draining 은 플랫폼 자신의 등록
해제(deregistration)에 맡겨라. 엔드포인트 전파 구간은 `preStop` 대기가 덮는다.

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

**CPU 가 아니라 `agent_studio_active_runs` 로 오토스케일하라.** 런은 I/O 바운드다. 런으로
포화된 인스턴스도 CPU 는 유휴로 읽힌다.

`agent_studio_oldest_active_run_seconds` 는 동시 런을 시작 handle 별로 추적한다. 새 런이 먼저
끝나도 더 오래된 런의 나이를 잃지 않으며, active run이 없으면 `0`이다. 기본 설정에서 600초를
넘으면 run deadline과 어긋난 실행이므로 원인을 조사하라. `MAX_RUN_DURATION_MS`를 바꿨다면 그
설정값을 기준으로 판단한다.

**리더가 떠났다고 chat 런이 더는 스스로 떨어져 나가지 않는다.** 탭을 닫은 것은 리더가 떠났다는
뜻이지 중단이 아니므로 ([design/chat.md](design/chat.md#런은-자기-연결보다-오래-산다) 참고),
이제 이 gauge 는 아무도 보고 있지 않은 런까지 센다. 더 정직한 숫자지만, 사용자로 가득 찬
페이지가 새로고침을 해도 더는 부하가 떨어지지 않는다. 런을 일찍 끝내는 것은 Stop 을 누르는
것과 런 데드라인뿐이다. 버려진 chat 런도 비용을 온전히 청구하고 끝날 때까지 caller 별 런
슬롯을 붙들고 있다; 그것을 묶는 것이 `MAX_CONCURRENT_RUNS_PER_ACTOR` 와 비용 가드다.

**gauge 가 아니라 실패와 지속 시간에 알림을 걸어라.** gauge 는 인스턴스가 얼마나 바쁜지를
말할 뿐, 그 작업이 성공하고 있는지도 이제 얼마나 걸리는지도 말하지 않는다. 취소된 런(끊고 나간
클라이언트)은 의도적으로 실패로 세지 않는다. 그러지 않으면 사용자로 가득 찬 페이지에서 다들
다른 곳으로 이동하는 것이 장애처럼 읽힌다. 이는 `/predict`, `/agent`, `/chat/completions`,
Slack 에는 여전히 해당하며, 이들은 caller 의 signal 을 받아 실제로 abort 한다; chat 은 Stop 을
눌렀을 때만 거기에 닿는다. 히스토그램에서 유한한 최상단 버킷은 고정된 `600`초이며 기본 런
데드라인과 같다. `MAX_RUN_DURATION_MS`를 바꿔도 버킷은 바뀌지 않으므로, 그때는 `+Inf` 버킷과
duration 합계를 실제 설정값에 맞춰 해석하라. 데드라인까지 방치된 버려진 chat 런은 *실패*로
기록된다.

**`agent_studio_unknown_model_calls_total` 의 rate 가 0 이 아니면 알림을 걸어라.**
`src/domain/llm/models.ts` 에 없는 model id 도 실행은 되지만, 그 usage 는 **$0** 로 기록된다.
그 누락이 망가뜨리는 바로 그 비용 대시보드에서 누락이 보이지 않는다. 누락마다 `[cost] unknown
model id` 를 한 번씩 로그로 남기기도 한다. `UNKNOWN_MODEL_POLICY=refuse` (env 또는 런타임
설정)는 이 카운터를 거부로 바꾼다: 런 브래킷이 어떤 가드보다도 먼저 `400` 을 답한다.

카운터는 프로세스 단위이며 **project 도 user 도 model 도 이름 붙이지 않는다**. 라벨은
히스토그램의 `le`와 build 정보의 유한한 `version`·`stage`뿐이다. 값의 범위가 무한한 라벨은
메트릭 하나를 값마다 하나씩의 시계열로 바꿔 놓는데, unknown model id 를 라벨로 달지 않고
카운트하는 이유도 그것이다.

## 로깅

모든 top-level 런은 런 브래킷이 admit 할 때 **correlation id** 를 받는다. 그 id 는
`AsyncLocalStorage` 에 실려, 그 런이 만들어 내는 모든 로그 라인에 찍힌다:

```
[mcp run=… trace=…] skipping server 'shared-mcp': …
```

이것은 의도적으로 trace id 가 **아니다**: 비-agent 경로에서는 trace 가 샘플링되므로
(`TRACE_SAMPLE_RATE`, 기본 `0.1`), trace id 를 correlation id 로 삼으면 프롬프트 런과 이미지
런 열 중 아홉은 상관지을 것이 없게 된다. 게다가 샘플링은 로그를 읽어 볼 가치가 있는 런을
우대하지 않는다. trace 가 실제로 존재하는 경우에는 두 id 가 함께 나온다.

요청 밖에서 시작된 작업은 운영자가 이미 볼 수 있는 id 를 쓴다: **webhook 전달**은 자기 history
행의 delivery id 를, **Slack 이벤트**는 Slack event id 를, **Telegram 업데이트**는 자신의
`update_id` 를, **Teams activity** 는 자신의 activity id 를 실어 나른다.

콘솔에 쓰는 일은 `src/shared/logger.ts` 가 소유하며 `tests/architecture.test.ts` 가 이를
고정한다. 상시 예외가 둘 있다: 아무것도 import 하지 않아 로거에 닿을 수 없는 `domain`. 위의
`[cost] unknown model id` warn 이 그중 하나이며, 정확히 그 이유로 `run=` 접미사가 없다.
그리고 SDK 예제가 `console.log` 를 단지 *보여 줄* 뿐인 API 레퍼런스 페이지다.

실패한 요청은 `apiError` 를 거쳐 로그에 도달하며, 그 레벨이 누구 잘못인지를 말한다: 설명할 수
없는 throw 는 `error` 다. caller 는 `Internal server error` 를 받고 메시지는 여기 남는다.
타입이 있는 `5xx` 는 `warn` 이며 그 메시지는 caller 가 이미 갖고 있다. `4xx` 는 어디에도
남기지 않는다: 그것은 API 가 제대로 동작하는 것이고, 거부된 body 를 전부 기록하면 앞의 둘이
묻힌다. 업스트림의 거부를 애초에 grep 할 수 있는 이유가 이것이다. `apiError` 가 타입 있는
에러를 로그 없이 답하던 동안에는, 실패에 타입을 주는 일이 곧 그것을 조용히 기록에서 빼는
일이었다.

비스트리밍 응답(`predict`, `chat/completions`) 전에 끊고 나간 caller 는 세 번째 경우이며,
`[api run=…] caller left before the answer` 로 `info` 레벨에 남는다. 실패도 결함도 아니고,
아무도 없으므로 되돌려 보내는 것도 없다. 있는 그대로 읽어라: xAI 의 이미지 생성은 1분쯤
걸리는데, 그동안 새로고침한 사람은 예전에 로그에 `Image generation failed for xai/…: ` 를
**콜론 뒤에 아무것도 없이** 남겼고, 그것이 프로바이더의 거부처럼 읽혔다. Next 는 메시지가 없는
에러로 요청을 abort 하는데, 런의 abort 가 마치 프로바이더의 답인 것처럼 매핑되고 있었다.

## 트레이싱

Agent 런은 **항상** 트레이싱된다. 비-agent 런과 이미지 predict 런은 `TRACE_SAMPLE_RATE` 로
샘플링된다.

트레이스는 프로젝트 소유자와 관리자(`assertProjectWritable` 기준)에게 보인다. SDK span은 이름·종류·상태·시간,
native ID와 부모 ID, 모델 토큰·비용을 저장한다. `prepare`에는 skill·Agent·MCP·도구의 수와
발견한 capability 이름 최대 20개를 기록한다. 원본 프롬프트와 도구 결과는 span에 저장하지 않는다.
다만 Trace의 `error`와 `warnings`는 원문 오류를 최대 1,000자로 보관하므로 민감 정보가 포함될
수 있다. Trace에는 실행을 일으킨 `actor`와 대화의 `conversation`도 기록한다.

`OTEL_EXPORTER_OTLP_ENDPOINT`를 설정하면 저장된 Trace를 OTLP로 내보낸다.
[설정](CONFIGURATION.md#관측성과-보존-기간)에 따라 endpoint와 headers를 주입한다. exporter는
Studio 런을 root로 만들고 저장된 `parentSpanId` 관계를 따라 span 계층을 내보낸다. 자식이 먼저
완료되어 저장됐어도 부모부터 생성하며, 생략된 부모는 root에 연결한다. 타임스탬프·이름·상태와
`app.span_id`·`app.parent_span_id`·`app.span.kind`·`app.span.author`, root의
`app.trace_id`·프로젝트·버전·호출자·대화 속성을 전송한다. OTLP 자체 ID는 새로 생성하며
원래 SDK ID는 위 속성으로 대응한다. 세부 사용량과 원문을 제외한 native 메타데이터는 DB Trace에서 조회한다.

기록의 정본은 DB 행이다. collector 장애는 `[otel]` 로그로 보고하고 실행을 실패시키지 않는다.
export 배치는 draining 시 flush한다.

SDK의 기본 공개 exporter는 사용하지 않는다. `runtime/tracing.ts`가 로컬 native span을 수집하고,
승인 대기 실행은 `awaiting-approval`로 저장한다. SDK 모델·도구의 원문 데이터는 수집하지 않는다.

### 승인 대기 실행

Chat 소유자가 도구별 인자를 확인하고 승인·거절한다. 재개는 정확한 revision을 원자적으로
선점하며, 중복 재개와 변경된 버전/바인딩을 거부한다. 승인 후 인스턴스가 종료되어 체크포인트가
`running`으로 남으면 자동 재실행하지 않는다. 도구 효과를 확인한 뒤 실행 잠금이 만료되었거나
해제된 상태에서 폐기한다. 폐기는 화면 기록을 남기고 미완료 실행을 모델 문맥에서 제외한다.

## 행 보존

SDK Session과 승인 체크포인트는 `runtime_sessions.expires_at`으로 만료되며 chat 보존 기간을
사용한다. 만료된 행은 읽기에서 제외한다. Chat 삭제 tombstone은 늦은 실행의 저장을 막고
run-log 보존 기간 뒤 정리된다. 스캔 토큰이 없으면 이 테이블도 자동으로 정리되지 않는다.

트레이스, usage 행, chat 과 그 메시지, 아티팩트 행, 트리거 전달, 인바운드 A2A 태스크,
Slack·Telegram·Teams 중복 제거 claim 은 모두 유닉스 초 단위 `expiresAt` 을
지니며, 수명이 고정된 여섯 종류의 행도 마찬가지다: webhook 멱등 claim (24h), Slack 스레드 참여
(1일, 봇이 답한 스레드가 "봇의 것" 으로 남아 있는 구간), 원격 대화 (7일, 사용할 때마다 갱신.
A2A 에이전트의 `contextId` 가 우리 쪽 대화 하나를 위해 이어지는 구간이며, 그것을 넘기면 다음
transfer 는 맨바닥에서 시작한다), Telegram·Teams 대화 트랜스크립트 턴 (각 7일. 두 플랫폼 모두 히스토리를
돌려주지 않으므로 후속 메시지가 나르는 컨텍스트), MCP OAuth 진행 중 state (10분), 그리고 런
동시성 슬롯 (리스 길이, TTL 이 없어도 동시성은 정확하지만, 행이 런당 하나씩 쌓인다).

> **만료는 테이블의 기능이 아니라 틱이다.** schedule-scan 틱(`POST /api/triggers/scan`)이 돌
> 때마다 `sweepExpiredRows` 가 `expiresAt` 이 지난 행을 지운다. 한 번에 `items` 에서 최대
> 5,000행, Better Auth `session`에서 최대 5,000행, SDK `runtime_sessions`에서 최대
> 1,000행을 지우므로 총 상한은 11,000행이다.
> 밀린 분량은 다음 틱들이 나눠 가져가고, 실패해도 스캔은 실패하지 않는다. `session` 은 자기
> `expiresAt` 을 기준으로 쓴다: 라이브러리는 만료된
> 세션을 그 쿠키가 다시 올 때만 지우므로, 돌아오지 않은 브라우저의 행은 틱이 아니면 영원히 남는다.
> **`SCHEDULE_SCAN_TOKEN` 이 없는 배포는 티커가 없고, 따라서 아무것도 지우지 않는다.** 앱은
> 그 사실을 경고로 올릴 길이 없다. 테이블 크기만이 말해 준다. 배포 저장소는 이 endpoint를
> 호출하는 ticker를 반드시 구성해야 한다 ([Schedule 티커](#schedule-티커)).

| 행 | 기본값 | 변수 | 기준 시점 |
|---|---|---|---|
| 트레이스 (+ 그 삭제 참조) | 30일 | `TRACE_RETENTION_DAYS` | 트레이스의 `createdAt` |
| Usage | 400일 | `USAGE_RETENTION_DAYS` | usage 행의 날짜 |
| Chat + 메시지 | 180일 | `CHAT_RETENTION_DAYS` | 마지막 활동 / 메시지의 `createdAt` |
| 아티팩트 행 | 180일 | `ARTIFACT_RETENTION_DAYS` | 아티팩트의 `createdAt` |
| 트리거 전달 | 30일 | `TRIGGER_RUN_RETENTION_DAYS` | 전달 시작 |
| 인바운드 A2A 태스크 | 1일 | `A2A_TASK_RETENTION_DAYS` | 마지막 쓰기 |
| 감사 기록 | 400일 | `AUDIT_RETENTION_DAYS` | 행위의 `createdAt` |
| chat 런 리플레이 로그 | 런 리스 + 15분 | *(파생값이며 설정 불가)* | 그 행의 쓰기 시점 |

usage 와 감사 행이 가장 오래 남는다. 대시보드는 최대 184일 전까지 질의하고, 감사 행이 답하는
질문("지난 분기에 admin 목록을 누가 바꿨나")은 그 행위로부터 한참 뒤에 던져진다. 트레이스와
그 삭제 참조는 만료 시점을 공유하므로 참조가 매달린 채로 남는 일이 없다. chat 런 리플레이
로그는 이 표 전체에 대한 예외다: 그것은 연결이 끊긴 리더가 따라잡는 버퍼이지 기록이 아니며,
그 구간은 설정되는 것이 아니라 `MAX_RUN_DURATION_MS` 에서 파생된다. 런보다 짧게 설정될 수
있는 값이라면 resume 한가운데에 구멍을 남길 것이기 때문이다.

틱은 1분 간격이므로 행은 만료 뒤 한 틱까지 살아 있을 수 있고, 그래서 **읽기 쪽에서도 이미
만료된 행을 걸러낸다**. `queryItems` 의 `notExpiredAt` 이 `LIMIT` 보다 먼저 도는 `WHERE`
라, `traceRepository` 의 상위 N 개는 살아 있는 행으로 찬다.

런이 만들어 낸 것은 데이터베이스 밖에 살고, **거기서의 만료는 오브젝트 스토어의 몫이다**.
아티팩트 행은 오브젝트를 지목하고 의도적으로 삭제할 수도 있지만(갤러리의 삭제 버튼이 정확히
그렇게 한다), 만료를 훑는 것은 아무것도 없다: sweep 은 `DELETE` 한 문장으로 행을 지우고
애플리케이션은 어느 행이 갔는지 관측하지 못하므로, 연쇄 삭제를 걸 순간 자체가 없다.

**각 prefix 에 lifecycle 규칙을 붙여라**, 행의 구간에 맞춰서. AWS S3 는 버킷 lifecycle,
MinIO 는 `mc ilm rule add --expire-days …`:

| Prefix | 구간 | 담는 것 |
|---|---|---|
| `artifacts/image/` | `ARTIFACT_RETENTION_DAYS` | 생성된 이미지와 첨부된 이미지 |
| `artifacts/document/` | `ARTIFACT_RETENTION_DAYS` | 첨부 문서 원본과 도구가 생성·편집한 파일 |
| `images/` | `CHAT_RETENTION_DAYS` | 아티팩트 이전의 레이아웃; 아직 읽지만 쓰지는 않는다 |

이 두 설정은 앱이 맞춰 줄 수 없고, 어긋나는 두 방향 모두 눈에 보인다: 행이 먼저 만료되면
아무것도 이름 붙이지 않는 오브젝트가 남고. 인벤토리로만 다시 찾을 수 있으니 보이지 않는
누수다. 오브젝트가 먼저 만료되면 갤러리가 404 나는 미리보기를 나열한다. UI 는 두 번째 경우를
깨진 이미지가 아니라 "더 이상 사용할 수 없음" 으로 렌더링한다. 아티팩트 이전의 `images/`
오브젝트는 어떤 행도 지목하지 않으므로 그 prefix 의 규칙에 맡겨라.
[SECURITY.md](SECURITY.md#데이터-노출과-보존) 를 보라.

## 지출 가드와 부하 가드

둘 다 런 브래킷(`src/application/run/runBracket.ts`)에 매달려 있고 **의도적으로 서로 반대
방향으로 실패한다**. 그 사이에 세 번째 가드가 있다: **member tier 의 월간 상한**
(`src/domain/member/tiers.ts` 의 `TIER_LIMITS`, 기본값은 `member` $20, `guest` $2)은 `user`
actor 에 대해 프로젝트의 비용 가드 다음, 슬롯 이전에 검사된다. 그래서 예산을 넘긴 사람은 어차피
거부될 런의 슬롯을 기다리는 대신 그 사실을 바로 듣게 된다. 이 가드도 나머지 둘처럼 `429` 를
답하고, 비용 가드처럼 fail-open 하며, tier 모델과 함께
[SECURITY.md](SECURITY.md#인가-모델) 에 문서화돼 있다.

### 비용 가드: fail-open

**Project Settings → Cost limits** 아래에서 설정하는, 두 개의 UTC 윈도우에 걸친 프로젝트별
임계값:

- `alertThresholdUsd` / `monthlyAlertThresholdUsd`. 알림을 한 번 올리고 계속 실행한다.
- `blockThresholdUsd` / `monthlyBlockThresholdUsd`. 그 윈도우가 끝날 때까지 모든 런을
  거부한다. 모든 실행 진입점이 `429` 를 답하며 `Retry-After` 에는 윈도우가 넘어갈 때까지의
  초가 담긴다. 일간이면 00:00 UTC, 월간이면 다음 달 1일. 그 시점이 바로 그 거부가 더 이상
  참이 아니게 되는 때다. 한 달의 지출은 그달의 일별 행을 더한 값이다: 유한한 질의 하나,
  어긋날 별도의 집계값 없음. `USAGE_RETENTION_DAYS` 의 하한이 한 달 전체인 이유가 그것이다
  ([CONFIGURATION.md](CONFIGURATION.md#관측성과-보존-기간) 참고); 달 중간에 행이
  만료되면 그 윈도우를 조용히 과소 계산하게 된다.

알림은 `alertDestinations` 에 선택한 프로젝트 자신의 Slack·Telegram·Teams 연동으로 가며,
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

caller 당 `MAX_CONCURRENT_RUNS_PER_ACTOR` (기본 10); 인바운드 A2A 는 actor id 가 상수이므로
자체의 `MAX_CONCURRENT_RUNS_A2A` (기본 50)를 쓴다. `0` 은 그 한도를 끈다. 한도를 넘으면 런은
`429` 와 짧은 `Retry-After` 로 거부되는데, **시작되기 전에** 거부되므로 usage 도 트레이스도
남기지 않는다. 두 설정의 최대값은 저장 slot index가 표현하는 1000이다.

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

Schedule 트리거는 무언가가 `X-Scan-Token: $SCHEDULE_SCAN_TOKEN` 과 함께
`POST /api/triggers/scan` 을 틱할 때에만 발화한다. localdev는 `deploy/local/scripts/tick.sh`를
사용하고, 실제 환경의 ticker는 `../dockpad`와 `../argocd-env-demo`가 소유한다. **행 보존의
sweep도 이 틱에 얹혀 있다**. 1분마다 이미 도는 유일한 것이기 때문이다. 티커가 만족해야 하는
계약은 다음이 전부다:

- **주기 ≤ 1분.** 스캔은 고정된 10분짜리 만회 윈도우를 되돌아보므로, 틱을 한 번 놓치거나 짧게
  장애가 나도 잃는 것이 없다; 윈도우보다 긴 장애는 그 발생분들을 영영 버린다 (의도적으로 유한하게
  뒀다. 복구가 한 번에 시작할 수 있는 런의 수도 함께 묶기 때문이다).
- **중복은 안전하다.** 티커가 몇 개든 어느 인스턴스든 동시에 호출해도 된다; 각 발생은 조건부
  쓰기로 claim 되고 정확히 하나의 claim 만 이긴다
  ([design/triggers.md](design/triggers.md#schedule)).
- **한 번의 틱은 동시에 최대 8건까지만 발화한다** (`MAX_CONCURRENT_FIRINGS`). 그러지 않으면 모든
  프로젝트가 공유하는 09:00 이 틱을 받은 인스턴스 하나에서 그만큼의 동시 런이 되고, caller 별
  동시성 가드는 그 팬아웃을 묶지 못한다. 트리거는 저마다 자기 자신이 actor 라, 하나하나가
  자기 한도 안에 있기 때문이다.
- 요약은 매 틱마다 로그에 남는다(그리고 응답에도 담긴다): `repaired` > 0 이면 인스턴스가 발화
  도중에 죽었다는 뜻이고, `invalid` > 0 이면 저장된 cron/타임존이 더는 파싱되지 않는다는 뜻이며,
  `errors` > 0 이면 저장소 호출이 실패해 차단됐다는 뜻이다. 거부된 토큰은 서버 쪽에 경고를
  남긴다. 세 토큰 엔드포인트 전부에서. 401 을 받는 티커는 그러지 않으면 클러스터 안에서
  보이지 않기 때문이다.

## 카탈로그 재색인

`POST /api/catalog/reindex`, 위와 같은 `X-Scan-Token`, 또 하나의 CronJob. schedule 티커와 달리
놓칠 윈도우가 없다: 틱은 지금 이 순간의 레지스트리로부터 인덱스를 다시 만들므로, 한 번
건너뛰어도 지난번 이후 바뀐 것의 발견이 늦춰질 뿐이다. **한 시간 간격이면 충분하다**; 분 단위
틱은 아무 소득 없이 모든 MCP 서버를 그 빈도로 프로브하게 된다.

- **중복은 안전하다.** 키는 항목에서 파생되므로, 두 번째 패스는 같은 레코드를 쓰고 같은 잔여물을
  계산한다.
- MCP tool discovery는 동시에 최대 8개 서버만 진행한다. registry 크기가 그대로 outbound 연결
  burst가 되지 않게 하는 실행 상한이다.
- 틱은 작업을 넘기자마자 반환한다; 결과는 로그 라인에 있다. `indexed`, `removed`, 그리고 도구
  목록을 가져오지 못한 서버를 이름 붙이는 `undiscovered`. OAuth 연결이 필요한 서버가 그 목록에
  있는 것은 예상된 일이다: 서버 수준에서는 여전히 색인되고, 다만 그 도구들이 없을 뿐이다.
- 503 에는 두 가지 원인이 있고 이 순서로 확인된다: `SCHEDULE_SCAN_TOKEN` 이 설정되지 않은 경우.
  엔드포인트에 티커를 인증할 자격 증명이 없다는 뜻이므로 누가 요청하든 스캔을 거부한다.
  그다음 `CATALOG_ENABLED` 가 설정되지 않은 경우(`CATALOG_ENABLED is not set`)인데, 이는 결함이
  아니라 카탈로그가 없는 배포다. 그러면 런은 자기 버전이 묶어 둔 것만 정확히 제공한다. 어느
  쪽인지는 응답 body 가 이름을 밝힌다. 인덱스는 같은 데이터베이스의 `catalog_vectors` 에 있으므로
  백업과 복원에 따라오고, 옮겨 갈 때는 옮기지 않고 재색인 한 번으로 다시 만든다.
- **완료된 plugins sync 도 재색인한다**, 두 경로(콘솔과 분 단위 틱) 모두에서. 그래서 plugins
  저장소로의 머지는 한 시간을 기다리지 않고도 발견된다. 그 재색인은 sync 가 커밋되고 그 리포트가
  저장된 뒤에 실행되므로, 실패는 로그에 남고 삼켜진다. 로그의
  `reindex after plugins sync failed` 가 그것이고, 다음 틱이 복구한다.

## Plugins sync 티커

`POST /api/plugins/sync/scan`, 역시 같은 `X-Scan-Token`, 세 번째 CronJob. Agent Plugins
저장소(`PLUGINS_REPO`)를 두 레지스트리 모두로 당겨 오므로, admin 이 콘솔에 들어오지 않아도
머지가 반영된다. 1분 간격이어도 괜찮다. 아무것도 찾지 못한 틱의 비용은 요청 하나이기 때문이다.

- **head SHA 가 지름길이다.** 틱은 저장소의 head 를 먼저 읽고, 그것이 마지막으로 적용된 sync 와
  같으면 거기서 멈춘다. 전체 스냅샷이 필요로 하는 ~30 번의 blob 읽기에 대비되는 읽기 한 번이다.
  차단된 쓰기 실패를 담고 있는 저장된 리포트는 이 지름길의 자격을 박탈하므로, 그것을 복구하는
  것은 재실행이다.
- **중복은 안전하다.** 저장소당 한 번에 하나의 sync 만 실행되고, 리스는 두 번째가 모든 GitHub
  읽기를 두 배로 만들게 두는 대신 그것을 *거부한다*. 그 경합에서 진 틱은 이미 `202` 를 답한
  뒤이고, warn 레벨로 `sync tick did not run` 을 남긴다. 결함이 아니라 흔한 겹침이다. 콘솔
  경로는 같은 거부를 `409` 로 드러낸다.
- **틱은 결코 삭제하지 않는다.** 저장소가 더는 담고 있지 않은 것은 orphaned 로 *보고*되며,
  매달린 채로 남게 될 버전 바인딩도 함께 보고된다; 삭제 대상 선택은 콘솔에만 있다. 따라서
  플러그인을 없앤 머지가 레지스트리 행을 아무도 지켜보지 않는 채로 함께 가져갈 수는 없다.
  그것이 토큰 자체에 대해 무엇을 뜻하는지는
  [SECURITY.md](SECURITY.md#머신-호출자의-요청-인증) 를 보라.
- 결과는 저장된 리포트(`GET /api/plugins/sync`)와 로그 라인에 남는다.
- **아카이브가 마지막 sync 면 틱은 보류된다.** 사람이 올린 snapshot 을 다음 분의 자동 sync 가
  덮지 않도록 `{ started: false, held: "archive" }` 로 답한다. GitHub 가 다시 소유하게 하려면
  admin 이 `POST /api/plugins/sync` 를 명시적으로 실행한다.
- 503 은 `SCHEDULE_SCAN_TOKEN` 이 설정되지 않았거나, `PLUGINS_REPO`/`GITHUB_TOKEN` 이 설정되지
  않았다는 뜻이다.
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
사이의 문제다. 런 상태는 전부 데이터베이스에 있으므로 레플리카를 늘려도 되고, 스키마 마이그레이션은
부팅 때 advisory lock 아래에서 한 번만 돈다. 먼저 뜬 인스턴스가 적용하고 나머지는 기다린다.

| 동작 | 무엇에 묶이는가 | 결과 |
|---|---|---|
| 런타임 설정 전파 | `SETTINGS_CACHE_TTL_MS` (5s) | 관리자 설정이나 회전된 A2A 키는 설정 캐시가 만료될 때까지 다른 곳에서 이전 값으로 동작할 수 있다. email 기반 member tier의 캐시는 별도 30초이며 쓰기 시 무효화는 프로세스 안에서만 일어난다. |
| MCP 레지스트리 편집 | `MCP_DISCOVERY_CACHE_TTL_MS` / `MCP_MAX_SERVER_TTL_MS` | 한 인스턴스에서 한 편집이 그 구간만큼 다른 인스턴스들에게 보이지 않는다. |
| 관리형 MCP | — | **호스트당 앱 인스턴스 하나.** 관리형 컨테이너가 게시하는 호스트 루프백 포트를 앱이 공유한다. |
| 메트릭 카운터 | — | 프로세스 단위. 인스턴스들 사이의 집계는 스크레이프 계층에서 하라. |
| 백그라운드 작업 (`after()`) | — | 인스턴스가 갑자기 사라지며 중단된 Slack 이벤트·Telegram 업데이트·Teams activity·트리거 발화는 **재개되지 않는다**. 런은 멱등하지 않다. 두 종류의 트리거 행 모두 sweep 이 `failed` 로 복구한다. 5분마다 오는 스캔 틱에서(`REPAIR_EVERY_MINUTES`, sweep 이 모든 프로젝트의 트리거를 훑고 그 history 를 읽기 때문에 매분 할 만한 일이 아니다), 그리고 그 트리거 자신의 다음 webhook 전달에서. 그래서 티커를 설정하지 않은 배포에서도 원장은 결국 올바르게 끝난다. 잃어버린 Slack 이벤트·Telegram 업데이트·Teams activity 는 의도적으로 복구하지 않는다. 마무리할 행을 남기지 않고, 답을 못 받은 사용자만 남기기 때문이다. |

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
        재색인하지 않으므로, 이 틱이 없으면 인덱스를 갱신하는 것은 완료된 plugins sync 뿐이고,
        손으로 등록한 Skill 이나 서버는 영영 발견되지 않는다
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
- [ ] **프록시.** `PUBLIC_BASE_URL` 을 바깥에서 보이는 주소로(Agent Card, Slack 매니페스트,
      Telegram webhook, Teams messaging endpoint 표시, OAuth 콜백, proxied 오브젝트 주소),
      `TRUSTED_PROXY_CIDRS` 에 앞단 프록시의 범위를(비워 두면 프록시 둘 뒤에서 rate limit 이
      함대 전체를 하나의 버킷으로 조인다), 그리고 프록시의 idle timeout 을 SSE keepalive(15초)
      보다 길게
- [ ] LB 헬스 체크 → `/api/ready` (확장된 플릿에서는 `/api/health`), 재시작 검사 → `/api/health`
- [ ] 컨테이너 `stopTimeout` ≥ `MAX_RUN_DURATION_MS` (Compose 예: `stop_grace_period: 660s`)
- [ ] Prometheus 가 `/api/metrics` 를 스크레이프할 것; `agent_studio_runs_failed_total`, `agent_studio_run_duration_seconds`, `agent_studio_unknown_model_calls_total` 에 알림
- [ ] 관리형 MCP 를 쓴다면 호스트당 앱 인스턴스 하나, 그리고 앱이 호스트의 Docker CLI 와 루프백에 닿을 것

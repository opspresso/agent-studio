# 설치와 배포 소유권

이 앱은 기업이 자기 네트워크 안에 설치해 운영하는 플랫폼이다. 이 저장소는 애플리케이션
이미지와 로컬 개발 환경만 소유한다. 실제 배포 정의는 배포 환경의 저장소가 소유한다.

| 환경 | 소유 위치 | 이 저장소가 제공하는 것 |
|---|---|---|
| localdev (Docker Compose) | 이 저장소의 `compose.yaml`, `deploy/local/` | 호스트에서 `pnpm dev`로 실행하는 앱, 독립 `agent-studio-local` PostgreSQL 18·MinIO와 로컬 MCP 서버 |
| IDC | `../dockpad` | `agent-studio` 릴리즈 이미지 |
| EKS/Kubernetes | `../argocd-env-demo` | `agent-studio` 릴리즈 이미지 |

IDC Compose나 Kubernetes manifest를 이 저장소에 복사하지 않는다. 배포 설정, ingress, secret,
backup, rollout, ticker는 각 배포 저장소에서 관리한다.

## 필요한 런타임

- PostgreSQL 18 + pgvector. 앱이 부팅할 때 스키마를 적용하고 `vector` 확장을 만든다.
- 관리자가 등록한 OpenAI 호환 LLM endpoint. 로그인 후 프로바이더와 모델을 등록할 수 있으므로 부팅에는 모델 연결이 필요하지 않다.
- 32-byte base64 `AES_ENCRYPTION_KEY`.
- S3 호환 object store는 선택이다. 없으면 artifact 영속화와 `File` 도구가 꺼진다.
  첨부 문서의 텍스트 추출은 계속되지만 원본 보관·재열기·편집은 할 수 없다.
- `NODE_ENV=production`에서는 `STAGE`를 명시한다. `STAGE=alpha|prod`는 추가로
  `ADMIN_EMAILS`와 로그인 방식 하나를 요구한다.

전체 환경변수와 고정 한계는 [CONFIGURATION.md](CONFIGURATION.md), 운영 계약은
[OPERATIONS.md](OPERATIONS.md)를 보라.

## Keycloak 로그인

Google 없이 사내 Keycloak만으로 로그인할 수 있다. 다음 값을 애플리케이션 환경에 설정하고
재시작한다. `KEYCLOAK_ISSUER`는 discovery 문서 URL이 아닌 realm URL이다.

```dotenv
BETTER_AUTH_URL=https://studio.example.com
KEYCLOAK_ISSUER=https://sso.example.com/realms/corp
KEYCLOAK_CLIENT_ID=agent-studio
KEYCLOAK_CLIENT_SECRET=<client-secret>
ADMIN_EMAILS=admin@example.com
ALLOWED_EMAIL_DOMAINS=example.com
```

Keycloak에서 해당 realm에 OpenID Connect client를 만들고 Client authentication과 Standard flow를
켠다. Valid redirect URIs에는 `https://studio.example.com/api/auth/callback/keycloak`을 정확히
등록한다. PKCE method는 `S256`으로 설정할 수 있다. `openid profile email` scope를 사용하므로
사용자에게 email을 설정하고 해당 claim이 ID 토큰에 포함되도록 한다. 사용자 self-registration을
허용한다면 realm의 Verify Email도 켜서 사용자가 입력한 주소의 소유권을 확인한다. Client secret은 배포의
secret 저장소로 주입한다. 기본 앱 환경 변수와 `BETTER_AUTH_SECRET`도 필요하다.

서버는 realm의 discovery·token·JWKS endpoint에, 사용자 브라우저는 로그인 endpoint에 접근해야 한다.
사내 TLS 인증서를 쓰면 앱 런타임과 브라우저가 발급 CA를 신뢰하도록 구성한다. 공개 인터넷 없이
운영할 때는 사내 Keycloak 또는 비밀번호 로그인을 구성하고 Google 변수는 비워 둔다.
Google도 필요하면 `GOOGLE_CLIENT_ID`와 `GOOGLE_CLIENT_SECRET`을 함께 설정한다.

기존 `OIDC_*`로 Keycloak을 연결한 설치는 그 설정을 유지할 수 있다. `oidc`와 `keycloak`은 서로
다른 provider ID와 콜백을 사용하므로 같은 realm을 중복 등록하지 않는다. 공급자 전환 시 기존
계정 키를 자동 이관하지 않는다. 이 서비스에서 로그아웃하면 앱 세션만 종료하며 Keycloak SSO 세션은
유지한다. 토큰 검증과 접근 제한은 [SECURITY.md](SECURITY.md#인증)를 따른다.

설정 항목의 의미는 [Keycloak OIDC 문서](https://www.keycloak.org/securing-apps/oidc-layers)와
[client 설정 문서](https://www.keycloak.org/docs/latest/server_admin/index.html#_oidc_clients)를 참고한다.

## Slack 연동

Slack은 선택 연동이다. Agent Integrations의 Slack bot에서 생성한 매니페스트로
Agent 전용 앱을 만들고 워크스페이스에 설치한다. Bot token과 Basic Information의 signing secret을
앱에 저장하고 이벤트 수신을 켠 뒤, Slack Event Subscriptions에서 생성된 Request URL의 검증을 확인한다.
채널에서 사용하려면 봇을 해당 채널에 초대한다.
Slack 기본 중단 버튼은 매니페스트의 `agent_session_stopped` 구독이 있어야 표시된다.
기존 앱에도 해당 구독을 적용해야 하며, thread 안의 `!stop` 명령으로도 실행을 중단할 수 있다.

Slack에서 Agent의 HTTPS 이벤트 URL에 접근할 수 있어야 하며, 앱은 Slack Web API에
접근할 수 있어야 한다. Socket Mode는 꺼 둔다. 공개 인터넷이 차단된 배포에서는 Slack 연동을 끄고
앱의 Chat·Agent 실행을 사용한다.

기존 Slack 앱 설정은 이 서비스에 저장만 해서는 바뀌지 않는다. 생성된 매니페스트를 Slack의 App Manifest 설정에
다시 적용하고 권한이 바뀌면 앱을 재설치한다. 생성 매니페스트의 기능·권한 범위는
[Slack 설계](design/slack.md#앱-매니페스트)를 따른다.

조직 배포를 이미 켠 앱은 `settings.org_deploy_enabled: true`를 유지해야 한다.
생성 매니페스트는 이 필드를 생략하므로 Slack의 기존 값을 복사해 넣은 뒤 적용한다.
필드를 생략하거나 `false`로 바꾸는 것을 조직 배포를 끄는 방법으로 사용하지 않는다.

## 오디오 worker

오디오 전사는 선택 기능이다. HTTP 앱과 같은 이미지의 `node build/audio-worker.cjs`를 별도 process로
실행한다. 로컬 `.env.local`을 사용할 때는 `node --env-file=.env.local --import tsx scripts/audio-worker.ts`로 실행한다.
환경변수가 이미 주입된 환경에서는 `pnpm worker:audio`를 사용한다. DB 초기화는 앱 또는 기존 migration 명령으로
먼저 수행한다. worker는 DB의 선택 모델·프로바이더 설정을 주기적으로 읽고 작업과 원본 만료를 처리한다.
여러 파일은 DB 큐에 접수하며 Agent마다 한 건씩 순차 실행한다. `maxActive`는 대기·진행 작업을
합친 접수 상한이고 `maxPerOccurrence`는 한 요청에서 접수할 수 있는 새 작업 수다.
앱과 worker는 같은 큐 스키마 버전을 사용해야 한다. 큐 인덱스 변경을 포함한 업그레이드는 구버전
앱·worker의 작업 쓰기를 중단하고 migration을 완료한 뒤 새 버전을 시작한다. migration은 기존
대기 목록의 순서·작업 상태·lease·산출물 참조를 유지한다.
오디오 worker 번들은 외부 패키지 의존성까지 포함한다. HTTP 포트를 열지 않으므로 worker 컨테이너는
앱 이미지의 `/api/health` HEALTHCHECK를 그대로 상속하지 않도록 재정의한다. 컨테이너 실행 상태와
실제 작업 진행 상태는 별도로 확인한다.

원본·전사·요약은 기존 `S3_BUCKET_NAME`의 `source-files/` 경로를 사용하는 비공개 Artifacts다.
별도 원본 버킷 설정은 없으며 worker는 앱과 DB·S3 자격증명·암호화 키를 공유한다.
모델 채널과 ffmpeg 설정은 [CONFIGURATION.md](CONFIGURATION.md#오디오-전사-설정)를 따른다.
버킷의 versioning을 끄고 익명 읽기를 허용하지 않는다. `ARTIFACT_ACCESS_MODE`는
`authenticated` 또는 `proxied`를 사용하며 `public`에서는 비공개 파일 쓰기를 거절한다.
앱 설정은 S3의 공개 ACL·bucket policy를 변경하지 않으므로 운영자가 실제 비공개 접근을 확인한다.
스토리지 자격증명은 `artifacts/*`와 `source-files/*`를 읽고 쓰고 삭제할 수 있어야 한다.
일반 Artifact의 만료 규칙은 `artifacts/`에만 적용한다. `source-files/`의 파일별 만료와 삭제 표식은
worker가 관리하므로 이 경로에 객체 일괄 만료 규칙을 적용하지 않는다. 삭제 시 본문을 0바이트 표식으로 교체해 지연된 multipart
완료가 파일을 복원하지 못하게 한다. 이 표식에는 원본 bytes·파일명·URL을 저장하지 않는다.
프로세스 강제 종료로 남을 수 있는 multipart parts에는 별도 AbortIncompleteMultipartUpload
lifecycle을 설정한다. 백업·복제 저장소에도 같은 원본 보존 정책을 적용한다.
ffmpeg는 runtime 이미지에 포함돼 있다. 동시에 두 작업을 처리하므로 최대 입력·PCM 임시 파일에
맞는 메모리와 scratch volume을 할당한다. worker 중단 시 작업 lease가 만료된 후 다른 worker가 재개한다.
`SIGTERM`은 현재 작업을 중단하고 checkpoint를 남긴다. 필수 chat·sign-in 경로는 worker와 무관하다.

Agent 설정의 `parameters.audioProcessing=true`로 Agent 도구를 켠다. 저장소와 실행 사용자 문맥이 있어야
도구가 제공된다. 같은 Agent와 plugin skill로 수집·후처리·요청한 기록을 구성할 수 있다.
후처리는 선택한 Agent의 현재 설정을 작업 접수 시 snapshot으로 고정한다. 기본 결과는
비공개 Artifacts이며 외부 기록은 명시적으로 요청하거나 선택한 경우에만 수행한다. Memory delivery에는 수신 서버의
문서 수집·멱등 저장 도구가 필요하다. 오디오 처리 화면에서 작업 설정과 한도를 revision으로 저장한다.

## Workspace worker

Workspace는 선택 기능이다. `sandbox/Dockerfile`로 별도 실행 이미지를 만들고, 아래처럼
실행 이미지와 네트워크를 연결한다. Agent 설정에서 워크스페이스 도구를 켜고 Agent의 전용 탭에서
설정한다. 네이티브 Runtime 모델은 Settings → Models → 모델 사용 설정에서 선택한다. 일반 작업에는 저장소가 필요하지 않다.

```bash
docker build -t agent-studio-workspace:local sandbox
export WORKSPACE_IMAGE=agent-studio-workspace:local
export WORKSPACE_NETWORK=none
node --env-file=.env.local --import tsx scripts/workspace-worker.ts
```

Sandbox 이미지는 다음 개발 환경을 포함한다. 고정 버전은 `sandbox/Dockerfile`이 소유한다.

| 언어 | 기본 실행·개발 도구 |
|---|---|
| Java 25 (LTS) | JDK (`java`, `javac`, `jar`), Maven, Gradle |
| Python 3.14 | `python`, `python3`, pip, venv, uv/uvx, Poetry, build, pytest, Ruff |
| Go 1.27 | `go` (build/test/vet/mod), `gofmt`, cgo용 GCC·G++·Make·pkg-config |
| Node.js 24 (LTS) | npm/npx, Corepack, pnpm, TypeScript (`tsc`), tsx |

공통 도구는 Git, ripgrep, curl, zip/unzip이다. Python 개발 도구는 이미지의 별도 venv에 설치한다.
프로젝트 의존성은 `python3 -m venv --copies .venv`로 만든 쓰기 가능한 venv에 설치한다.
`--copies`는 저장된 Workspace에 이미지 바깥을 가리키는 Python 실행 파일 symlink가 들어가지 않게 한다.
루트 파일시스템에 패키지를 설치하지 않으며, 사용자 설치 실행 파일은 `~/.local/bin`과 `~/go/bin`에서 찾는다.

기본 pnpm 12의 네이티브 실행 파일과 이 저장소의 pnpm 11은 빌드 시 Corepack 캐시에 넣고
작업 시작 시 사용자 캐시로 복사한다. 포함된 도구의 시작은 다운로드에 의존하지 않는다.
프로젝트 의존성이나 wrapper가 지정한 다른 Maven·Gradle·pnpm
버전은 별도 준비가 필요하다. 폐쇄망에서는 내부 패키지 저장소 또는 사전 반입한 의존성을 사용한다.
Go의 자동 toolchain 다운로드는 기본적으로 끈다.

릴리스는 앱과 같은 ECR·GHCR 저장소에 `workspace-vX.Y.Z` tag의 Sandbox 이미지도 게시한다.
배포는 접근 권한이 있는 registry를 선택하고 이미지 pull에 해당 registry의 인증을 사용한다.
폐쇄망에는 앱과 해당 Sandbox 이미지를 함께 반입한다. `node build/workspace-health.cjs`는
설정·Docker resource controller·이미지·네트워크·모델 채널을 검사하며 `--worker`는 큐 heartbeat도 확인한다.

앱과 worker는 같은 PostgreSQL, `AES_ENCRYPTION_KEY`, Sandbox 인프라 설정을 사용한다. Agent·모델 설정은 공유 DB에서 읽는다. DB는 기존
migration 명령으로 먼저 준비한다. 배포 이미지는 `node build/workspace-worker.cjs`를 제공하며
Docker CLI도 포함한다. 실행 worker와 Git 승인 API가 있는 앱 서버는 같은 Docker daemon에
접근해야 한다. 이 제어 프로세스에는 전용 daemon 또는 Docker context를 사용한다. Sandbox에는 socket,
호스트 디렉터리나 운영 자격증명을 mount하지 않는다. 별도 worker의 HTTP healthcheck는 사용하지 않는다.

`none` 네트워크는 일반 스크립트의 무통신 실행에 사용한다. 모델·저장소 접속이 필요한 작업은
운영자가 egress 정책을 적용한 별도 Docker 네트워크를 지정한다. host/default bridge는 거절한다.
폐쇄망에서는 완성된 이미지와 의존성을 반입하고 내부 모델·저장소만 허용한다.
필수 부팅·로그인·Agent 실행은 이 설정과 worker에 의존하지 않는다.

worker는 실행 핸들, 출력 cursor, native Session, 검사 단계와 체크포인트를 저장한다.
저장소 접근은 관리자가 Agent의 Workspace 도구 탭에서 배포 기본값을 덮어쓸 수 있다.
고정 목록·소유자 지정·모든 저장소·신규 자동 허용을 선택하며, 정책 변경에 앱·worker 재배포는 필요하지 않다.
신규 모드는 Agent의 Workspace 생성 도구가 성공한 저장소를 자동 등록한다.
별도 큐가 Git 승인 결과와 CI 상태를 원래 Chat에 전달하고 SDK 이력으로 후속 실행을 시작한다. 중단된
worker는 동일 핸들을 이어서 관찰하며 불확실한 작업을 자동으로 다시 실행하지 않는다. TTL에는
체크포인트를 저장한 뒤 Sandbox를 삭제한다. worker를 중지하거나 설정을 제거하면 자동 TTL
정리가 실행되지 않으므로, 설정·Docker context 변경 전에 기존 Workspace를 종료하라.

`pnpm test:sandbox`는 Docker만, `pnpm test:workspace`는 Docker와 로컬 `_test` 데이터베이스를 사용한다.
Sandbox 검사는 네트워크 없이 uid 1000·읽기 전용 root에서 Java·Python·Go·Node.js 프로젝트의
컴파일·패키지 설치·테스트와 빌드 캐시 제외·설정 복원·Corepack 캐시 재생성을 확인한다.
`WORKSPACE_SANDBOX_IMAGE`로 검사 이미지를 지정할 수 있고 `WORKSPACE_TEST_AGENTS=true`는
세 CLI의 비특권 실행과 시작·재개 인자 파싱도 확인한다. 실제 모델 요청은 이 검사에서 보내지 않는다.

코딩을 켜려면 Agent의 Workspace 저장소 접근 정책에 저장소를 등록하고 작업 요청에
`repository: "owner/repo"`를 지정한다. GitHub App 또는
`WORKSPACE_GITHUB_AUTH=token`과 서버의 GitHub 계정 토큰을 설정한다. 계정 토큰 모드는 서버에서
bare Git 저장소와 bundle을 주고받고 저장소 코드를 실행하지 않는다. 배포 이미지에는 Git을
포함한다. App 설치 범위는 작업할 저장소로 한정한다. webhook URL은
`/api/workspaces/github/webhook`이며 Pull requests, Check runs, Check suites, Workflow runs
이벤트와 별도 webhook secret을 설정한다. main의 branch protection과 CI를 유지한다.
배포할 workflow는 `workflow_dispatch`를 지원해야 하며 `deploymentWorkflows`에 파일명을
명시한다. 예를 들어 `"deploymentWorkflows":["deploy.yml"]`이다. 배포 자격증명은 해당 workflow의
보호된 환경이 소유한다. Sandbox에는 전달하지 않는다.
`.github/workflows/*`를 새로 만들거나 바꾸는 push에는 classic 토큰의 `workflow` scope 또는
fine-grained 토큰·GitHub App의 Workflows 쓰기 권한도 필요하다. 저장소 생성·조회 성공만으로
이 권한을 확인할 수 없다. 거절된 push는 원격 브랜치 상태를 확인한 뒤 권한 수정과 새 검토를 거친다.

`pnpm test:workspace:git`는 무통신 Docker 안에 일회용 Git HTTP 저장소를 만들어 clone·권한·Diff·
승인 Commit·복원을 검증한다. GitHub App API와 승인 경합·webhook 중복은 단위 테스트로 검증한다.

## GitHub PR 자동 리뷰

관리자가 Agent 연동의 Webhook을 켜고 PR 리뷰 동작을 선택한다. 위의 서버 GitHub 연결을
재사용하며 Workspace worker는 필요하지 않다. App 인증은 대상 저장소의 Contents 읽기와
Pull requests 읽기·쓰기 권한이 필요하다. 계정 토큰은 같은 저장소를 읽고 리뷰 댓글을 작성할 수
있어야 한다. 자격 증명이나 GitHub 연결이 없으면 리뷰 게시를 활성화할 수 없다.

GitHub 저장소 Webhook에 `/api/webhook/{agent}` URL, `application/json`, 해당 Agent의
Webhook Secret과 Pull requests 이벤트를 설정한다. Workspace 메타데이터 Webhook과 URL·Secret이
다르다. 접근 가능한 모든 저장소 또는 정확한 저장소 목록 중 하나를 선택하며 기본은 일반 Webhook이다.
새 PR과 새 커밋, 다시 열린 PR, draft 해제를 처리하고 완료 이력에서 실제 리뷰 링크를 확인한다.
인터넷을 사용할 수 없는 설치에서는 접근 가능한 GitHub Enterprise API·웹 주소와 내부 호스트 허용
설정을 사용한다. GitHub 연결이 없는 설치의 일반 대화·Webhook 동작에는 영향이 없다.
한도·중복·게시 경합 계약은 [Trigger 설계](design/triggers.md#github-pr-리뷰)를 따른다.

## localdev

로컬 개발은 Docker Compose를 사용한다. OrbStack 또는 Docker Desktop의 Docker 엔진에서
루트 `compose.yaml`로 PostgreSQL·MinIO를 실행하고, 이 앱은 호스트에서 `pnpm dev`로
실행한다. Node 24와 pnpm 11을 설치하고:

```bash
test -f .env.local || cp .env.example .env.local
# 암호화 키와 사용할 로그인 값을 먼저 채운다.
docker compose up -d postgres minio minio-init
pnpm install --frozen-lockfile
pnpm dev
```

`.env.local`의 `DATABASE_URL`과 S3 연결 값은 `.env.example`의 Compose 기본값을 사용한다.
앱은 `localhost:5432`의 PostgreSQL과 `http://localhost:9000`의 MinIO에 연결하며,
`minio-init`이 `agent-studio` bucket을 만든다. 실행에 사용할 프로바이더 연결과 모델은
로그인 후 Settings에서 등록한다.
Chat·Workspace 입력의 Agent 추천을 사용하려면 OpenRouter 또는 System One 호환 내부
provider에서 Decisions 모델을 등록하고 Settings → Models → 모델 사용 설정에서 결정 모델로
선택한다. 선택하지 않으면 추천만 비활성화된다. 요청 텍스트는 PII 필터를 거쳐 선택한 provider에 전달되므로
폐쇄망 설치에서는 내부 endpoint를 사용한다.

호출 단위 자동 라우팅도 같은 결정 모델을 사용한다. Settings → Models → Model 사용 설정에서
내부 text 모델을 전역 tier에 배정하고 self-hosted 연결 제한을 설정한 뒤 필요한 Agent에서
사용 스위치를 켜면 사내 구성으로 사용할 수 있다. 공개 Jev 연결을
사용할 때 전달되는 정보는 작업 목적·제한된 요약·기능·예산·tier·예상 비용·주 모델 사용 여부다. 결정 모델이 없거나
오프라인이면 여러 후보의 선택은 주 모델로 fallback하며, 단일 후보는 결정 호출 없이 실행한다.
필수 실행 경로는 공개 인터넷에 의존하지 않는다.

MinIO 서버와 초기화용 `mc` 이미지는 Quay의 `minio` 저장소에서 받는다.
고정 릴리스 태그는 루트 `compose.yaml`이 정본이다.

루트 Compose 프로젝트 이름은 `agent-studio-local`로 고정되어 있다. PostgreSQL 18과 MinIO volume은
이 앱 전용이다. `docker compose down -v`는 이 로컬 데이터를 삭제하므로 주의한다.

Agent Plugins가 등록하는 사설 DNS 이름 그대로 MCP를 시험하려면 OrbStack에서:

```bash
cp deploy/local/.env.example deploy/local/.env
deploy/local/scripts/deploy.sh
```

`.env.local`에는 다음 suffix를 선언한다.

```dotenv
MCP_INTERNAL_HOST_SUFFIXES=agent-mcps.svc.cluster.local
```

자세한 내용은 [deploy/local/README.md](../deploy/local/README.md)를 보라.

## 배포 이미지

버전 tag는 release workflow가 `linux/amd64` 이미지로 ECR과 GHCR에 발행한다.

```text
ghcr.io/opspresso/agent-studio:vX.Y.Z
396608815058.dkr.ecr.ap-northeast-2.amazonaws.com/agent-studio:vX.Y.Z
```

Release workflow는 새 tag를 `argocd-env-demo`에 전달한다. Kubernetes manifest와 rollout은 그
저장소가 소유한다. IDC의 tag 선택과 배포는 `../dockpad`가 소유한다.

## 폐쇄망

부팅·로그인·런·콘솔은 public internet 없이 동작한다. 이미지는 외부에서 빌드해 사내 registry로
mirror하고, 모델은 `/settings/providers`에서 사내 endpoint를 등록한 뒤 `/settings/models`에서
공개 모델을 조회하거나 내부 self-hosted 모델을 직접 등록한다. Plugin은 `/plugins`에서 checkout archive를 업로드할 수 있다. 내부 URL과 MCP
주소는 각각 `URL_FETCH_INTERNAL_HOST_SUFFIXES`, `MCP_INTERNAL_HOST_SUFFIXES`에 선언한다.
공개 Provider의 모델 목록·가격은 연결 가능할 때 `models.opspresso.com/models.json`에서
갱신하며, 폐쇄망에서는 이미지에 포함된 검증된 스냅샷을 사용한다. 사내 모델 목록은
해당 내부 연결에서 조회한다. 스냅샷을 새로 포함하려면 외부에서 `pnpm sync-models`를 실행하거나
`pnpm sync-models --from <models.json>`으로 받은 파일을 적용해 이미지를 다시 빌드한다.
`PUBLISHED_MODELS_REFRESH=off`를 설정하면 런타임의 공개 API 접속 시도를 끄고 내장
스냅샷만 사용한다. 설정하지 않으면 15분 간격의 비동기 갱신을 시도한다.

문서 파서·생성기와 PDF용 한글 폰트는 앱 이미지에 포함된다. 별도 문서 MCP 서버나
런타임 다운로드는 필요 없다. 지원 형식과 워커 실행 제약은
[문서 엔진](design/documents.md)을 보라.

Agent Runtime은 앱에 포함된 OpenAI Agents SDK를 사용한다. SDK Session은 같은 PostgreSQL의
`runtime_sessions`에 저장하고 `AES_ENCRYPTION_KEY`로 인증 암호화한다. 공개 OpenAI trace
전송은 로컬 processor로 교체되어 사내 모델만으로 실행할 수 있다. 기존 ChatMessage는 화면
기록으로 보존하며 SDK Session의 모델 이력으로 자동 변환하지 않는다. 기존 대화에 SDK Session이
없거나 만료됐으면 새 모델 문맥에서 시작한다는 경고를 표시한다. 모델 이력이 필요한 새
대화는 현재 런타임에서 시작한다. 배포 교체 시 진행 중인 런을 먼저 drain하라.

## 데이터베이스 스키마

새 설치는 빈 PostgreSQL 데이터베이스에서 시작한다. 앱 또는 `pnpm db:migrate`가 advisory lock 아래
현재 스키마를 만들고 `schema_migrations`에 기준선 버전 10을 기록한다. 이미 데이터가 있으나 기준선이
확인되지 않는 DB는 자동으로 덮어쓰지 않고 부팅을 거부한다. 앱·audio worker·Workspace worker는
같은 스키마 버전과 암호화 키를 사용한다. 운영 백업과 배포·복구 절차는 [운영](OPERATIONS.md)을 따른다.

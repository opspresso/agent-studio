# 설치와 배포 소유권

Agent Studio 는 기업이 자기 네트워크 안에 설치해 운영하는 플랫폼이다. 이 저장소는 애플리케이션
이미지와 로컬 개발 환경만 소유한다. 실제 배포 정의는 배포 환경의 저장소가 소유한다.

| 환경 | 소유 위치 | 이 저장소가 제공하는 것 |
|---|---|---|
| localdev | 이 저장소의 `compose.yaml`, `deploy/local/` | 독립 `agent-studio-local` PostgreSQL 18·MinIO와 로컬 MCP 서버 |
| IDC | `../dockpad` | 릴리즈된 Agent Studio 이미지 |
| EKS/Kubernetes | `../argocd-env-demo` | 릴리즈된 Agent Studio 이미지 |

IDC Compose나 Kubernetes manifest를 이 저장소에 복사하지 않는다. 배포 설정, ingress, secret,
backup, rollout, ticker는 각 배포 저장소에서 관리한다.

## 필요한 런타임

- PostgreSQL 18 + pgvector. 앱이 부팅할 때 스키마를 적용하고 `vector` 확장을 만든다.
- OpenAI 호환 LLM endpoint.
- 32-byte base64 `AES_ENCRYPTION_KEY`.
- S3 호환 object store는 선택이다. 없으면 artifact 영속화와 `File` 도구가 꺼진다.
  첨부 문서의 텍스트 추출은 계속되지만 원본 보관·재열기·편집은 할 수 없다.
- production에서는 `STAGE`, `ADMIN_EMAILS`, 로그인 방식 하나가 추가로 필요하다.

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
계정 키를 자동 이관하지 않는다. 앱 로그아웃은 Studio 세션만 종료하며 Keycloak SSO 세션은
유지한다. 토큰 검증과 접근 제한은 [SECURITY.md](SECURITY.md#인증)를 따른다.

설정 항목의 의미는 [Keycloak OIDC 문서](https://www.keycloak.org/securing-apps/oidc-layers)와
[client 설정 문서](https://www.keycloak.org/docs/latest/server_admin/index.html#_oidc_clients)를 참고한다.

## 오디오 worker

오디오 전사는 선택 기능이다. HTTP 앱과 같은 이미지의 `node build/audio-worker.cjs`를 별도 process로
실행한다. 로컬 `.env.local`을 사용할 때는 `node --env-file=.env.local --import tsx scripts/audio-worker.ts`로 실행한다.
환경변수가 이미 주입된 환경에서는 `pnpm worker:audio`를 사용한다. DB 초기화는 앱 또는 기존 migration 명령으로
먼저 수행한다. worker는 카탈로그·self-hosted 선언을 주기적으로 갱신하고 작업과 원본 만료를 처리한다.
여러 파일은 DB 큐에 접수하며 프로젝트마다 한 건씩 순차 실행한다. `maxActive`는 대기·진행 작업을
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

버전의 `parameters.audioProcessing=true`로 Agent 도구를 켠다. 저장소와 실행 사용자 문맥이 있어야
도구가 제공된다. 같은 Agent와 plugin skill로 수집·후처리·요청한 기록을 구성할 수 있다.
후처리는 `published` 또는 고정 버전을 선택하고 작업 접수 시 snapshot으로 고정한다. 기본 결과는
비공개 Artifacts이며 외부 기록은 명시적으로 요청하거나 선택한 경우에만 수행한다. Memory delivery에는 수신 서버의
문서 수집·멱등 저장 도구가 필요하다. 오디오 처리 화면에서 작업 설정과 한도를 revision으로 저장한다.

## Workspace worker

Workspace는 선택 기능이다. `sandbox/Dockerfile`로 별도 실행 이미지를 만들고, 아래처럼
실행 이미지와 네트워크를 연결한다. Agent Version에서 워크스페이스 도구를 켜고 프로젝트 전용 탭에서
설정한다. 네이티브 Runtime 모델은 Models에서 선택한다. 일반 작업에는 저장소가 필요하지 않다.

```bash
docker build -t agent-studio-workspace:local sandbox
export WORKSPACE_IMAGE=agent-studio-workspace:local
export WORKSPACE_NETWORK=none
node --env-file=.env.local --import tsx scripts/workspace-worker.ts
```

Sandbox 이미지는 파일 검색용 ripgrep을 포함하며 네이티브 도구의 시작 시 다운로드에 의존하지 않는다.
릴리스는 앱과 같은 ECR·GHCR 저장소에 `workspace-vX.Y.Z` tag의 Sandbox 이미지도 게시한다.
배포는 접근 권한이 있는 registry를 선택하고 이미지 pull에 해당 registry의 인증을 사용한다.
폐쇄망에는 앱과 해당 Sandbox 이미지를 함께 반입한다. `node build/workspace-health.cjs`는
설정·Docker resource controller·이미지·네트워크·모델 채널을 검사하며 `--worker`는 큐 heartbeat도 확인한다.

앱과 worker는 같은 PostgreSQL, `AES_ENCRYPTION_KEY`, Sandbox 인프라 설정을 사용한다. 프로젝트·모델 설정은 공유 DB에서 읽는다. DB는 기존
migration 명령으로 먼저 준비한다. 배포 이미지는 `node build/workspace-worker.cjs`를 제공하며
Docker CLI도 포함한다. 실행 worker와 Git 승인 API가 있는 앱 서버는 같은 Docker daemon에
접근해야 한다. 이 제어 프로세스에는 전용 daemon 또는 Docker context를 사용한다. Sandbox에는 socket,
호스트 디렉터리나 운영 자격증명을 mount하지 않는다. 별도 worker의 HTTP healthcheck는 사용하지 않는다.

`none` 네트워크는 일반 스크립트의 무통신 실행에 사용한다. 모델·저장소 접속이 필요한 작업은
운영자가 egress 정책을 적용한 별도 Docker 네트워크를 지정한다. host/default bridge는 거절한다.
폐쇄망에서는 완성된 이미지와 의존성을 반입하고 내부 모델·저장소만 허용한다.
필수 부팅·로그인·기존 프로젝트 실행은 이 설정과 worker에 의존하지 않는다.

worker는 실행 핸들, 출력 cursor, native Session, 검사 단계와 체크포인트를 저장한다.
저장소 접근은 관리자가 Project Settings → Workspace 저장소 접근에서 배포 기본값을 덮어쓸 수 있다.
고정 목록·소유자 지정·모든 저장소·신규 자동 허용을 선택하며, 정책 변경에 앱·worker 재배포는 필요하지 않다.
신규 모드는 Agent의 Workspace 생성 도구가 성공한 저장소를 자동 등록한다.
별도 큐가 Git 승인 결과와 CI 상태를 원래 Chat에 전달하고 SDK 이력으로 후속 실행을 시작한다. 중단된
worker는 동일 핸들을 이어서 관찰하며 불확실한 작업을 자동으로 다시 실행하지 않는다. TTL에는
체크포인트를 저장한 뒤 Sandbox를 삭제한다. worker를 중지하거나 설정을 제거하면 자동 TTL
정리가 실행되지 않으므로, 설정·Docker context 변경 전에 기존 Workspace를 종료하라.

`pnpm test:sandbox`는 Docker만, `pnpm test:workspace`는 Docker와 로컬 `_test` 데이터베이스를 사용한다.
`WORKSPACE_SANDBOX_IMAGE`로 검사 이미지를 지정할 수 있고 `WORKSPACE_TEST_AGENTS=true`는
세 CLI의 비특권 실행도 확인한다. 실제 모델 요청은 이 검사에서 보내지 않는다.

코딩을 켜려면 같은 설정의 프로젝트에 `repository: "owner/repo"`를 추가하고 GitHub App 또는
`WORKSPACE_GITHUB_AUTH=token`과 서버의 GitHub 계정 토큰을 설정한다. 계정 토큰 모드는 서버에서
bare Git 저장소와 bundle을 주고받고 저장소 코드를 실행하지 않는다. 배포 이미지에는 Git을
포함한다. App 설치 범위는 작업할 저장소로 한정한다. webhook URL은
`/api/workspaces/github/webhook`이며 Pull requests, Check runs, Check suites, Workflow runs
이벤트와 별도 webhook secret을 설정한다. main의 branch protection과 CI를 유지한다.
배포할 workflow는 `workflow_dispatch`를 지원해야 하며 `deploymentWorkflows`에 파일명을
명시한다. 예를 들어 `"deploymentWorkflows":["deploy.yml"]`이다. 배포 자격증명은 해당 workflow의
보호된 환경이 소유한다. Sandbox에는 전달하지 않는다.

`pnpm test:workspace:git`는 무통신 Docker 안에 일회용 Git HTTP 저장소를 만들어 clone·권한·Diff·
승인 Commit·복원을 검증한다. GitHub App API와 승인 경합·webhook 중복은 단위 테스트로 검증한다.

## localdev

Node 24와 pnpm 11을 설치하고:

```bash
cp .env.example .env.local
docker compose up -d postgres minio minio-init
pnpm install
pnpm dev
```

루트 compose project 이름은 `agent-studio-local`로 고정되어 있다. PostgreSQL 18과 MinIO volume은
Agent Studio 전용이다. `docker compose down -v`는 이 로컬 데이터를 삭제하므로 주의한다.

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

버전 tag는 release workflow가 `linux/amd64`와 `linux/arm64`를 지원하는 multi-platform 이미지를
ECR과 GHCR에 발행한다.

```text
ghcr.io/opspresso/agent-studio:vX.Y.Z
396608815058.dkr.ecr.ap-northeast-2.amazonaws.com/agent-studio:vX.Y.Z
```

Release workflow는 새 tag를 `argocd-env-demo`에 전달한다. Kubernetes manifest와 rollout은 그
저장소가 소유한다. IDC의 tag 선택과 배포는 `../dockpad`가 소유한다.

## 폐쇄망

부팅·로그인·런·콘솔은 public internet 없이 동작한다. 이미지는 외부에서 빌드해 사내 registry로
mirror하고, 모델은 사내 OpenAI 호환 LLM·embedding·reranker endpoint를 사용한다. 모델 catalog는 `/models`에서 문서를
업로드할 수 있고, plugin은 `/plugins`에서 checkout archive를 업로드할 수 있다. 내부 URL과 MCP
주소는 각각 `URL_FETCH_INTERNAL_HOST_SUFFIXES`, `MCP_INTERNAL_HOST_SUFFIXES`에 선언한다.

문서 파서·생성기와 PDF용 한글 폰트는 앱 이미지에 포함된다. 별도 문서 MCP 서버나
런타임 다운로드는 필요 없다. 지원 형식과 워커 실행 제약은
[문서 엔진](design/documents.md)을 보라.

Agent Runtime은 앱에 포함된 OpenAI Agents SDK를 사용한다. SDK Session은 같은 PostgreSQL의
`runtime_sessions`에 저장하고 `AES_ENCRYPTION_KEY`로 인증 암호화한다. 공개 OpenAI trace
전송은 로컬 processor로 교체되어 사내 모델만으로 실행할 수 있다. 기존 ChatMessage는 화면
기록으로 보존하며 SDK Session의 모델 이력으로 자동 변환하지 않는다. 기존 대화에 SDK Session이
없거나 만료됐으면 새 모델 문맥에서 시작한다는 경고를 표시한다. 모델 이력이 필요한 새
대화는 현재 런타임에서 시작한다. 배포 교체 시 진행 중인 런을 먼저 drain하라.

## 데이터 이관

v0.86 이전 DynamoDB 배포는 `scripts/import-dynamodb-export.ts`로 PostgreSQL에 이관한다.
`AES_ENCRYPTION_KEY`와 `BETTER_AUTH_SECRET`은 기존 값을 유지해야 저장된 credential과 session을
계속 읽을 수 있다. Object는 배포 저장소가 소유하는 migration 절차로 대상 S3-compatible store에
옮긴다. Capability catalog는 복사하지 않고 `/api/catalog/reindex`로 다시 만든다.
페이지로 나눈 scan 파일은 한 번의 명령에 모두 넘긴다. 이관기는 전체 파일을 하나의 transaction으로
처리하고 모든 user를 session·account보다 먼저 써서 page 경계가 참조 순서를 바꾸지 못하게 한다.

이관기는 새 배포에서 그대로 쓰면 위험한 두 설정을 의도적으로 제거한다. managed MCP 의 옛
`envRefs` 는 더 이상 지원하지 않는 호스트 파일 참조이고,
`artifactAccessMode` 는 이전 object store 의 도달성에 대한 답이므로 새 환경에서 다시 정해야 한다.
같은 이메일로 새 DB에 먼저 만들어진 사용자가 있으면 export 의 원래 사용자 id 와 참조를 보존하기
위해 그 행을 교체한다. 실행 결과가 제거·교체 건수를 출력하므로 이관 뒤 반드시 확인하라.

## 업그레이드

새 image tag로 교체하면 앱이 부팅 시 advisory lock 아래에서 schema migration을 적용한다. 별도
migration job은 필요하지 않다. Rollback은 image tag를 되돌리는 것이며 schema를 내리지 않는다.
IDC와 EKS의 구체적인 upgrade 및 rollback 명령은 각 배포 저장소가 소유한다.

Better Auth 1.7.4 이상은 계정을 `providerId + accountId`로 찾는다. Migration 7은 기존
`account.issuer`의 값과 컬럼을 보존하면서 `NOT NULL`과 issuer 기반 인덱스를 제거하고,
provider 계정 키의 unique index를 만든다. 중복 키가 있으면 어떤 계정도 변경하지 않고
실패한다. 서로 다른 issuer가 같은 provider ID를 쓴 경우 운영자가 신뢰할 수 있는 ID 매핑을
확인해 충돌을 해결해야 한다. 로컬 설정을 쓰는 개발 서버에는
`pnpm tsx --env-file=.env.local scripts/db-migrate.ts`를 적용한 뒤 재시작한다.
[Better Auth 업그레이드 가이드](https://better-auth.com/docs/guides/1-7-upgrade-guide)를 따른다.

이전 `SOURCE_FILES_BUCKET_NAME`에 파일이 있으면 worker와 새 작업 접수를 멈추고 진행 중인 업로드를
정리한 뒤 `source-files/`의 키·본문·metadata를 `S3_BUCKET_NAME` 버킷으로 복사한다. 0바이트 삭제
표식도 포함하며 대상 파일의 checksum과 metadata를 검증한다. DB의 파일 ID·저장 시각·보존 기한은
변경하지 않는다. 복사 확인 후 이전 환경변수를 제거하고 새 앱·worker를 시작한다. 원본 버킷 삭제는
별도 운영 작업이며 업그레이드 과정에서 자동 삭제하지 않는다.

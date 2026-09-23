# Agent Studio

기업이 자기 네트워크 안에 설치해 운영하는 AI 에이전트 플랫폼이다. Project를 Agent로 만들고, 현재 모델·프롬프트·도구 설정을 저장해 콘솔·API·메신저·자동화에서
호출한다. Studio가 권한·자격 증명·비용·기록을 관리하고 OpenAI Agents SDK가 모델 턴과 도구 실행을 담당한다.

한 설치가 한 기업의 경계다. 사내 PostgreSQL, 모델 엔드포인트와 로그인 수단으로 구성하면
공개 인터넷 없이 부팅·로그인·실행·콘솔을 사용할 수 있다. 외부 모델과 SaaS 연동은 선택 사항이다.
현재 개발 중이며 API·설정·스키마의 하위 호환을 보장하지 않는다.

## 할 수 있는 일

| 영역 | 제공하는 기능 | 상세 계약 |
|---|---|---|
| Projects와 Agent 설정 | 현재 설정 편집·실행, 이미지 생성·편집 도구 | [실행](docs/design/execution.md) |
| 모델 | Provider 연결·선택 모델 관리, 기능·가격 비교, fallback, 자체 호스팅과 Embedding·Rerank·Transcription·Decisions | [설정](docs/CONFIGURATION.md#llm-채널) |
| Skills·Memory·검색 | 필요한 지침과 참고 파일 로드, Plugin 동기화, capability 검색, 연결된 MCP의 장기 Memory 회상 | [Capabilities](docs/design/capabilities.md) |
| MCP·하위 Agent | Agent별 도구·헤더 binding, 프로젝트별 OAuth, Docker 관리형 MCP, Handoff·Agent-as-Tool·외부 Agent | [MCP](docs/design/mcp.md), [SDK 적용 범위](docs/design/sdk-capabilities.md) |
| Chat | 비공개 대화, 암호화된 SDK Session, 도구 승인·거절·재개, 연결이 끊겨도 계속되는 실행 | [Chat](docs/design/chat.md) |
| 문서·이미지·Artifacts | 첨부 추출, 문서 생성·검사·편집, 이미지 생성·편집, 결과 보관·다운로드·격리된 HTML 미리보기 | [문서](docs/design/documents.md), [Artifacts](docs/design/execution.md#artifacts) |
| 오디오 | 원본 가져오기·업로드, 비동기 전사·Agent 후처리, 비공개 결과와 요청한 개인 기록 | [오디오](docs/design/audio-processing-spec.md) |
| Workspace·Sandbox | 영속 파일·Git·native CLI Session, command·Codex·Claude·OpenCode 실행, Git 검토·승인, 원래 Chat으로 결과 전달 | [Workspace](docs/design/workspaces.md) |
| 실행 연동 | Predict, OpenAI 호환 Chat Completions, Agent SSE, Slack·Telegram·Teams, Webhook·Schedule | [API](docs/API.md), [메시징](docs/design/messaging.md) |
| 운영·보안 | 프로젝트·호출자 비용, 동시 실행·시간 제한, Trace·Audit·메트릭, 접근 제어·시크릿 암호화·SSRF 방어·선택적 PII 필터 | [운영](docs/OPERATIONS.md), [보안](docs/SECURITY.md) |

각 기능의 활성화 조건은 다르다. 기본 실행에는 PostgreSQL과 LLM 채널이 필요하고, 파일 보관에는
S3 호환 저장소가 필요하다. 오디오·Workspace는 각각 별도 worker를 실행해야 한다.
설치 조건은 [INSTALL.md](docs/INSTALL.md)에 모았다.

## 로컬에서 시작하기

로컬 개발은 **Docker Compose**를 사용한다. OrbStack 또는 Docker Desktop의 Docker 엔진에서
PostgreSQL·MinIO를 실행하고, Agent Studio는 호스트에서 `pnpm dev`로 실행한다.
Node.js 24와 프로젝트가 고정한 pnpm 11을 준비한다.

```bash
corepack enable
corepack prepare pnpm@11.24.0 --activate
pnpm install --frozen-lockfile
test -f .env.local || cp .env.example .env.local
```

`.env.local`에 32바이트 base64 `AES_ENCRYPTION_KEY`를 설정한다.
`DATABASE_URL`과 S3 연결 값은 `.env.example`의 Compose 기본값을 사용한다. 실제 로그인에는
`BETTER_AUTH_SECRET`과 Keycloak·표준 OIDC·Google·비밀번호 중 사용할 수단도 설정한다.

```bash
docker compose up -d postgres minio minio-init
pnpm dev
```

`http://localhost:3000`에서 시작한다. 스키마는 앱 부팅 시 적용된다. LLM이나 신원 제공자가 없는
개발 환경에는 [mock 모델과 개발 세션](docs/DEVELOPMENT.md#실제-자격-증명-없이-작업하기)을 사용한다.
이미 설정 파일이 있다면 복사로 덮어쓰지 말고 필요한 항목을 추가한다.
실행 전 관리자가 Settings → Models에서 프로바이더 연결과 사용할 모델을 등록하고 기본 모델을
선택한다. 세부 절차는 [모델 등록과 사용](docs/CONFIGURATION.md#모델-등록과-사용)을 따른다.

루트 Compose의 `agent-studio-local`은 전용 PostgreSQL·MinIO volume을 소유한다.
`docker compose down -v`는 개발 데이터를 삭제한다.
로컬 MCP, 별도 worker와 환경파일 로딩 방법은 [개발 문서](docs/DEVELOPMENT.md)를 따른다.

## 첫 프로젝트와 외부 호출

1. member 이상 계정으로 Projects에서 Agent 프로젝트를 만든다.
2. Playground에서 모델·시스템 프롬프트를 설정하고 필요한 Skill·MCP·하위 Agent를 연결한다.
3. 현재 설정을 저장하고 요청을 실행한다. 저장한 내용은 다음 실행부터 적용된다.
4. 영속 대화는 Chat에서, 외부 실행 예제는 프로젝트의 API Reference 탭에서 확인한다.

Project → Integrations에서 발급한 API token은 해당 프로젝트 실행에 쓰는 Bearer credential이다.
사용자 로그인 세션과 승인 화면을 만들지는 않는다. 로그인한 사용자, 프로젝트 토큰, 메신저와
자동화는 같은 Agent 설정을 사용해도 권한·이력·승인 경로가 다르다.
[실행 API](docs/API.md#실행)와 [실행 창구별 계약](docs/design/workspaces.md#실행-창구별-계약)을 확인하라.
콘솔의 `/guide`는 첫 프로젝트부터 파일·오디오·Workspace 사용까지 안내한다.

## 문서 읽기

| 목적 | 읽을 문서 |
|---|---|
| 제품과 개념을 한 번에 파악하기 | [시스템 개요](docs/AGENT_STUDIO.md) — 검색·RAG에도 사용할 수 있는 통합 지도 |
| 현재 기능과 사용 조건 | [기능 목록](docs/FEATURES.md) |
| 설치·폐쇄망·worker 구성 | [INSTALL](docs/INSTALL.md) |
| 로컬 개발·검증·기여 | [DEVELOPMENT](docs/DEVELOPMENT.md) |
| 코드의 계층·저장소·실행 경로 | [ARCHITECTURE](docs/ARCHITECTURE.md), [DIAGRAMS](docs/DIAGRAMS.md) |
| 서브시스템의 동작과 제약 | [설계 문서 색인](docs/ARCHITECTURE.md#서브시스템) |
| HTTP 요청·응답·인증 | [API](docs/API.md) |
| 환경변수·기본값·고정 한계 | [CONFIGURATION](docs/CONFIGURATION.md) |
| 프로브·배포·보존·장애 대응 | [OPERATIONS](docs/OPERATIONS.md) |
| 인증·인가·시크릿·개인정보 경계 | [SECURITY](docs/SECURITY.md) |
| 코드에서 각 결정을 소유하는 위치 | [OWNERSHIP](docs/OWNERSHIP.md) |
| 미완료 작업과 완료 조건 | [MILESTONES](docs/MILESTONES.md) |
| 코딩 에이전트의 작업 규칙 | [AGENTS.md](AGENTS.md) (`CLAUDE.md`는 이 파일의 symlink) |

개요에는 개념과 연결 관계를, 상세 문서에는 계약과 제한을 둔다. 설정값은 CONFIGURATION,
HTTP 형태는 API, 실행 원리는 해당 설계 문서에서 확인한다.

## 개발과 배포

Next.js 16 App Router·React 19·TypeScript strict·Mantine 9 기반의 단일 풀스택 앱이다.
Better Auth가 인증을 담당하며 PostgreSQL + pgvector에 상태를 저장한다.
[Clean Architecture](docs/ARCHITECTURE.md#레이어)를 바탕으로 모듈의 책임을 분리하고,
의존 방향 `app → application → domain ← infrastructure`는 구조 테스트로 강제한다.
정확한 의존성 버전은 [package.json](package.json)과 [잠금 파일](pnpm-lock.yaml)이 정본이다.

변경은 [모듈 경계와 재사용](docs/ARCHITECTURE.md#모듈-경계와-재사용),
[근본 원인 중심의 개선](docs/DEVELOPMENT.md#근본-원인-중심의-개선) 원칙을 따른다.

```bash
pnpm typecheck
pnpm test
pnpm test:integration   # 로컬의 전용 *_test PostgreSQL만 사용
pnpm build
```

lint 단계는 없다. 현재 CI의 자동 검사 범위와 별도로 실행할 worker·브라우저·Sandbox 검사는
[DEVELOPMENT.md](docs/DEVELOPMENT.md#ci)에 명시한다.

배포 산출물은 standalone 앱과 worker를 포함한 컨테이너 이미지이며 Workspace Sandbox 이미지는
별도로 만든다. IDC 배포 정의는 `dockpad`, EKS/Kubernetes는 `argocd-env-demo` 저장소가 소유한다.
이 저장소는 애플리케이션·이미지·로컬 개발 환경을 관리한다.
이미지 반입부터 ticker·스토리지 보존까지는 [설치](docs/INSTALL.md)와
[운영 체크리스트](docs/OPERATIONS.md#운영-체크리스트)를 따른다.

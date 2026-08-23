# ✨ Agent Studio

**기업이 자기 네트워크 안에서 AI 에이전트를 만들고 운영하는 플랫폼.**
모델·스킬·MCP·워크플로·트레이싱·평가·거버넌스를 한곳에 두고 프롬프트·에이전트·비용을 관리한다.

**설치형이다.** 고객에게 파는 SaaS 가 아니라 기업이 자기 IDC·VPC 에 올려 쓰는 소프트웨어이고,
한 설치가 한 기업을 담는다. 부팅·로그인·런·콘솔은 외부 네트워크 없이 동작하며 밖으로 나가는
연결은 전부 선택이다. 그것이 무엇을 강제하는지는
[ARCHITECTURE.md](docs/ARCHITECTURE.md#무엇을-위한-시스템인가) 에, 폐쇄망에서 무엇을 대신하는지는
[INSTALL.md](docs/INSTALL.md#폐쇄망air-gapped에서) 에 있다.

프롬프트나 에이전트를 **project** 로 만들고, **version** 으로 다듬고, 하나를 publish 한
뒤 어디서든 호출한다. 호출 창구는 콘솔, OpenAI 호환 엔드포인트, Slack, Telegram, Teams,
webhook, A2A 로 연결된 다른 에이전트, AG-UI 로 임베드한 앱이다. 모든 런은 귀속되고, 값이
매겨지고, 경계가 지어진다.

## 무엇이 들어 있나

| | |
|---|---|
| **Projects & versions** | 세 가지 project type 이 있다. `llm`(단발성 프롬프트), `agent`(멀티턴 tool 루프), `image`(생성/편집). Version 은 이름 붙인 스냅샷이고 고치면 그 자리에서 덮어쓴다. 포인터가 publish 된 것을 가리킨다. |
| **LLM engine** | 모든 provider 에 대해 하나의 OpenAI 호환 프로토콜. 멀티턴 tool 루프, subagent transfer, 턴별 예산, 1회 재시도 fallback, 어디서나 스트리밍. |
| **Skills** | 필요할 때 로드되는 마크다운 동작 지침. 시스템 프롬프트는 이름/설명 표만 담는다. Agent Plugins 저장소에서 sync 할 수 있다. |
| **MCP tools** | MCP 서버의 공유 레지스트리. 버전별 binding 이 tool 목록을 좁히고 아웃바운드 헤더를 덮어쓸 수 있다. Managed 서버와 OAuth 를 지원한다(아래). |
| **Agents** | 다른 project 를 로컬 subagent 로 쓰거나, 외부 OpenAI 호환 / A2A 엔드포인트를 원격 subagent 로 쓴다. |
| **Chats** | agent project 를 상대로 하는 소유자별 비공개 대화. tool 트래픽과 이미지가 보존된다. |
| **Cost dashboard** | project 별·model 별 일일 지출과 caller 별 귀속. project 카탈로그를 공유하므로 caller 축이 필요하다. |
| **Guards** | project 별 일일·월간 비용 임계값, caller 별 동시 실행 제한, 모든 런에 걸리는 벽시계 데드라인. |
| **Integrations** | project 별 Slack·Telegram·Teams 봇, webhook trigger, 양방향 A2A, 사용자 앱을 위한 AG-UI. |

## 스택

- Node.js 24, pnpm 11
- Next.js 16 (App Router), React 19, TypeScript strict
- Mantine 9 (컴포넌트 + 테마)
- Better Auth 1.7 (표준 OIDC(Keycloak · Entra ID · Okta …), Google, 또는 비밀번호)
- Clean Architecture (`domain` / `application` / `infrastructure` / `app`), 테스트로 강제된다
- PostgreSQL + pgvector 하나에 모든 행과 케이퍼빌리티 카탈로그. 아티팩트는 S3 호환 스토어(선택)

설치 방법은 [docs/INSTALL.md](docs/INSTALL.md) 에 있다. 호스트 하나(Compose)든 Kubernetes(Helm)든
최소 구성은 PostgreSQL 하나와 OpenAI 호환 엔드포인트 하나다.

## 빠른 시작

```bash
# 1. Install
corepack enable && corepack prepare pnpm@11.22.0 --activate
pnpm install

# 2. Environment
cp .env.example .env.local
# LLM_BASE_URL, LLM_API_KEY, AES_ENCRYPTION_KEY (32바이트 base64) 를 채우고,
# 실제 로그인이 필요하면 BETTER_AUTH_SECRET 과 로그인 방식 하나(OIDC / Google / 비밀번호)도 채운다.

# 3. Local PostgreSQL (스키마는 앱이 부팅 때 만든다)
docker compose up -d postgres

# 4. Run
pnpm dev            # http://localhost:3000
```

쓸 수 있는 LLM provider 나 신원 제공자가 없다면 `scripts/mock-llm.ts` 와
`scripts/dev-session.ts` 가 둘 다 대신한다.
[docs/DEVELOPMENT.md](docs/DEVELOPMENT.md#실제-자격-증명-없이-작업하기) 를 보라.

> PostgreSQL 컨테이너는 **이 머신의 다른 모든 프로젝트와 공유된다**. 포트가 아니라
> 데이터베이스 이름이 그것들을 갈라 놓으므로 `docker compose down -v` 는 절대 실행하지 마라.
> 자세한 내용은 [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md#로컬-postgresql) 에 있다.

```bash
pnpm typecheck      # tsc --noEmit (strict)
pnpm test           # Vitest
pnpm build          # production build
```

lint 단계는 없다. `typecheck` + `test` + `build` 가 검사다.

## 문서

| 문서 | 무엇에 답하나 |
|---|---|
| [docs/INSTALL.md](docs/INSTALL.md) | 설치. 호스트 하나(Compose), Kubernetes(Helm), 폐쇄망에서의 대체 경로, AWS 배포에서 옮겨 오기 |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | 어떻게 만들어졌고 **왜** 그런가. 레이어, 아이템 테이블 키 맵, 진입점에서 엔진까지의 경로 |
| [docs/DIAGRAMS.md](docs/DIAGRAMS.md) | 같은 모양을 그림으로. 레이어, 요청 흐름, 런 브래킷, 메시징 표면, wiring site, 스토리지 |
| [docs/design/](docs/design/) | 서브시스템마다 파일 하나. 엔진, MCP, 메시징 표면(Slack, Telegram, Teams), capability, trigger, chat, 기록, A2A |
| [docs/OWNERSHIP.md](docs/OWNERSHIP.md) | 소유 파일이 하나씩 정해진 모든 결정. `tests/architecture.test.ts` 가 강제한다 |
| [docs/API.md](docs/API.md) | 모든 HTTP 라우트와 그 인증, 그리고 요청/응답 형태 |
| [docs/CONFIGURATION.md](docs/CONFIGURATION.md) | 모든 환경변수, 그리고 코드에 고정된 한계값 |
| [docs/OPERATIONS.md](docs/OPERATIONS.md) | 배포, 프로브, 스케일링, 보존, 알림 |
| [docs/SECURITY.md](docs/SECURITY.md) | 인증, 인가, 시크릿, SSRF, PII |
| [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) | 로컬 셋업, 스크립트, 테스트, CI |
| [docs/MILESTONES.md](docs/MILESTONES.md) | 남은 작업 (한국어) |
| [AGENTS.md](AGENTS.md) | 코딩 에이전트를 위한 작업 규칙 (`CLAUDE.md` 는 이 파일의 심볼릭 링크다) |

## 기능 둘러보기

### 바깥에서 project 호출하기

각 project 의 **API Reference** 탭이 그 방법을 보여 준다. project 자신의 이름과 publish 된
버전이 채워져 있고, 엔드포인트마다 복사할 수 있는 curl 예제가 있다. 실행 엔드포인트는
`predict`, `chat/completions`(OpenAI 호환), `agent`(SSE) 셋이고, 설정돼 있다면
A2A·Slack·Telegram·Teams 엔드포인트가 더해진다.

**Project → Integrations → API token** 에서 토큰을 발급해 세션 쿠키 대신
`Authorization: Bearer <token>` 으로 보내라. 토큰은 그 project 로 범위가 한정되며 소유자로
인증된다. 전체 계약은 [docs/API.md](docs/API.md#실행) 에 있다.

### 여러 LLM provider

모든 트래픽은 OpenAI Chat Completions 프로토콜을 쓰고, model id 는 `provider/model` 이다.
기본적으로 모든 id 는 `LLM_BASE_URL`(OpenRouter 나 LiteLLM 같은 라우터)로 간다. provider 를
직접 호출하려면 provider 별 채널을 등록하라.
[docs/CONFIGURATION.md](docs/CONFIGURATION.md#llm-채널) 를 보라.

### Skills

Skill 은 [Agent Plugins](https://agent-plugins.org/) 저장소(`PLUGINS_REPO`)에서 sync 된다.
각 플러그인은 Agent Skills 스펙에 따라 `skills/<name>/SKILL.md` 에 skill 을 선언하고, 그
옆에 streamable-HTTP 서버들의 `mcp.json` 을 둔다. skill 디렉터리 아래의 보조
파일(`references/*.md`, 템플릿)은 첨부로 수집되어 `Skill` 도구의 `file_path` 를 통해 필요할
때 로드된다. 플러그인이 선언하는 모든 이름은 저장소가 소유한다. 그 이름 중 하나로 손수
등록된 항목은 흡수되어 저장소의 버전으로 맞춰지고, 어떤 플러그인도 선언하지 않는 이름만
그대로 남는다.

### MCP tools

`/tools` 에서 서버를 한 번 등록하고 어느 버전에서든 bind 한다. binding 은 tool 목록을
좁히고 레지스트리의 헤더 위에 자기 헤더를 덧입힐 수 있어, 공유 서버 하나가 서로 다른 자격
증명으로 여러 project 를 서빙한다.

**Managed 서버.** Agent Studio 는 Docker 로 자기 호스트에서 MCP 서버 컨테이너를 띄우고
loopback 으로 도달할 수 있다. 그래서 공개 엔드포인트가 없는 서버도 쓸 수 있다. 부팅 시
버려진 컨테이너를 자동으로 복구하는데, 이 앱을 교체하는 일이 그것들을 깨뜨리기 때문이다.
`MANAGED_MCP_RUNTIME` / `MANAGED_MCP_REGISTRY` 로 설정하며, 설정하지 않으면 기능이 꺼진다.

**OAuth.** admin 이 레지스트리 항목에 대해 discovery 를 돌리고(RFC 9728 → RFC 8414), 그
다음 각 project 가 그 항목에 대한 **자기 자신의** 자격 증명을 갖는다. 그래서 공유 항목
하나가 project 마다 다른 provider 앱을 서빙할 수 있다. PKCE S256, RFC 8707 `resource`,
RFC 9207 `iss` 가 모두 강제된다. [docs/SECURITY.md](docs/SECURITY.md#mcp-oauth) 를 보라.

### 이미지

**입력.** `chat/completions` 는 OpenAI content part 를 받고, Slack 멘션의 첨부는 내려받아
같은 방식으로 보내며, 콘솔의 작성기는 턴당 이미지 4장까지(각 5MB,
`png`/`jpeg`/`gif`/`webp`) 받는다. 버전의 model 이 `imageInput` capability 를 가져야 하고,
없으면 그림을 조용히 잃는 대신 요청이 거부된다.

**생성과 편집.** `image` project 는 직접 그리고, 소스 이미지가 첨부되면 대신 편집한다.
agent 런은 빌트인 `GenerateImage` 도구로 그릴 수 있고 `EditImage` 로 기존 이미지를 바꿀 수
있으며, 둘 다 버전의 `imageGeneration` 파라미터로 켠다. `EditImage` 는 런별
핸들(`img_1`, `img_2`, …)로 이미지를 지칭한다. 핸들은 사용자가 보낸 것과 런이 그린 것을 모두
아우르므로 "이제 밤으로 만들어 줘" 가 어느 쪽에도 통하고, subagent transfer 를 타고 넘어가므로
에이전트가 그림을 전용 image project 에 넘겨도 다시 그리지 않고 *편집* 하게 할 수 있다.

### Webhook

모든 project 는 webhook 을 하나씩 갖는데, **Project Settings → Webhook** 이 켜기 전까지는
꺼져 있다. 바깥 시스템은 시크릿과 함께 JSON 을 POST 해서 런을 시작한다.

```bash
curl -X POST https://<host>/api/webhook/my-project \
  -H "X-Trigger-Secret: $WEBHOOK_SECRET" \
  -H "Idempotency-Key: $EVENT_ID" \
  -d '{"event":"nightly-report"}'
```

언제나 **publish 된** 버전을 실행하고, 즉시 `202` 로 답한 뒤 백그라운드에서 돌며,
`Idempotency-Key` 로 24시간 동안 중복을 제거하고, 기본적으로 겹치는 런을 거부한다.
비활성·중복·사용 중·publish 된 버전 없음 같은 모든 거부는 상태를 가진 history 행으로 남으므로,
로그를 읽지 않고도 "아예 발화하지 않았다" 와 "발화했는데 실패했다" 를 구분할 수 있다.
[docs/API.md](docs/API.md#triggers) 를 보라.

### Slack

각 agent project 는 자기 Slack 앱을 가질 수 있다. **Project → Integrations → Slack bot** 이
project 전용 매니페스트를 만들고, 그 project 의 URL 로 오는 이벤트는 자기 signing secret
으로 검증되며 언제나 그 project 를 실행하므로 선택기가 필요 없다. 답변은 메시지 하나로
스트리밍되고, 스레드 안의 멘션은 그 스레드를 컨텍스트로 함께 나르며, 이미지 첨부는
분석된다.

Slack 의 **Agents** 기능을 켜면 앱이 그 표면에 네이티브로 답한다. 에이전트 컨테이너를 열면
project 의 추천 프롬프트(최대 네 개, 같은 설정 패널에서 편집)가 보이고, 진행 상황은 답변을
편집하는 방식 대신 도구 이름을 하나씩 부르는 Slack 자체의 상태 줄로 나타나며, 새
스레드는 그것을 연 질문으로 제목이 붙고, 답변은 진짜 Slack 텍스트 스트림이다. 스트리밍을
쓸 수 없는 곳에서는 메시지 하나를 편집하는 방식으로 후퇴한다.

### Telegram

각 agent project 는 자기 Telegram 봇도 가질 수 있고, Slack 과 같은 파이프라인 위에 있다.
**Project → Integrations → Telegram bot** 이 @BotFather 에서 받은 토큰을 받아 Telegram 으로
확인하고, 봇을 켜면 Telegram 이 매 전달마다 되돌려 주는 시크릿과 함께 이 배포에 webhook 을
등록한다(끄면 삭제한다).
개인 채팅에서 봇은 모든 메시지에 답하고, 그룹에서는 멘션되거나 답장을 받았을 때 답한다.
Telegram 에는 스트리밍도 스레드 히스토리도 없으므로 답변은 그 자리에서 편집되는 메시지
하나다. Telegram 의 4,096자를 넘으면 다음 메시지로 이어지고, 렌더링은 끝에 한 번 한다.
대화의 최근 턴들은 일주일 동안 보관되어 후속 질문이 그 앞의 질문을 함께 나른다.
[docs/design/telegram.md](docs/design/telegram.md) 를 보라.

### Microsoft Teams

세 번째 봇 표면이다. Azure Bot(Bot Framework)을 등록하고 **Project → Integrations → Microsoft
Teams bot** 에 Microsoft App ID 와 클라이언트 시크릿을 붙여 넣은 뒤, Azure 에서 봇의 messaging
endpoint 를 콘솔이 보여 주는 URL 로 가리킨다. 배달마다 Bot Framework 가 서명한 토큰이 인증의
전부이며, 서명·발급자·audience·`serviceUrl` 을 확인한다. 개인 채팅에서는 모든 메시지에, 채널과
그룹 채팅에서는 @멘션되었을 때 답하고, 답은 Teams 가 네이티브로 그리는 Markdown 으로 제자리에서
편집되며, 그림은 메시지 안에 inline 으로 간다. 대화의 최근 턴은 Telegram 과 같은 방식으로
보관된다. [docs/design/teams.md](docs/design/teams.md) 를 보라.

### A2A (Agent2Agent)

[A2A 프로토콜](https://a2a-protocol.org)의 양방향을 모두 지원한다. **인바운드**:
`A2A_API_KEY` 를 설정하거나 Settings 에서 이름 붙인 클라이언트 키를 발급하면, publish 된
버전이 있는 모든 project 가 공개 Agent Card 와 JSON-RPC 엔드포인트를 서빙한다.
**아웃바운드**: 프로토콜을 `A2A` 로 하고 Agent Card URL 을 적어 에이전트를 등록한 뒤, 원격
subagent 로 쓴다.

아웃바운드 URL 은 운영자가 제공하고 SSRF 가드를 거치지만 공개 URL 이면 무엇이든 허용되므로,
신뢰하는 에이전트만 등록하라.

### PII 필터링

버전별로 opt-in 한다. 이메일, 전화번호, 주민등록번호·외국인등록번호, 그리고 결제 카드
번호가 어떤 LLM 호출보다 앞서 되돌릴 수 있고 형식을 보존하는 토큰으로 치환되며, 응답에서
복원된다. 스트리밍에도 적용되므로 모델은 실제 값을 보지 못한다. regex 기반이라 그
엔티티들만 다루고, **연결된 MCP 서버가 받는 것은 마스킹하지 않는다**. 이 기능에 기대기 전에
[docs/SECURITY.md](docs/SECURITY.md#pii-필터링-그리고-그것이-멈추는-곳) 를 읽어라.

### 비용, 귀속, 그리고 가드

모든 런은 **누가 그것을 일으켰는지** 를 trace 와 caller 별 일일 usage 행에 기록한다. 사용자,
project 토큰(그 소유자로서), Slack 사용자, webhook, schedule, 인바운드 A2A 가 그 대상이다.
project 카탈로그를 공유하므로 project 이름만으로는 "누가 이걸 썼나" 에 답할 수 없다.

각 project 는 UTC 일과 UTC 월 두 윈도에 **alert** 임계값(한 번 알리고 계속 실행)과 **block**
임계값(윈도가 넘어갈 때까지 모든 런을 `Retry-After` 와 함께 거부)을 걸어 둘 수 있다. 멤버
자신의 tier 도 그의 월 지출에 상한을 건다. 그와 별개로 `MAX_CONCURRENT_RUNS_PER_ACTOR` 가
한 caller 가 동시에 얼마나 많은 런을 진행할 수 있는지를 제한한다. 각 가드가 무엇을 제한하고
무엇을 제한하지 않는지는
[docs/OPERATIONS.md](docs/OPERATIONS.md#지출-가드와-부하-가드) 에 있다.

## 배포

빌드 산출물은 컨테이너 이미지다.

```bash
docker build -t agent-studio .        # 멀티스테이지, Next standalone 출력
docker compose up --build             # 로컬 컨테이너 + PostgreSQL (+ --profile objects 로 MinIO)
```

이미지는 `NODE_ENV=production` 을 설정하고, 이것은 명시적인 `STAGE` 없이는 부팅을 거부한다.
compose 서비스는 그 값을 `.env.local` 에서 읽는다(`.env.example` 에는 `STAGE=local`).

버전 태그(`v*`)는 `ghcr.io/opspresso/agent-studio` 와 ECR 에 빌드·푸시하고 GitOps 배포를
트리거한다. 설치 방법은 [docs/INSTALL.md](docs/INSTALL.md) 에 있다. 호스트 하나의 Docker
Compose(`deploy/idc/`)와 Kubernetes 의 Helm 차트(`deploy/helm/agent-studio`) 두 가지다.
로드 밸런서는 `/api/ready` 를, 재시작 검사는 `/api/health` 를 가리키게 하고, `/api/metrics` 를
스크랩하며, `SCHEDULE_SCAN_TOKEN` 으로 티커를 켜라. 만료 행을 쓸어내는 것이 그 틱이다.
운영 체크리스트는 [docs/OPERATIONS.md](docs/OPERATIONS.md#운영-체크리스트) 에 있다.

실서비스는 IDC 호스트 하나 위의 Docker Compose 인 **alpha** 이고, Kubernetes 쪽 **prod** 는
차트만 있고 클러스터는 현재 없다. 무엇을 나누고 무엇을 나누지 않는지는
[docs/OPERATIONS.md](docs/OPERATIONS.md#두-환경-alpha-와-prod) 에 있다.

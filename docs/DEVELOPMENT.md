# 개발

Agent Studio 를 로컬에서 셋업하고, 실행하고, 검증하는 방법.

관련 문서: 모든 변수는 [CONFIGURATION.md](CONFIGURATION.md), 테스트가 강제하는 레이어 규칙은
[ARCHITECTURE.md](ARCHITECTURE.md), 변경이 지켜야 하는 관례는
[../AGENTS.md](../AGENTS.md) 를 보라.

## 사전 준비

- **Node.js 24+** (`engines: >=24`)
- **pnpm 11.24.0**, `packageManager` 로 고정 (정확한 pin 은 package.json 이 정본). 전역 설치 대신 corepack 을 쓴다
- **Docker** (PostgreSQL(pgvector) 용, artifact 를 시험한다면 MinIO 도)

```bash
corepack enable && corepack prepare pnpm@11.24.0 --activate
pnpm install
```

## 환경

```bash
cp .env.example .env.local
```

실제 런에 필요한 최소값은 `DATABASE_URL`, `LLM_BASE_URL`, `LLM_API_KEY`,
`AES_ENCRYPTION_KEY`(32바이트 base64, `openssl rand -base64 32`) 다. `src/instrumentation.ts`
가 이들을 부팅 시점에 검증하므로, 빠진 값이 있으면 첫 요청이 아니라 기동 단계에서 실패한다.
신원 제공자(OIDC · Google · 비밀번호)는 실제 로그인에만 필요하다. `STAGE=local` 은 하나도
없이 부팅하고, 아래의 dev-session 스크립트가 로그인을 우회한다.

전체 목록은 [CONFIGURATION.md](CONFIGURATION.md) 를 보라.

## 로컬 PostgreSQL

```bash
docker compose up -d postgres minio minio-init # PostgreSQL 18 + MinIO + bucket
pnpm dev                             # http://localhost:3000 — 스키마는 부팅 때 앱이 만든다
pnpm db:migrate                      # 앱을 띄우지 않고 스키마만 적용 (CI, 첫 부팅 전)
```

`.env.example` 의 `DATABASE_URL`(`postgres://agent_studio:agent_studio@localhost:5432/agent_studio`)
이 이 컨테이너를 가리킨다. 스키마는 `src/infrastructure/db/migrations.ts` 가 부팅 때 advisory
lock 아래에서 멱등하게 적용하므로 따로 만들 것이 없다. pgvector 확장도 거기서 만든다.
고정 개발 자격 증명을 쓰는 PostgreSQL 과 MinIO 포트는 호스트 loopback 에만 공개된다.

`compose.yaml`은 `agent-studio-local` project에 PostgreSQL 18과 MinIO 전용 volume을 만든다.
Agent Memory는 별도 project와 포트를 사용하므로 서로 독립적으로 시작하고 종료할 수 있다.
`docker compose down -v`는 Agent Studio의 로컬 데이터를 삭제하므로 명시적 확인 없이 실행하지 마라.

`.env.example` 의 기본 object-store 설정은 Agent Studio MinIO(:9000, console :9001)를 가리킨다.
`minio-init`이 `agent-studio` bucket을 멱등하게 만든다.

## 로컬 MCP (deploy/local)

기본 셋업에는 MCP 가 없다: 레지스트리가 등록하는 MCP URL 은 클러스터 DNS 이름이라 로컬에서
해석되지 않고, plugins sync 는 그 서버들을 전부 `invalid-url` 로 스킵한다.
[deploy/local/](../deploy/local/README.md) 은 그 이름들을 network alias 와 OrbStack 커스텀
도메인으로 단 MCP 컨테이너들을 docker compose 로 띄워, 호스트의 `pnpm dev` 가 같은 레지스트리
행으로, 실제 배포와 같은 경로로 MCP dispatch 까지 테스트하게 한다. `.env.local` 에
`MCP_INTERNAL_HOST_SUFFIXES=agent-mcps.svc.cluster.local` 한 줄이 필요하다.

## 실제 자격 증명 없이 작업하기

```bash
# 모의 OpenAI 호환 LLM 서버; 그다음 LLM_BASE_URL=http://127.0.0.1:8002/v1 로 설정
pnpm tsx scripts/mock-llm.ts

# 개발용 사용자 + 세션을 만들고 서명된 세션 쿠키를 출력
pnpm tsx --env-file=.env.local scripts/dev-session.ts

# 샘플 skill 시드 (같은 이름의 기존 skill 은 건드리지 않는다)
pnpm tsx --env-file=.env.local scripts/seed-skills.ts
```

## 명령

```bash
pnpm dev              # 문서 워커 번들 후 next dev
pnpm build            # 문서 워커 번들 + 프로덕션 빌드 (standalone) — 라우트 핸들러 + instrumentation 검증
pnpm start            # 이미 만든 Next.js production build 실행
pnpm typecheck        # tsc --noEmit, strict + 추가 검사 (아래)
pnpm test             # vitest run
pnpm test:documents   # 실제 자식 프로세스로 생성·추출·검사·편집 검증 (DB 불필요)
pnpm test:watch       # vitest watch
pnpm exec playwright install chromium # HTML 실행 미리보기 테스트용 브라우저
pnpm test:html-preview # 로컬 HTTP fixture에서 실제 Chromium 기능·격리 검사
pnpm test:integration # 로컬 PostgreSQL(agent_studio_test) 에 대한 리포지토리 + 엔진 검사
pnpm test:storage     # 로컬 MinIO 임시 bucket의 원본 파일 streaming·조건부 저장·삭제 검사
pnpm test:audio       # ffmpeg로 실제 MP3 분할·WAV 크기·시간 범위·임시 파일 정리 검사
pnpm test:audio:pipeline # PostgreSQL test DB·MinIO·ffmpeg·로컬 ASR mock을 통한 전체 전사 경로
pnpm worker:audio     # 별도 오디오 worker. 앱이 DB를 초기화한 뒤 실행
pnpm db:migrate       # DATABASE_URL 의 데이터베이스를 현재 스키마로 (db:migrate:test 는 테스트 DB)
pnpm check-models     # 카탈로그 스냅샷과 이 배포의 채널이 서빙하는 것의 차이
pnpm sync-models --from path/to/models.json # 로컬 카탈로그로 갱신 (원격은 MODELS_CATALOG_URL 설정)
```

```bash
# 테스트 파일 하나, 또는 테스트 이름으로
pnpm exec vitest run tests/engine.test.ts
pnpm exec vitest run -t "streamWithFallback"
```

**lint 단계는 없다**. ESLint 설정 자체가 존재하지 않는다. 검사는 `typecheck` + `test` 다.
`build` 가 세 번째다: 잘못된 라우트 핸들러 시그니처나 깨진 instrumentation import 를 잡아내는
것이 이 단계다.

`typecheck` 가 lint 자리를 대신하므로 `tsconfig.json` 은 `strict` 위에
`noUncheckedIndexedAccess`, `noUnusedLocals`, `noUnusedParameters`, `noImplicitReturns`,
`noImplicitOverride`, `noFallthroughCasesInSwitch`, `verbatimModuleSyntax` 를 켠다. 죽은 import,
빠진 return, switch fallthrough 는 여기서 잡힌다 — 별도 린터를 두는 대신이다.

## 스크립트

| 스크립트 | 용도 |
|---|---|
| `scripts/db-migrate.ts` | `DATABASE_URL` 의 데이터베이스를 현재 스키마로 올린다. 앱이 부팅 때 하는 것과 같은 마이그레이션이고, CI 나 첫 부팅 전에 앱 없이 돌리는 형태다. |
| `scripts/dev-session.ts` | 개발용 사용자와 세션을 Better Auth 의 테이블에 바로 써 넣고 서명된 세션 쿠키를 출력한다. 신원 제공자 왕복 없이 인증이 필요한 라우트를 시험한다. 로컬이 아닌 `DATABASE_URL` 은 거부한다. |
| `scripts/mock-llm.ts` | `127.0.0.1:8002` (`MOCK_LLM_PORT`) 에서 도는 독립 실행형 OpenAI 호환 mock 서버. 스트리밍과 비스트리밍을 모두 지원하고, 도구가 제공되고 *동시에* 메시지가 `skill named "<slug>"` 를 언급할 때 `Skill` 도구 호출을 한 번 요청한다. `MOCK_LLM_CHUNKS` 와 `MOCK_LLM_DELAY_MS` 는 답변을 부풀리고 늦춰 긴 스트리밍 응답으로 만든다. 답이 도착하는 동안 chat 창이 무엇을 하는지 볼 수 있는 유일한 방법이다. 기본값은 통합 체크가 기대하는 한 줄 답변을 유지한다. |
| `scripts/seed-skills.ts` | 샘플 Skill 을 멱등하게 시드한다. |
| `scripts/integration-check.ts` | 저장소 왕복 전 구간 + 엔진(단발 실행과 agent 루프). |
| `scripts/check-models.ts` | 카탈로그 스냅샷(`src/domain/llm/catalog.json`)을 *이 배포의* 채널들이 서빙하는 id 와 대조한다. agent-models 가 provider 의 공개 카탈로그는 스스로 보므로, 여기서 보는 것은 게이트웨이·Bedrock·키의 범위 같은 이 배포만의 차이다. |
| `scripts/sync-models.ts` | 발행된 카탈로그로 스냅샷을 갱신한다 (`--check` 는 뒤처졌으면 1 로 종료, `--from <file>` 은 URL 대신 로컬 카탈로그 문서를 읽는다, `MODELS_CATALOG_URL` 이 없거나 `none` 인 환경에서는 이것이 필수다). 런타임은 카탈로그를 직접 읽으므로, 테스트가 새 모델을 봐야 하거나 릴리즈 전일 때 돌린다. |
| `scripts/import-dynamodb-export.ts` | 일회성 이관: AWS CLI 로 내보낸 옛 DynamoDB 테이블(`aws dynamodb scan … --output json`)을 이 스키마로 들여온다. `AUTH#` 행은 Better Auth 의 테이블로, 유니크 락 행은 버리고, 나머지는 같은 키로 `items` 에 upsert 한다. 지원하지 않는 managed MCP host-file `envRefs` 와 저장소 종속 `artifactAccessMode` 는 제거하고, 같은 이메일로 먼저 생긴 사용자는 export 의 원래 id 를 보존하기 위해 교체한다. 절차는 [INSTALL.md](INSTALL.md#데이터-이관). |

### `check-models`

레지스트리는 [agent-models](https://github.com/opspresso/agent-models) 가 관리하고 provider
의 공개 카탈로그를 매일 대조한다 ([CONFIGURATION.md](CONFIGURATION.md#모델-레지스트리-agent-models-의-카탈로그)).
그것이 볼 수 없는 것은 *이 배포의* 채널이다. `LLM_BASE_URL` 의 게이트웨이, Bedrock 경로, 일부
모델만 닿는 키. 이 스크립트는 그 차이를 본다: 채널이 서빙하지만 레지스트리에 없는 id (agent-models
에 추가할 후보), 레지스트리에 있지만 어떤 채널도 서빙하지 않는 id (이 배포에서 쓸 수 없는 것).
전용 `EMBEDDING_BASE_URL`과 `RERANKER_BASE_URL`도 독립 채널로 확인한다. OpenRouter는 기본
`/models`가 text 중심이므로 `output_modalities` 필터로 image, embeddings, rerank, transcription을
각각 추가 조회한다.

```bash
pnpm check-models              # 양방향 보고; 차이 자체로는 실패하지 않음
pnpm check-models --since=90d  # 최근 90일 안에 출시된 모델만
pnpm check-models --strict     # 제공되던 라우트가 사라졌거나 검사가 실행되지 못했으면 1 로 종료
```

`--strict` 는 **제공되던 라우트가 사라졌을 때**, 그리고 **실행되지 못한 검사**에서 실패한다.
뒤쪽은 응답하지 않은 채널이 하나라도 있을 때, 그리고 모든 채널이 답했지만 그중 아무도
`provider/model` 형태의 id 를 주지 않았을 때다. 뒤의 경우는 채널 구성의 문제이지 카탈로그의
문제가 아닌데, 그것을 구별하지 않으면 레지스트리 전체가 은퇴 후보로 출력된다.

앞쪽에서 두 가지가 빠진다. 답이 이미 정해져 있어 소식이 아니기 때문이다.

- **채널이 없는 provider 의 라우트**. 물어본 적이 없는 것이지 provider 가 내린 것이 아니다.
  `google/*` 이 그렇다(어떤 배포도 `LLM_PROVIDER_GOOGLE_*` 을 설정하지 않는다). 별도 목록으로
  보고된다. provider 채널이 하나도 없으면 default 채널이 모든 id 를 받으므로 이 제외는 비어 있다.
- **`hidden` 라우트**. 이 앱이 이미 은퇴시킨 것이다. `models.ts` 는 그 항목을 일부러 영구히
  남긴다(과거 런의 usage 행이 거기서 가격을 찾는다, 지우면 이력이 $0 으로 다시 매겨진다).
  그래서 "hidden 인데 서빙되지 않는다"는 은퇴의 문서화된 종착점이지 발견이 아니다.

또한 provider 가 **자기 항목에 선언한 별칭**은 서빙된 것으로 인정한다. xAI 는 정식 id 만
나열하고 나머지 철자를 `aliases` 에 담아서, 살아 있는 `grok-4.20`(= `grok-4.20-0309-reasoning`)
과 `grok-code-fast-1`(= `grok-build-0.1`)이 그것 없이는 은퇴 후보로 읽힌다.

반면 서빙되지만 등록되지 않은 id 에서는 의도적으로 **실패하지 않는다**: 그 목록은 provider 의
전체 카탈로그에서 이 앱이 골라 담은 선택(realtime, 내부 코드네임)을 뺀 것이라,
그것으로 게이팅하면 결코 초록이 될 수 없는 종료 코드가 된다. `--since` 는 그 목록을 읽는
사람을 위해 좁힐 뿐 게이팅하지 않는다. 라우터 채널은 계속 모델을 내놓기 때문에(OpenRouter 는
최근 7일에만 새 id 5개를 올렸고 그중 이 앱이 담을 만한 것은 없었다) 7일로 좁힌 형태도 같은
성질이다. 새 모델은 보고서로 남고, 사람이 읽고 판단한다.

`sigv4` 채널은 런타임이 디스패치할 때 쓰는 것과 같은 서명자를 통해 읽으므로, Bedrock 채널에는
환경에 AWS 자격 증명이 있어야 한다 (로컬에서는 `AWS_PROFILE=opspresso`). 없으면 실패한 채널로
보고된다. 라우터 채널은 본질적으로 미등록 목록을 길게 만든다: OpenRouter 는 수백 개의 id 를
서빙하므로, 그쪽 절반을 읽을 때는 `--since` 를 쓰라.

## 통합 체크

```bash
docker compose up -d postgres
pnpm test:integration
```

이 검사는 같은 서버의 **별도** 데이터베이스 `agent_studio_test` 를 상대로 돈다. 픽스처를 쓰고
그것을 cascade 로 지우기 때문이다. `--env-file=.env.local` 을 넘기지 마라. 스크립트는 기본
`DATABASE_URL` 을 스스로 갖고 있고, 호스트가 로컬이 아니거나 이름이 `_test` 로 끝나지 않는
데이터베이스는 실행을 거부한다. 스키마는 검사가 시작할 때 스스로 적용한다(`migrate()`), 그래서
`init` 단계가 따로 없다.

이 검사가 vitest 밖에 사는 이유는 실제 네트워크와 실제 스토리지가 필요하기 때문이고, 그 둘은 모든
단위 테스트가 건드리는 것이 금지된 대상이다.

## CI

`.github/workflows/ci.yml`은 모든 branch push에서 실행된다. 별도 `html-preview` job은
Chromium을 설치하고 HTML 실행·중지·입력 및 격리 경계를 검증한다. 기본 검증 순서는 다음과 같다:

```
typecheck → test → test:integration → build → standalone 격리 → 문서 워커 smoke test → production server smoke test
```

`pgvector/pgvector:0.8.6-pg18-trixie` 서비스 컨테이너가 `POSTGRES_DB=agent_studio_test` 로 호스트 포트
`5432` 에 뜬다. 통합 체크가 기본값으로 접속하는 주소이고 이름이 `_test` 로 끝나므로 그 가드를
지난다. job 마다 새로 뜨는 컨테이너는 비어 있고, 검사가 자기 스키마를 적용하므로 워크플로에 설정할
것이 없다.

빌드 뒤 standalone 산출물을 저장소 밖의 임시 디렉터리로 복사하고 Dockerfile 과 같이
`public` 및 `.next/static` 을 더한다. 그 디렉터리에서 실제 문서 워커의 생성·추출·검사·편집을
검증해 번들과 폰트가 배포 산출물에 포함되는지 확인한다. 마지막 smoke test 는 같은
디렉터리에서 `node server.js`로 production 서버를 실행한다.
`/api/health`, 첫 화면, 로고, 대표 JavaScript chunk 의 200을 확인한다. 하류 상태를 보는
`/api/ready` 가 아니라 liveness 를 쓰므로 mock LLM 서버는 필요 없다. 프로세스가 먼저 끝나거나
30초 안에 응답하지 않으면 서버 로그를 출력하고 실패한다.

CI는 최소 `contents: read` 권한의 일회용 GitHub-hosted runner에서 실행하고 checkout credential을
작업 트리에 남기지 않는다. PR 검사는 base 저장소의 branch에 push된 commit에 붙은 CI 상태를
사용한다. 검토 전 branch 코드는 사내망에 연결된 persistent runner에 도달하지 않는다.
시크릿이 필요한 `check-models`는 default branch의 schedule에서만, release는 `v*` tag push에서만
GitHub-hosted `ubuntu-24.04` runner를 쓴다. 임의 ref를 선택하는 `workflow_dispatch`는 두 workflow 모두 제공하지
않는다.

`.github/workflows/check-models.yml` 은 `pnpm check-models --strict --since=7d` 를 pull request
마다가 아니라 스케줄(cron `0 23 * * 0-4`, 일–목 23:00 UTC)로 돌린다: 살아 있는 provider API 와 저장소 시크릿이
필요하기 때문이다(드리프트는 런이 실패하기 전에 Slack 으로 전송된다). provider 장애나 시크릿 없는
fork 가 PR 을 실패시켜서는 안 된다. 각 provider 요청은 30초에 중단되고 job 전체는 20분으로
제한되어, 멈춘 채널 하나가 결과와 Slack 알림을 무기한 막지 못한다.

**이 job 의 채널은 배포의 채널과 같아야 한다.** `LLM_BASE_URL` / `LLM_API_KEY` 만 주면 default
채널 하나로 도는데, 이 배포에서 그것은 라우터가 아니라 provider 자신의 엔드포인트라 맨 id 를
서빙한다. 비교되는 것이 하나도 없고, 등록된 모든 모델이 은퇴 후보로 보고된다. 그래서 차트가
쓰는 provider 채널 다섯이 여기에도 설정돼 있다: `LLM_PROVIDER_{OPENAI,ANTHROPIC,XAI,OPENROUTER}_API_KEY`
시크릿과, 키가 아니라 OIDC 로 서명하는 Bedrock (`github--agent-studio-models` 역할, 권한은
`bedrock-mantle:ListModels` 하나뿐). base URL 은 시크릿이 아니라 워크플로에 평문으로 있다.

## 테스트

단위 테스트는 `tests/` 아래에 산다. 관례:

- **경계에서 mock 한다.** `fetch` 는 `vi.stubGlobal` 로, 아이템 스토어는
  `vi.mock("@/infrastructure/db/store", () => createFakeStore())` 로. `tests/fakeStore.ts` 는
  실제 스토어와 같은 표면·같은 의미(바이트 순서 정렬 키, 저장된 행에 대한 조건, 같은 에러
  이름)를 가진 인메모리 구현이고, `tests/setup.ts` 가 모든 테스트 파일에 기본으로 설치하면서
  커넥션 풀도 소켓을 열지 않는 스텁으로 바꾼다. 행을 심거나 들여다봐야 하는 파일은 자기
  `vi.mock` 을 선언해 참조를 쥔다. application 코드를 테스트하려고 application 코드를 mock
  하지 마라.
- **결정적이어야 한다.** 진짜 `Date.now`, 타이머, 난수, 네트워크는 쓰지 않는다. 엔진이 이렇게
  테스트 가능한 것은 필요한 모든 것이 주입되기 때문이다. `tests/fakeChannel.ts` 를 보라.
- 실제 스토리지를 상대로 한 저장소 동작은 vitest 파일이 아니라 `scripts/integration-check.ts` 에
  속한다.

### `tests/architecture.test.ts`

이것이 구조 게이트이고, 경고하는 대신 요란하게 실패한다. 강제하는 것:

1. **레이어 규칙 열세 개**, 각각 **빈 허용 목록**을 갖는다. `domain` 은 다른 무엇도, 프레임워크·
   `pg`·AWS SDK·인증 라이브러리도 import 하지 않는다(domain 과 표준 라이브러리뿐이다).
   `application` 은 `infrastructure` 나 `app` 을,
   `lib` 의 순수 leaf 를 넘어선 무엇도, 도메인과 표준 라이브러리 바깥의 무엇도 import 하지 않는다.
   `infrastructure` 는 `application` 이나 `app` 을 import 하지 않는다. `shared` 는 자기 형제를 빼면
   `@/` 에서 아무것도, 표준 라이브러리 바깥의 어떤 패키지도 import 하지 않는다. 어댑터와 use case
   는 composition root 를 import 하지 않는다. `app` 은 자기 wiring site 바깥에서 `infrastructure`
   를 import 하지 않는다. `lib` 은 자기 wiring 모듈 바깥에서 `infrastructure` 를, composition root
   바깥에서 `application` 을 import 하지 않는다. `components` 는 `infrastructure` 나 `application`
   을 import 하지 않는다.
2. **단일 소유자 불변식**. 이름 붙인 결정과 그것을 소유한 파일. 사본이 하나 더 생기면 실패하고,
   *소유자가 정의를 잃어도 마찬가지로 실패한다*. 목록은 [OWNERSHIP.md](OWNERSHIP.md) 다.
3. **한정된 호출자 목록**. 소유자가 아니라 고정된 호출 지점 집합을 갖는 세 결정을 위한 것이다:
   어느 표면이 이미지 런을 시작하는가(`IMAGE_RUN_ENTRY_POINTS`), 어느 표면이 `executeAgent` 를
   직접 불러 agent 런을 시작하는가(`AGENT_RUN_ENTRY_POINTS`), 그리고 버전의 도구가 어디서 resolve
   되는가(`TOOL_RESOLUTION_SITES`, 각 지점은 `discoveryQueries` 도 함께 명시해야 한다. 그것 없이
   resolve 하면 capability discovery 가 조용히 꺼진다). 여기에 런의 바이트가 어디서 캡처되는가
   (`ARTIFACT_CAPTURE_SITES`)가 더해지고, 이것은 캡처까지 하지 않는 `openRun` 호출자를 실패시키는
   두 번째 검사와 짝을 이룬다. 잊어버린 다섯 번째 진입점은 자기 출력을 조용히 흘려버릴 것이다.
   이 목록들에 항목이 더해지는 것은 의도적인 행위이고, 목록이 사는 값이 바로 그것이다.
4. **두 출력 축은 함께 다닌다**. `EngineChunk.image` 를 읽는 모듈은 `EngineChunk.file` 도 읽는다.
   목록이 아니라 짝짓기로 강제하며, 주제가 정말로 한 축뿐인 모듈은 이름으로 예외 처리한다. raw
   chunk 로 답하는 모든 라우트는 둘 다 주소로 바꾸는지 검사된다.
5. **모델이 고른 URL**. 정확히 하나의 어댑터만 그것을 가져오고, 그 어댑터는 `skipsUrlGuard` 를
   절대 import 하지 않으며(거기서 내부 호스트 예외를 존중하면 프롬프트 인젝션 한 번이 클러스터
   내부 서비스에 대한 읽기로 바뀐다), 이 배포의 자격 증명은 아무것도 붙이지 않는다.
6. **달러 금액은 절대 손으로 쓰지 않는다**. `formatUsd`/`formatBytes` 를 뺀 `app` 어디에도
   `${…toFixed(…)}` 는 없다. 합계가 `$0.0043` 인 행들 위에 대시보드가 총계로 `$0.00` 을 보여 준 적이
   있는데, 그게 그 이유다. `app` 으로 범위를 한정한 것은 소유자에 닿을 수 있는 곳이 거기이기
   때문이다: 비용 가드는 `application` 에서 달러를 포맷하는데, 그 레이어는 `@/app` 을 import 할 수
   없다.
7. **조립**. 라우트가 더 이상 조립하지 않는 저장소는 어떤 라우트 핸들러에도 닿지 않고, `app` 은
   자기 wiring site 에서만 조립하며, application 슬라이스 그래프에는 순환이 없고, composition root
   는 선택적인 `ExecutionDeps` 필드를 전부 이름으로 결정한다.
8. **설정 읽기**. `process.env` 는 domain, shared, 어댑터, use case 어디에서도 닿지 않는다. 설정은
   주입되어 도착한다. 파일 하나가 이름으로 예외 처리돼 있고, 그 예외 자체가 여전히 참인지도
   검사된다.
9. **클라이언트 번들**. `"use client"` 진입점이 전이적으로 닿을 수 있는 범위. 진입점 개수는 단지
   비어 있지 않다는 정도가 아니라 정확한 수로 단언한다. 눈이 멀어 버린 스캔은 깨끗한 통과와 똑같이
   읽히기 때문이다.
10. **React 이벤트 처리**, 규칙 두 개. `setState` 업데이터 안에서 `currentTarget` 을 읽지 않는다.
   핸들러가 반환되면 React 가 `SyntheticEvent.currentTarget` 을 null 로 만들기 때문에, 미뤄진 읽기는
   React 가 배칭할 때마다 throw 한다. 그리고 `<Text>` 나 `<Title>` 안에 블록 루트를 갖는 Mantine
   컴포넌트(`Badge`, `Group`, `Stack`, …)를 두지 않는다. 그것들은 `<p>`/`<h*>` 를 렌더하는데,
   브라우저는 그 안에서 `<div>` 가 열리는 자리에서 그 태그를 *닫아* 버리므로 서버의 HTML 과 React 의
   트리가 어긋나 hydration 이 실패한다. 안쪽에 `component="span"` 을, 또는 바깥쪽에
   `component="div"` 를 주는 것이 해법이고 규칙이 찾는 것도 그것이다.
11. **Edge 런타임 호환성**. `node:crypto`, `pg`, AWS SDK 처럼 edge 가 구현하지 않는 것을
    `instrumentation.ts`·`proxy.ts` 의 edge 번들로 끌어들일 import.
12. **생성 모달은 자기가 선언한 것을 초기화한다**. 생성 모달이 `useState` 로 들고 있는 모든 필드는
    `onCreated()` 전에 비워지므로, 다시 연 모달이 직전 항목의 값을 보여 주는 일이 없다.
13. **스캐너 자신의 테스트**. 조용히 매칭을 멈춘 규칙을 잡아내기 위해서다.
14. **요청 본문 할당**. JSON 라우트는 파싱 전에 공용 바이트 상한을 적용하고, 큰 본문을
    `request.json()` 으로 먼저 메모리에 올리지 않는다.
15. **응답 타입의 소유권**. 브라우저 모듈은 producer 가 선언한 response 타입을 type-only 로
    import하며, 비교하는 양쪽을 스캐너가 실제로 읽었는지도 확인한다.
16. **런 종료 분류**. deadline과 호출자 취소를 합성하는 모든 지점이 같은 종료 판정을 사용한다.
17. **카탈로그 재색인 직렬화**. production 의 모든 reindex 가 composition root 의 설치 전역 lease 를
    지나고, 우회 호출이 생기면 실패한다.
18. **추론 fold**. `reasoningContent` 를 모으는 고정 지점만 허용하고, 모두 top-level chunk 만
    접으며 component state 에 넣는 곳은 `createTextPacer` 를 사용한다.

> 이 중 하나가 실패하면 **규칙을 넓히지 말고 import 를 고쳐라.** 허용 목록이 비어 있는 것은
> 의도된 것이다: 위반을 추가하는 일은 조용한 결정이 아니라 눈에 보이는 결정이어야 한다.

## 코드베이스에 추가하기

| 추가하는 것… | 들어갈 위치 | 조립 지점 |
|---|---|---|
| 엔티티나 저장소 포트 | `src/domain/<slice>/` | — (순수 TS, `domain` 을 넘어선 `@/` import 없음) |
| use case | `src/application/<slice>/` | deps 를 주입받는다. `container.ts` 를 import 해서는 안 된다 |
| 어댑터 (DB, HTTP, 클라우드) | `src/infrastructure/<slice>/` | `src/lib/container.ts` |
| 라우트 핸들러 | `src/app/api/…/route.ts` | 저장소와 `executionDeps` 는 wiring site 에서 가져온다. 절대 `infrastructure/` 를 직접 쓰지 않는다 |
| 공용 UI | `src/app/_components/` | — |
| 의존성 없는 헬퍼 | `src/shared/` | — |

새 슬라이스를 위한 체크리스트:

- [ ] 도메인 타입은 프레임워크나 AWS import 를 갖지 않는다.
- [ ] 키 문자열은 `src/infrastructure/db/keys.ts` 에서 온다. 절대 손으로 쓰지 않는다.
- [ ] 리포지토리는 `items` 에 raw SQL 을 쓰지 않고 `src/infrastructure/db/store.ts` 를 지난다
     . 조건·트랜잭션·접두사 상한이 거기 한 곳에 있다.
- [ ] 경계 없이 자랄 수 있는 목록은 `queryItems` 에 `limit` 을, 만료 행을 거르는 목록은
      `notExpiredAt` 을 넘긴다. 필터가 `LIMIT` 보다 먼저 돌게.
- [ ] 한없이 늘어나는 새 행은 `src/infrastructure/db/ttl.ts` 에서 온 `expiresAt` 을 갖는다.
      그래야 틱의 sweep 이 지운다.
- [ ] 새 실행 진입점은 projectType 디스패치를 다시 구현하는 대신 파사드를 호출하고, 런 브래킷을
      연다. 런을 chunk 로 받는 소비자(이미지 포함)에게는 `streamProjectRun`, completion 으로
      답하는 소비자에게는 `executeProjectStream`/`executeProject` 이고, 후자는 이미지 project 를
      거부한다.
- [ ] 이제 두 곳에 존재하게 된 결정은 단일 소유자와 `SINGLE_OWNERS` 항목을 갖는다.
- [ ] `pnpm typecheck && pnpm test && pnpm build` 가 통과한다.

## 문서

| 파일 | 역할 |
|---|---|
| [../README.md](../README.md) | 무엇인지, 어떻게 실행하는지, 무엇을 할 수 있는지 |
| [../AGENTS.md](../AGENTS.md) | 코딩 에이전트를 위한 작업 규칙 (`CLAUDE.md` 가 이 파일의 symlink 다) |
| [ARCHITECTURE.md](ARCHITECTURE.md) | 모든 런이 지나는 형태. 레이어, 테이블, 요청 경로 |
| [design/](design/) | 서브시스템마다 한 파일: 무엇을 결정하고 왜 그런지 |
| [OWNERSHIP.md](OWNERSHIP.md) | 모든 단일 소유자 결정과 그것을 소유한 파일 |
| [API.md](API.md) | HTTP 계약 |
| [CONFIGURATION.md](CONFIGURATION.md) | 모든 환경변수와 고정 한계값 |
| [OPERATIONS.md](OPERATIONS.md) | 배포, 프로브, 스케일, 보존 |
| [SECURITY.md](SECURITY.md) | 인증, 시크릿, SSRF, PII |
| [MILESTONES.md](MILESTONES.md) | 남은 작업 (한국어) |

서브시스템 둘은 자기만의 로컬 `AGENTS.md` 를 갖고 있고, 그 안의 불변식에 대해서는 그 파일이
정본이다. 해당 파일들을 고치기 전에 읽어라:

- `src/application/llm/AGENTS.md`. 도구 루프, 시스템 프롬프트 조립, author 계약, fallback 시맨틱,
  PII 경계, usage 기록.
- `src/application/chat/AGENTS.md`. chat 영속화, 리플레이, 히스토리 예산.

문서는 변경 이력이 아니라 **현재** 상태를 기록한다: 완료된 마일스톤은 `MILESTONES.md` 에서
삭제하고, 이력은 git log 와 태그별 GitHub Release 가 남긴다.

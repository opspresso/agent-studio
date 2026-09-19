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
pnpm install --frozen-lockfile
```

## 환경

```bash
test -f .env.local || cp .env.example .env.local
```

실제 런에 필요한 최소값은 `DATABASE_URL`, `LLM_BASE_URL`, `LLM_API_KEY`,
`AES_ENCRYPTION_KEY`(32바이트 base64, `openssl rand -base64 32`) 다. `src/instrumentation.ts`
가 이들을 부팅 시점에 검증하므로, 빠진 값이 있으면 첫 요청이 아니라 기동 단계에서 실패한다.
신원 제공자(Keycloak · 표준 OIDC · Google · 비밀번호)는 실제 로그인에만 필요하다. `STAGE=local` 은 하나도
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

Next.js는 `.env.local`을 읽지만 별도 CLI 스크립트는 자동으로 읽지 않는다. 파일에 지정한 DB에
마이그레이션하려면 `pnpm tsx --env-file=.env.local scripts/db-migrate.ts`를 사용한다.
인증 계정의 키와 업그레이드 전제는 [설치 문서](INSTALL.md#업그레이드)를 따른다.

`compose.yaml`은 `agent-studio-local` project에 PostgreSQL 18과 MinIO 전용 volume을 만든다.
Agent Memory는 별도 project와 포트를 사용하므로 서로 독립적으로 시작하고 종료할 수 있다.
`docker compose down -v`는 Agent Studio의 로컬 데이터를 삭제하므로 명시적 확인 없이 실행하지 마라.

`.env.example` 의 기본 object-store 설정은 Agent Studio MinIO(:9000, console :9001)를 가리킨다.
`minio-init`이 `agent-studio` bucket을 멱등하게 만든다.

## 로컬 MCP (deploy/local)

MCP는 선택 기능이다. 공개 원격 서버는 해당 서비스의 연결·인증으로 사용하고, 사설 DNS의 서버는
배포가 허용한 내부 suffix와 실제 네트워크 도달성이 있어야 한다. [deploy/local/](../deploy/local/README.md)은
OrbStack의 network alias와 도메인으로 로컬 MCP 컨테이너를 제공한다. 필요한 서버를 실행하고
`.env.local`에 해당 MCP 내부 suffix를 설정한다. 플러그인 동기화는 서버 URL을 등록하는 절차이며
모든 원격 서비스나 OAuth 계정을 자동으로 띄우는 작업은 아니다.

## 실제 자격 증명 없이 작업하기

```bash
# 모의 OpenAI 호환 LLM 서버; 그다음 LLM_BASE_URL=http://127.0.0.1:8002/v1 로 설정
pnpm tsx scripts/mock-llm.ts

# 개발용 사용자 + 세션을 만들고 서명된 세션 쿠키를 출력
pnpm tsx --env-file=.env.local scripts/dev-session.ts

# 샘플 skill 시드 (같은 이름의 기존 skill 은 건드리지 않는다)
pnpm tsx --env-file=.env.local scripts/seed-skills.ts
```

모의 모델을 쓸 때는 선택한 모델의 provider별 endpoint 설정도 확인한다. 예를 들어
`LLM_PROVIDER_OPENAI_BASE_URL`이 설정된 `openai/...` 모델은 `LLM_BASE_URL`보다 그 주소를
우선하므로 해당 provider 주소도 mock으로 지정한다. 개발 세션 스크립트와 앱의
`DATABASE_URL`, `BETTER_AUTH_SECRET`, `BETTER_AUTH_URL`을 일치시킨다. 출력된 쿠키는 로컬
검증에만 사용하고 코드·로그·PR에 남기지 않는다.

## 명령

```bash
pnpm dev              # 문서 워커 번들 후 next dev
pnpm build            # 문서·오디오·Workspace 워커 번들 + 프로덕션 빌드 (standalone) — 라우트 핸들러 + instrumentation 검증
pnpm start            # 이미 만든 Next.js production build 실행
pnpm typecheck        # tsc --noEmit, strict + 추가 검사 (아래)
pnpm test             # vitest run
pnpm test:documents   # 실제 자식 프로세스로 생성·추출·검사·편집 검증 (DB 불필요)
pnpm test:watch       # vitest watch
pnpm exec playwright install chromium # HTML 실행 미리보기 테스트용 브라우저
pnpm test:html-preview # 로컬 HTTP fixture에서 실제 Chromium 기능·격리 검사
pnpm test:integration # 로컬 PostgreSQL(agent_studio_test), 인증 스키마와 SDK 실행·Session 검사
pnpm test:storage     # 로컬 MinIO 임시 bucket의 원본 파일 streaming·조건부 저장·삭제 검사
pnpm test:audio       # ffmpeg로 실제 MP3 분할·WAV 크기·시간 범위·임시 파일 정리 검사
pnpm test:audio:pipeline # PostgreSQL test DB·MinIO·ffmpeg·로컬 ASR mock을 통한 전체 전사 경로
pnpm worker:workspace # 환경변수가 주입된 별도 Workspace·승인 후속 실행 worker
pnpm test:sandbox     # 무통신 Docker 격리·체크포인트 검사
pnpm test:workspace   # Docker + PostgreSQL *_test 실행·복구 검사
pnpm test:workspace:git # 무통신 Git fixture와 승인·게시 검사
pnpm worker:audio     # 환경변수가 주입된 별도 오디오 worker. 앱이 DB를 초기화한 뒤 실행
pnpm db:migrate       # DATABASE_URL 의 데이터베이스를 현재 스키마로 (db:migrate:test 는 테스트 DB)
pnpm check-models     # 카탈로그 스냅샷과 이 배포의 채널이 서빙하는 것의 차이
pnpm sync-models --from path/to/models.json # 로컬 카탈로그로 갱신 (원격은 MODELS_CATALOG_URL 설정)
```

로컬 `.env.local`을 읽어 worker를 실행하려면 `node --env-file=.env.local --import tsx scripts/audio-worker.ts`를 사용한다.
`pnpm dev`는 오디오·Workspace worker를 자동 시작하지 않는다. Workspace도
`node --env-file=.env.local --import tsx scripts/workspace-worker.ts`로 별도 실행한다. 배포는 `pnpm start` 대신 standalone
산출물의 `node server.js`로 실행한다. `public`·`.next/static`을 포함하는 방법은
[운영 문서](OPERATIONS.md#빌드-아티팩트)를 따른다.

`scripts/audio-worker-check.mjs`는 저장소 밖에 복사한 standalone 디렉터리에서 worker 번들 로드,
DB poll 실패 후 대기와 SIGTERM 종료를 확인하는 별도 smoke 검사다. 현재 CI가 자동 실행하지는 않는다.
실제 DB·스토리지·전사 처리는 `test:audio:pipeline`이 검증한다.

`test:audio:pipeline`은 선택적으로 실제 Agent Memory MCP까지 검증한다. 별도 폐기 가능한
Memory 설치를 `localhost`에 띄우고 문서 worker를 켠다. 합성 사용자(`@example.test`)의 개인 계정·검증된 email과
테스트 설치의 MCP token을 준비한 뒤 `{ "token": "..." }` 응답을 권한 0600의 임시 파일로 저장한다.
환경 변수 `AUDIO_TEST_MEMORY_URL`, `AUDIO_TEST_MEMORY_TOKEN_FILE`, `AUDIO_TEST_MEMORY_EMAIL`을
지정하고 같은 검사를 실행한다. 공개 호스트와 IP literal은 거절하며 테스트 process에만
`localhost` MCP 연결을 허용한다. ASR·후처리 모델은 계속 로컬 mock을 사용한다.

이 모드는 실제 MCP schema discovery·email 전달·문서 ready 대기·Memory receipt를 확인한다.
Studio 측 fixture는 정리하지만 수신 측에는 합성 문서 2건과 Memory 1건이 남으므로 검증 후
전용 Memory DB·버킷을 폐기한다. 기존 사용자 데이터가 있는 Memory 설치에 연결하지 않는다.

```bash
# 테스트 파일 하나, 또는 테스트 이름으로
pnpm exec vitest run tests/engine.test.ts
pnpm exec vitest run -t "streamWithFallback"
```

`pnpm test:integration`은 `scripts/keycloak-auth-check.ts`도 별도 프로세스에서 실행한다.
로컬 `_test` DB의 임시 스키마와 RS256 토큰을 발행하는 로컬 OIDC fixture로 실제 앱의
discovery·PKCE·콜백·세션 생성·재로그인을 확인한다. audience·nonce·state 오류와 신규·기존
사용자의 도메인 제한도 검증하고 임시 스키마를 삭제한다. 실제 Keycloak realm은 사용하지 않으므로
배포의 client 설정·CA·네트워크 도달성은 [설치 절차](INSTALL.md#keycloak-로그인)로 확인한다.

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
| `scripts/migrate-agent-configuration.ts` | Version 기반 데이터를 원본 보관 후 현재 Agent 설정으로 옮기는 수동 계획·적용 도구다. [이전 절차](AGENT-MIGRATION.md)를 따른다. |
| `scripts/dev-session.ts` | 개발용 사용자와 세션을 Better Auth 의 테이블에 바로 써 넣고 서명된 세션 쿠키를 출력한다. 신원 제공자 왕복 없이 인증이 필요한 라우트를 시험한다. 로컬이 아닌 `DATABASE_URL` 은 거부한다. |
| `scripts/mock-llm.ts` | `127.0.0.1:8002` (`MOCK_LLM_PORT`) 에서 도는 독립 실행형 OpenAI 호환 mock 서버. 스트리밍과 비스트리밍을 모두 지원하고, 도구가 제공되고 *동시에* 메시지가 `skill named "<slug>"` 를 언급할 때 `Skill` 도구 호출을 한 번 요청한다. `MOCK_LLM_CHUNKS` 와 `MOCK_LLM_DELAY_MS` 는 답변을 부풀리고 늦춰 긴 스트리밍 응답으로 만든다. 답이 도착하는 동안 chat 창이 무엇을 하는지 볼 수 있는 유일한 방법이다. 기본값은 통합 체크가 기대하는 한 줄 답변을 유지한다. |
| `scripts/seed-skills.ts` | 샘플 Skill 을 멱등하게 시드한다. |
| `scripts/integration-check.ts` | 저장소 왕복, 인증 마이그레이션, SDK 모델·도구 실행과 영속 Session 승인·재개를 검증한다. 아래 두 helper를 함께 호출한다. |
| `scripts/auth-schema-check.ts` | 테스트 DB의 임시 스키마에서 계정 키 중복 거부, 기존 계정 보존, issuer 없는 신규 계정 및 기존·신규 비밀번호 로그인을 검증한다. |
| `scripts/runtime-session-check.ts` | 실제 SQL Session 저장소의 소유자 범위, CAS 경쟁, 암호화 문맥, 만료와 삭제 후 늦은 쓰기 방지를 검증한다. |
| `scripts/check-models.ts` | 카탈로그 스냅샷(`src/domain/llm/catalog.json`)을 *이 배포의* 채널들이 서빙하는 id 와 대조한다. agent-models 가 provider 의 공개 카탈로그는 스스로 보므로, 여기서 보는 것은 게이트웨이·Bedrock·키의 범위 같은 이 배포만의 차이다. |
| `scripts/sync-models.ts` | 발행된 카탈로그로 스냅샷을 갱신한다 (`--check` 는 뒤처졌으면 1 로 종료, `--from <file>` 은 URL 대신 로컬 카탈로그 문서를 읽는다, `MODELS_CATALOG_URL` 이 없거나 `none` 인 환경에서는 이것이 필수다). 런타임은 카탈로그를 직접 읽으므로, 테스트가 새 모델을 봐야 하거나 릴리즈 전일 때 돌린다. |
| `scripts/import-dynamodb-export.ts` | 일회성 이관: AWS CLI 로 내보낸 옛 DynamoDB 테이블(`aws dynamodb scan … --output json`)을 이 스키마로 들여온다. `AUTH#` 행은 Better Auth 의 테이블로, 유니크 락 행은 버리고, 나머지는 같은 키로 `items` 에 upsert 한다. 지원하지 않는 managed MCP host-file `envRefs` 와 저장소 종속 `artifactAccessMode` 는 제거하고, 같은 이메일로 먼저 생긴 사용자는 export 의 원래 id 를 보존하기 위해 교체한다. 절차는 [INSTALL.md](INSTALL.md#데이터-이관). |

### `check-models`

공개 모델 사실은 agent-models가 소유하고, 이 스크립트는 현재 배포의 채널이 실제로 나열하는
모델과 로컬 카탈로그를 대조한다. 기본·provider 채널, 전용 Embedding·Rerank endpoint를 확인하며
OpenRouter는 modality별 목록도 조회한다. 실제 모델 실행 성공을 보장하는 검사는 아니다.

```bash
pnpm check-models
pnpm check-models --since=90d
pnpm check-models --since=2026-01-01
pnpm check-models --strict
```

`--strict`는 제공 대상 route가 사라졌거나 채널 확인에 실패하거나 비교할 ID가 없을 때 실패한다.
채널이 설정되지 않은 provider와 이미 숨긴 route는 은퇴 판정에서 제외한다.
채널이 제공하는 새 ID는 추가 후보로 보고하며 그것만으로 실패하지 않는다.
`--since`는 새 ID 보고 범위만 좁히고 실패 판정을 바꾸지 않는다.

배포와 같은 URL·provider prefix·credential 설정으로 실행하라. SigV4 채널은 AWS credential도
필요하다. 별도 CLI의 `.env.local` 로딩은 명시해야 한다.
실제 외부 API와 자격 증명을 사용하는 검사이며 현재 자동 실행 workflow는 없다.

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

현재 workflow는 [`.github/workflows/release.yml`](../.github/workflows/release.yml) 하나다.
`pull_request`와 `v*` tag push에 반응하며 `verify`는 GitHub-hosted `ubuntu-24.04`에서 실행한다.

```text
pnpm install --frozen-lockfile → typecheck → test → test:integration
```

통합 검사는 일회용 PostgreSQL 18 + pgvector 서비스의 `agent_studio_test`를 사용한다.
현재 `verify`에는 production build, HTML 미리보기, standalone·문서·오디오·Workspace smoke
검사가 없다. 로컬에서 필요한 범위를 따로 실행해야 하며 `main` push나 모델 드리프트의
독립적인 정기 검사 workflow도 없다.

`github-release`와 `release`는 `verify` 뒤에 실행되고, 이미지 빌드에서 Dockerfile의
`pnpm build`가 수행된다. 다만 두 job에 tag 전용 조건이 없어 PR에서도 실행을 시도하는
현재 제약이 있다. tag 조건이 있는 job은 `gitops`뿐이다.
릴리스 권한과 완료 확인은 [OPERATIONS](OPERATIONS.md#릴리스-파이프라인),
해결할 조건은 [MILESTONES](MILESTONES.md#release-event-gating)를 따른다.

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

구조 테스트는 다음 범위를 검사한다. 세부 소유자와 호출 집합은 테스트의 선언을 정본으로 삼는다.

| 검사 영역 | 지키는 계약 |
|---|---|
| 계층·조립 | domain/application/infrastructure/app/lib/shared 의존 방향, 조립 지점, application 순환 의존 금지 |
| 단일 소유 | 상수·형태·formatter·오류·정책의 중복 금지와 소유자 정의 존재 |
| 실행 표면 | 이미지·Agent·도구 해석·Artifact 캡처·raw stream의 제한된 호출 집합 |
| 스트림 | 이미지와 파일 두 축, 최상위 종료·reasoning fold, 문맥·손실 보고 |
| 경계 | 모델 URL의 공개망 제한, 주입된 설정, 본문 파싱 전 크기 제한, producer 소유 응답 타입 |
| 번들 | client의 서버 runtime import 금지, edge 경로의 Node 전용 import 제한 |
| UI | 이벤트 target 수명, HTML nesting, 생성 상태 초기화, 공용 포맷·스크롤·출력 pacing |
| 검사기 자체 | 스캔 범위와 fixture를 확인해 검사 대상이 사라진 상태를 통과로 보지 않는다 |

실패하면 [AGENTS.md](../AGENTS.md), [아키텍처](ARCHITECTURE.md)와
[단일 소유자](OWNERSHIP.md)를 확인해 구조를 고친다. 검사 통과만을 위해 허용 목록을 넓히지 않는다.

## 근본 원인 중심의 개선

변경량 자체를 최소화하는 대신, 문제를 온전히 해결하는 가장 작은 수정을 선택한다.
설계 판단은 [모듈 경계와 재사용](ARCHITECTURE.md#모듈-경계와-재사용)을 따른다.

1. 입력·설정·상태와 기대 동작을 확인하고 문제를 재현한다. 로그·실패 테스트·실행 경로로
   확인한 사실과 가설을 구분한다.
2. 호출 흐름과 데이터·상태 변화를 추적해 근본 원인과 그 책임을 가진 계층·모듈을 찾는다.
   오류가 드러난 호출부와 원인을 소유한 모듈은 다를 수 있다. [OWNERSHIP](OWNERSHIP.md)에서
   기존 결정의 소유자를 확인한다.
3. 원인을 소유한 계층에서 계약·구현을 바로잡는다. 호출부마다 보정 로직을 복제하거나,
   실패를 숨기는 예외 처리·fallback·재시도로 덮지 않는다. 검사 통과를 위해 테스트나 경계를
   약화하지 않는다.
4. 같은 원인이 영향을 주는 다른 경로도 확인하고 회귀 테스트로 수정 전 실패와 수정 후
   정상 동작을 검증한다. 변경 위험에 맞는 관련 검사와 필수 검사를 실행한다.

근본 해결에 필요한 구조 변경은 포함하되, 무관한 리팩토링·정리는 섞지 않는다.
장애 대응용 fallback·재시도는 대상 실패·적용 조건·상한이 명확한 계약으로 다룬다.
임시 우회가 불가피하면 이유·남는 제약·제거 조건을 명시하고 근본 해결로 보고하지 않는다.

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

전체 읽기 경로는 [README의 문서 색인](../README.md#문서-읽기)을 따른다.
문서에는 현재 동작·계약·제약을 기록하고, 환경변수는 CONFIGURATION, HTTP 형태는 API,
실행 원리는 해당 설계 문서에서 한 번 설명한다. 같은 내용을 복사하기보다 링크한다.

하위 시스템 변경 전에는 해당 로컬 지침을 읽는다.

- [Runtime](../src/application/runtime/AGENTS.md): SDK Agent·도구·Handoff·Session·승인·Tracing.
- [LLM 준비](../src/application/llm/AGENTS.md): 프롬프트 조립·PII·문맥 예산·모델 카탈로그.
- [Chat](../src/application/chat/AGENTS.md): 화면 영속화·재연결·SDK Session·승인·Workspace 후속 실행.

문서만 바뀌면 명령·링크·앵커·코드 참조와 전체 diff를 확인한다. 런타임 코드를 바꿨을 때는
해당 동작의 회귀 검사와 저장소 필수 검사를 실행한다.

문서는 변경 이력이 아니라 **현재** 상태를 기록한다: 완료된 마일스톤은 `MILESTONES.md` 에서
삭제하고, 이력은 git log 와 태그별 GitHub Release 가 남긴다.

# 설정

이 앱이 환경에서 읽는 모든 값, 그리고 코드에 고정돼 있어 *설정할 수 없는* 제한들.
`.env.example` 은 복사해 쓰는 템플릿이고, 이 문서는 각 값이 무엇을 하는지와 값이 잘못됐을
때 무슨 일이 일어나는지를 설명하는 레퍼런스다.

관련 문서: 배포된 인스턴스에 무엇을 설정할지는 [OPERATIONS.md](OPERATIONS.md), 로컬
`.env.local` 은 [DEVELOPMENT.md](DEVELOPMENT.md), 자격증명에 해당하는 값들은
[SECURITY.md](SECURITY.md).

## 해석 순서

한 설정은 세 곳에서 올 수 있고, 그 값을 가진 첫 번째가 이긴다:

```
SETTINGS#app 행의 override (데이터베이스)   →   environment variable   →   built-in default
```

표의 **runtime**은 admin의 `/settings`, **models**는 admin의 Settings → Models 선택을 통해 DB에서
덮어쓰는 값이다. **boot**는 시작 시 구성하는 갱신기 설정이고 **—**는 환경 전용이다.
DB를 읽기 전 필요한 키·DB 주소·로그인 설정과 Sandbox 인프라는 재배포 설정으로 관리한다.

읽기는 `src/lib/runtime-settings.ts` 를 지나가며, dispatch 시점에 `process.env` 를 직접
읽는 일은 결코 없다. 그러지 않으면 오버라이드가 settings 페이지에서만 적용되고 다른
어디에도 적용되지 않는다. 값은 `SETTINGS_CACHE_TTL_MS` 동안 메모리에 캐시되고 쓰기 시
캐시가 무효화되지만 무효화는 프로세스 로컬이다. 다른 인스턴스는 TTL까지 이전 설정을 사용할 수 있다.
멤버 tier의 email 조회는 별도 30초 캐시이며 자세한 권한 전파는 [SECURITY](SECURITY.md#인가-모델)를 따른다.

settings 쓰기는 최신 `SETTINGS#app` 행을 row lock 아래에서 읽고 patch를 합친 뒤 같은 transaction
에서 저장한다. 일반 설정 저장과 Embedding/Rerank 선택이 동시에 도착해도 한 요청의
오래된 full-row snapshot이 다른 요청의 필드를 되돌리지 않는다. Embedding migration 동안의
vector/query model 일치는 별도의 reindex lease generation이 지킨다. 검색은 시작 전·vector 조회
후·반환 직전에 generation을 비교하고, migration과 겹쳤으면 결과를 버린다.

오버라이드와 환경변수는 *"설정돼 있는가?"* 에 같은 방식으로 답한다: 비어 있거나 공백뿐인
값은 **설정되지 않음**으로 치고, 유효 값이 되는 대신 다음 계층으로 떨어진다.
`/settings` 에서 빈 칸을 저장하면 오버라이드가 제거되고, 공백뿐인 시크릿은 키가 아니다. 부팅
시점도 포함해서이며, 거기서는 없는 것으로 보고된다. 이것이 가장 중요한 곳은 파일에서
마운트된 시크릿이다. 헤더가 나를 수 없는 개행이 끝에 붙어 오기 때문이다. 규칙은
`src/shared/env.ts` 가 소유하고, 거기서 돌려주는 값은 trim 돼 있다. `STAGE` 와
`AWS_REGION` 은 예외로, 빈 값을 문자 그대로 받는다. `STAGE` 에서
그것은 의도적이다: 빈 값은 throw 하는데, `local` 로 폴백하면 배포된 stage 에서
`assertAccessControlConfig` 를 건너뛰게 되기 때문이다. `ARTIFACT_ACCESS_MODE` 도 trim 한 뒤
읽으며, `public` 이나 `proxied` 가 아닌 값은 `authenticated` 로 읽힌다.
다만 프로덕션 Node 프로세스에서 `STAGE` 를 비워 두는 것은 그 자체로 부팅 에러다. 로컬
컨테이너는 `STAGE=local` 로 명시적으로 남고, 배포된 이미지가 변수 하나가 빠졌다는 이유로
fail-open 이 될 수는 없다.

## 부팅 시 검증

`src/instrumentation.ts` 는 서버가 연결을 받기 전에 검사 두 개를 돌린다. 설정 오류가 그
값을 필요로 하는 첫 요청에서 500 으로 나타나는 대신 시작 시점에 실패하게 하기 위해서다.

| 검사 | 규칙 |
|---|---|
| `assertRequiredConfig` | `DATABASE_URL`, `AES_ENCRYPTION_KEY` 가 모든 stage 에서 설정돼 있어야 한다. 암호화 키는 canonical base64 로 인코딩한 정확히 32바이트여야 한다. |
| `assertAccessControlConfig` | `NODE_ENV=production` 은 명시적인 `STAGE` 를 요구한다. `STAGE=alpha` 또는 `prod` 는 추가로 `ADMIN_EMAILS` 와 **로그인 수단 하나 이상**(Keycloak, 표준 OIDC, Google의 필수 변수 묶음 또는 `AUTH_PASSWORD=true`)을 요구한다. 각 묶음은 [인증과 접근 제어](#인증과-접근-제어)를 따른다. 빈 `ALLOWED_EMAIL_DOMAINS` 는 모든 도메인을 허용하는 정상 설정이다. |

두 검사 뒤에 부팅 경로는 스키마를 적용하고(`migrate`, advisory lock 아래에서, 인스턴스가
여럿이어도 한 번) `BOOTSTRAP_ADMIN_EMAIL`/`BOOTSTRAP_ADMIN_PASSWORD` 가 있으면 그 계정을
만든다. 데이터베이스에 닿지 못하는 부팅은 치명적이다. 서빙할 것이 없다.

두 번째 검사가 있는 이유는 두 목록 모두 비어 있을 때 fail-open 이기 때문이다.
`ADMIN_EMAILS` 가 설정되지 않으면 로그인한 모든 사용자가 공유 레지스트리에 대한 admin 이
되고, `ALLOWED_EMAIL_DOMAINS` 가 설정되지 않으면 설정된 신원 제공자의 아무 계정이나 로그인할
수 있다.
앞의 것은 무설정 로컬 개발에만 옳은 기본값이라 `local` 은 그대로 두고 배포된 stage 들이
부팅을 거부한다. 뒤의 것은 배포가 고르는 것이다. 열린 가입을 의도한 배포가 있고, 이
검사가 읽는 것은 env 인 반면 `getAllowedEmailDomains` 는 여기서 보이지 않는 저장된
오버라이드를 우선하므로 거부는 콘솔에서 도메인을 설정한 배포까지 함께 막는다. 빈 값은
모든 도메인을 허용하는 명시적인 정책으로 취급하고 정상 부팅한다.

`STAGE=local` 에서는 로그인 수단이 하나도 없어도 부팅한다: 로컬 dev-session 흐름
(`scripts/dev-session.ts`)이 신원 제공자를 통째로 우회한다. 어느 제공자를 켜는지는
[인증과 접근 제어](#인증과-접근-제어).

## 핵심

| 변수 | 기본값 | Runtime | 설명 |
|---|---|---|---|
| `STAGE` | production 밖에서는 `local` | — | `local` \| `alpha` \| `prod`. 그 밖의 값은 부팅 시 throw 하며, 프로덕션 프로세스는 이 값을 명시적으로 설정해야 한다. 위의 접근 제어 검사를 게이트한다. |
| `SERVICE_NAME` | `Agent Studio` | — | 화면·브라우저 제목·안내 문구, MCP OAuth 클라이언트 이름, Slack 매니페스트의 기본 설명에 표시할 이름. 앞뒤 공백을 제거한 한 줄, 최대 80자. `SERVICE_LOGO`와 독립적으로 설정한다. |
| `SERVICE_LOGO` | `agent-studio` | — | `public/brands/<값>/` 자산 폴더 선택자. 내장 폴더는 `agent-studio`, `agentops`다. 소문자·숫자·하이픈만 허용하며 `logo.png`, `favicon.ico`, `favicon-32.png`, `icon-192.png`, `apple-touch-icon.png`가 모두 없으면 부팅을 거부한다. 새 브랜드도 같은 파일을 추가해 선택한다. 예: `SERVICE_NAME=AgentOps`, `SERVICE_LOGO=agentops`. |
| `DATABASE_URL` | — (필수) | — | PostgreSQL 접속 문자열 (`postgres://user:pass@host:5432/db`). 이 앱의 모든 행. 아이템 테이블, Better Auth 의 테이블, capability 카탈로그의 벡터. 이 여기 있다. 서버에 `pgvector` 확장을 *만들 수 있어야* 한다 (`CREATE EXTENSION IF NOT EXISTS vector` 를 부팅 때 앱이 실행한다). 스키마는 부팅 때 마이그레이션된다. |
| `DATABASE_POOL_SIZE` | `10` | — | 프로세스 하나의 최대 DB connection 수, 하한 1. 웹 replica와 worker별 pool을 합산해 DB의 접속 한도 안에 배치한다. 모델 응답을 기다리는 동안 DB connection을 계속 점유하지 않는다. |
| `AWS_REGION` | `ap-northeast-2` | — | AWS 를 쓰는 기능. Bedrock 임베딩, `S3_ENDPOINT` 없이 AWS S3 자체를 쓸 때의 클라이언트. 이 쓰는 리전. 그 밖에는 읽히지 않는다. |
| `AES_ENCRYPTION_KEY` | — (필수) | — | 32바이트 base64. 저장되는 모든 시크릿을 암호화하고, proxied 오브젝트 주소의 서명 키도 여기서 HKDF 로 파생된다. [SECURITY.md](SECURITY.md#저장된-시크릿) 를 보라. |
| `S3_BUCKET_NAME` | 미설정 | — | Artifacts의 공통 버킷. 일반 생성 파일은 `artifacts/<kind>/`, 비공개 오디오·전사·요약은 `source-files/`에 저장한다. 어느 S3 호환 스토어든 된다 (MinIO, Garage, Ceph RGW, AWS S3). 행에는 오브젝트 키가 저장되고 URL 은 절대 저장되지 않는다. 자격증명은 스토어 자신의 `S3_ACCESS_KEY_ID`/`S3_SECRET_ACCESS_KEY` 쌍이고, 비어 있으면 SDK 기본 체인(`AWS_*`, 인스턴스 역할, AWS 자신에는 이것이 맞다)이다; 그 주체에게는 (레거시 `images/*` 만이 아니라) **`artifacts/*`와 `source-files/*`**의 put·get·delete와 비공개 파일의 multipart 업로드 권한이 있어야 한다. 설정하지 않으면 영속화가 통째로 꺼진다: 런은 여전히 그림을 그리고, 바이트는 표면까지 도달했다가 거기서 멈추며, artifact 갤러리는 404 로 답한다. |
| `S3_ENDPOINT` | 미설정 | — | AWS 가 아닌 스토어의 주소 (`http://minio:9000`). 설정되면 path-style 로 주소를 만든다. 자체 호스팅 엔드포인트는 버킷 서브도메인을 해석하지 못하는 것이 보통이다. 비어 있으면 SDK 자신의 리전·자격증명 해석으로 AWS S3 에 간다. |
| `S3_ACCESS_KEY_ID` / `S3_SECRET_ACCESS_KEY` | 미설정 | — | 오브젝트 스토어의 키 쌍. `AWS_*` 에 넣지 않는다. 그 쌍은 프로세스의 다른 모든 AWS 클라이언트(Bedrock 채널·Cohere 임베딩)가 읽으므로, MinIO 의 키를 거기 두면 AWS 에 MinIO 키로 서명하게 된다. 비어 있으면 SDK 기본 체인을 따른다. |
| `S3_PUBLIC_BASE_URL` | 미설정 | — | `public` 모드에서 독자가 오브젝트에 닿는 base 가 앱이 업로드하는 엔드포인트와 다를 때 (리버스 프록시 뒤의 MinIO). 비어 있으면 `S3_ENDPOINT`/`<bucket>`, 그것도 없으면 AWS 의 virtual-host 형태. |
| `ARTIFACT_ACCESS_MODE` | `authenticated` | **runtime** | 독자가 저장된 오브젝트에 어떻게 닿는가. **`proxied`**. 앱 자신의 주소 `PUBLIC_BASE_URL/api/objects/<key>?exp=&sig=[&dl=]` 를 건네고 앱이 바이트로 답한다(`PUBLIC_BASE_URL` 이 없으면 경로만, 콘솔은 같은 origin 이라 닿지만 Slack 같은 외부 독자에게는 주소가 아니다). 모델 입력 이미지는 URL이 아니라 저장소에서 읽은 bounded inline bytes로 전달된다. 스토어는 앱에게만 닿으면 되므로 설치형의 선택이다. 토큰이 증명하는 것과 수명은 [SECURITY.md](SECURITY.md#데이터-노출과-보존). **`authenticated`**. 유효 기간이 있는 스토어의 pre-signed URL. 브라우저가 스토어에 직접 닿을 수 있어야 한다. **`public`**. 영구적인 직접 URL. 버킷 정책이 `artifacts/*` 와 레거시 `images/*` 의 공개 읽기를 허용할 때만 동작한다. **다운로드 링크는 `public` 에서도 pre-signed 다**: 브라우저가 저장할 파일명이 요청 서명에 실려 가는데 S3 는 익명 GET 에서 `response-*` 오버라이드를 거부하기 때문이다. 그래서 `public` 모드에서 문서의 주소는 유효 기간이 있고 이미지의 주소는 영구로 남는다. public 모드는 갤러리 메타데이터와 삭제가 인증을 유지하더라도 URL 을 손에 넣은 누구에게나 오브젝트를 노출한다. 모르는 값은 `authenticated` 로 fail-closed 된다. |
| `CATALOG_ENABLED` | `false` | — | `true` 면 이 배포가 capability 카탈로그를 갖는다. 벡터는 데이터베이스의 `catalog_vectors` 에 있고 따로 가리킬 것은 없다. 설정하지 않으면 `POST /api/catalog/reindex` 는 503 으로 답하고, 런은 자기 설정에 바인딩한 것만 제공한다. 그 503 에는 원인이 둘 있고 토큰 검사가 먼저 돌므로, `SCHEDULE_SCAN_TOKEN` 이 설정되지 않은 경우에도 메시지만 다른 같은 상태 코드가 나온다. 기본이 꺼짐인 이유: 카탈로그에는 배포의 채널이 서빙하는 임베딩 모델이 필요한데 부팅 때 그것을 확인할 길이 없다. 켜는 것은 그 모델이 있다는 선언이다. |
| `EMBEDDING_DIM` | `1024` | — | provider 에 요청하는 폭. `native` 는 폭 파라미터를 생략해 모델의 native dimension을 쓴다. 테이블의 모든 행이 같은 폭이어야 pgvector 가 거리를 계산하므로 값을 바꾼 뒤 반드시 재색인하라. Cohere v4, Titan v2, OpenAI v3처럼 폭 선택을 지원하는 모델은 명시값을 사용하고, 폭 파라미터를 거부하는 모델은 `native` 를 사용한다. |
| `CATALOG_MIN_SCORE` | `0.25` | — | vector 검색의 절대 하한. 유한한 숫자는 0–1로 clamp하고 그 밖에는 기본값을 사용하며 경고한다. query별 최고 점수의 상대 하한과 함께 적용한다. 모델·질의 언어가 바뀌면 [선택 절차](#임베딩-모델-선택)로 다시 확인한다. |
| `RERANKER_MIN_SCORE` | `0.01` | **models** | activation된 reranker relevance score의 noise floor. 각 query에서 최고 점수의 10%와 이 값 중 높은 쪽을 최종 하한으로 쓴다. 범위 밖 env 값은 `0`–`1`로 clamp한다. capability 설명은 답 자체가 아니라 답을 만들 도구이므로 adapter는 전용 instruction을 함께 보낸다. 모델을 바꾸면 다시 측정하고 `/settings/model-usage`에서 함께 저장하라. DB override가 env보다 우선하며 다음 검색부터 적용된다. |
| `PUBLIC_BASE_URL` | `BETTER_AUTH_URL`; 일반 URL 조립은 요청 origin, 없으면 `http://localhost:3000` | **runtime** | 바깥을 향하는 URL (Slack 매니페스트, MCP OAuth 콜백, MCP client ID 메타데이터 문서)을 만들 때 쓰는 scheme + host. 리버스 프록시 뒤에서는 요청 URL 이 bind 주소를 반영하므로 이 값은 설정에서 와야 한다. 요청 origin 단계는 요청이 손에 있는 일반 URL 조립에서만 적용된다. **거부된 사인인의 리디렉션(`/login?error=`)은 부팅 시 env 값으로 고정된다**: Better Auth 옵션은 한 번만 평가되므로 runtime 설정을 보지 못하고, env 가 비어 있으면 상대 경로가 되어 프록시 뒤에서 bind 주소 기준으로 해석될 수 있다. OIDC/Google 사인인을 쓰는 배포는 env 로도 설정하라. **MCP client ID 메타데이터 문서는 예외다**: 설정된 base 가 없으면 요청 origin 이나 localhost 를 추측하지 않고 503 으로 답한다. 그 URL 이 곧 OAuth `client_id` 이고 authorization server 가 가져가므로, loopback 이나 평문 http 값이면 흐름이 시작되기 전에 거부되고 provider 가 제공하는 경우 연결은 dynamic registration 으로 폴백한다. [SECURITY.md](SECURITY.md#mcp-oauth) 를 보라. |

### 임베딩 모델 선택

모델과 검색 임계값은 같은 배포의 실제 질의·capability 설명으로 함께 검증한다.
설명과 질의가 다른 언어라면 해당 조합을 포함하고, 관련 항목과 무관한 항목의 점수 분포를
비교한다. 다른 모델에서 사용한 `CATALOG_MIN_SCORE`를 그대로 옮기지 않는다.

`EMBEDDING_DIM`은 endpoint가 허용하는 차원이어야 한다. 차원 선택을 지원하지 않으면
`native`로 파라미터를 생략한다. 모델 또는 차원이 바뀌면 전체 재색인이 필요하다.
선택 저장·probe·재색인 실패 시 복원 계약은 [Models API](API.md#models),
검색·rerank 동작은 [Capabilities 설계](design/capabilities.md#케이퍼빌리티-카탈로그)를 따른다.

## 인증과 접근 제어

| 변수 | 기본값 | Runtime | 설명 |
|---|---|---|---|
| `BETTER_AUTH_SECRET` | — | — | 세션 서명 시크릿 (`openssl rand -base64 32`). |
| `BETTER_AUTH_URL` | — | — | Better Auth 가 콜백을 만들 때 기준으로 삼는 base URL. |
| `KEYCLOAK_ISSUER` / `KEYCLOAK_CLIENT_ID` / `KEYCLOAK_CLIENT_SECRET` | — | — | Keycloak 로그인. 셋이 모두 비어 있지 않을 때 켜지며 Google·표준 OIDC와 병행할 수 있다. issuer는 `https://sso.example.com/realms/corp` 같은 HTTP(S) realm URL이며 끝의 `/`는 제거한다. 사용자명·비밀번호·query·fragment가 포함된 URL은 거부한다. 콜백은 `BETTER_AUTH_URL/api/auth/callback/keycloak`이다. PKCE와 ID 토큰 검증을 사용한다. [설치 절차](INSTALL.md#keycloak-로그인)를 따른다. |
| `OIDC_ISSUER` / `OIDC_CLIENT_ID` / `OIDC_CLIENT_SECRET` | — | — | 표준 OIDC 제공자. Keycloak, Entra ID, Okta, Authentik 등 `<issuer>/.well-known/openid-configuration`을 제공하는 서버를 연결한다. 셋이 모두 있을 때만 켜진다(Better Auth의 `genericOAuth`, PKCE). 콜백은 `BETTER_AUTH_URL/api/auth/callback/oidc`이며 Keycloak 전용 설정과 별개의 provider다. |
| `OIDC_DISPLAY_NAME` / `OIDC_SCOPES` | `SSO` / `openid email profile` | — | 로그인 버튼의 이름, 그리고 공백으로 구분한 scope. |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | — | — | Google 로그인. 둘 다 있을 때만 켜진다. 콜백은 `/api/auth/callback/google`. |
| `AUTH_PASSWORD` | `false` | — | `true` 면 이메일 + 비밀번호 로그인. **가입 폼은 없다**. 아무도 보증하지 않는 계정이므로 부트스트랩 관리자는 부팅 때 만들어지고, 그 밖의 비밀번호 계정은 관리자의 의도적인 행위다. 신원 제공자가 아직 닿지 않는 설치의 첫 관리자와, 제공자가 죽었을 때의 비상 접근을 위한 것이다. |
| `BOOTSTRAP_ADMIN_EMAIL` / `BOOTSTRAP_ADMIN_PASSWORD` | — | — | `AUTH_PASSWORD=true` 일 때 부팅 시 준비되는 계정 (`ensureBootstrapAdmin`). 같은 이메일의 사용자에게 비밀번호 credential 이 이미 있으면 변경하지 않는다. 사용자는 있지만 credential 이 없으면 기존 사용자 행을 유지하고 비밀번호 credential 을 추가한다. 기존 비밀번호는 환경변수 변경으로 갱신되지 않는다. 이메일은 `ADMIN_EMAILS` 에도 넣어야 admin 이 된다. `ALLOWED_EMAIL_DOMAINS` 는 이 주소에 적용되지 않는다. 제공자나 도메인 목록이 모두를 잠갔을 때의 비상 계정이므로. `AUTH_PASSWORD` 없이 설정하면 경고만 남기고 만들지 않는다. |
| `ALLOWED_EMAIL_DOMAINS` | 비어 있음 | **runtime** | 로그인이 허용되는 도메인의 쉼표 구분 목록. 모든 로그인 수단에 적용된다(사용자 생성과 세션 생성의 훅). 비어 있으면 아무 도메인이나 허용한다. |
| `TRUSTED_PROXY_CIDRS` | 비어 있음 | — | 이 배포 앞에 있는 리버스 프록시들의 IP/CIDR 범위, 쉼표 구분 (예: Caddy 와 ingress controller 처럼 두 홉이 `X-Forwarded-For` 에 덧붙일 때). Better Auth 는 rate limiting 의 키로 삼는 클라이언트 IP 를 알아내기 위해 체인 오른쪽에서 이 홉들을 벗겨 낸다. 비어 있으면 값이 하나뿐인 헤더만 신뢰하므로, 프록시 두 개 뒤에서는 모든 요청이 하나의 공유 버킷에 떨어진다. |
| `ADMIN_EMAILS` | 비어 있음 | **runtime** | 쉼표 구분. 레지스트리·설정 변경 권한과 남이 소유한 프로젝트에 대한 쓰기 권한을 준다. 목록에 있는 멤버는 저장된 `admin` tier 로 승격되고 거기 고정된다. 목록에서 빼도 자동 강등은 없다. 비어 있으면 레지스트리·설정 변경에는 *제한 없음*, 프로젝트 오버라이드에는 *아무도 아님* 을 뜻한다. 두 질문이 서로 다른 술어로 답해지는 것은 의도적이다 ([SECURITY.md](SECURITY.md#인가-모델)). |

## 설정 화면

`/settings`는 General·Plugins·Models·Keys 탭으로 구성한다. General은 서비스 URL·Artifact
접근 방식·관리자와 허용 도메인, Plugins는 저장소와 브랜치, Keys는 GitHub 토큰을 관리한다. Models에는 프로바이더 연결·모델 선택·사용 설정·등록 모델
관리를 둔다. 프로바이더 키는 주소와 함께 Models의 연결 설정에서 관리한다.
URL·목록·비밀값·선택값은 각각 주소 입력·태그 입력·비밀번호 입력·선택 컨트롤을 사용한다.
저장은 현재 탭에서 변경한 필드만 전송하며 변경하지 않은 마스크나 다른 탭의 값은 전송하지 않는다.

## LLM 채널

관리자는 `/settings/providers`에서 프로바이더의 이름·종류·API base URL·키를 등록한다.
이름은 소문자 영문으로 시작하는 영문·숫자·`_`·`-` 조합이며 최대 64자다. 종류는
`openai`, `anthropic`, `google`, `xai`, `openrouter`, `bedrock`, `selfhosted`다.
같은 종류를 여러 이름으로 등록할 수 있으므로 서로 다른 사내 서버도 별도 연결로 관리한다.
URL에는 API 버전 경로를 포함한다. 예를 들어 OpenAI 호환 서버는 `/v1`, Google은
`/v1beta/openai`를 사용한다. Discovery는 Google·Anthropic의 native 목록 계약을 해석한다.

키는 endpoint 문맥에 묶어 암호화하며 조회 응답은 마스킹한다. 빈 입력 또는 마스크는 같은
주소·종류·인증 방식의 기존 키를 유지한다. 주소나 인증 대상을 바꾸면 새 키를 입력한다.
Self-hosted는 키를 생략할 수 있다. 프로바이더 목록은 최대 50개이며 빈 배열 저장은 모든
연결을 비활성화한다. 등록 모델이 남은 연결은 삭제할 수 없다.

초기 배포의 `LLM_PROVIDER_<NAME>_BASE_URL`·`_API_KEY`·`_AUTH`·`_KEEP_MODEL_PREFIX`는
저장된 프로바이더 목록이 없을 때만 초기 연결로 읽힌다. 모델 선택 자체에는 환경변수나
기본 모델 목록으로의 폴백이 없다. 기본 LLM 채널로 미등록 모델을 우회 실행하지 않는다.

### 모델 등록과 사용

1. `/settings/models`에서 등록한 프로바이더를 선택하고 **Model 조회**를 실행한다.
2. 사용할 항목의 유형·기능·한도·가격을 비교하고 **모델 추가**를 누르면 즉시 등록된다. 이름순·가격순 정렬과 기능 필터를 제공한다. 직접 등록은 화면 안의 입력 폼을 사용한다.
3. `/settings/model-usage`에서 기본 모델, Workspace Runtime별 모델, 검색의 Embedding·Rerank를 선택한다.
4. 선택 화면의 **선택된 모델만 보기**로 저장된 모델을 모아 보고 바로 삭제할 수 있다. Provider를 조회하지 않아도 저장된 선택을 표시한다. 등록 모델 관리에서는 수정·삭제·상태 확인을 수행한다. `/models`는 선택·등록된 모델의 조회와 검색만 제공한다.

타입은 `text`, `image`, `transcription`, `embedding`, `rerank`, `decisions`다.
`decisions`는 판단·분류용 텍스트 모델이며 Chat Completions 계약으로 실행한다.
모델 ID는 `<등록한 프로바이더 이름>/<프로바이더의 모델 ID>`다. 프로바이더에 보내는 ID는
별도로 보관하므로 OpenRouter와 self-hosted의 슬래시가 포함된 이름도 유지한다.

조회는 관리자 요청에만 수행하며 선택을 바꾸지 않는다. 명시적 출력 modality가 유형을 결정한다.
Provider 조회는 화면 필터와 무관하게 항상 전체 목록을 가져온다. 선택 모델·검색·유형·기능
조건은 전체 조회 결과에 적용한다. 조회 실패 시 마지막으로 완료된 전체 결과를 유지한다.
Provider와 조회 조건·정렬·페이지는 화면별 브라우저 localStorage에 저장한다. 다른 탭의
변경을 현재 화면에 동기화하지 않으며, 모델 조회 데이터와 자격증명은 저장하지 않는다.
Text·Image 등 출력 유형과 Tools·Vision·Reasoning 기능은 각각 표시한다. 제공자가 알려주지
않은 정보는 내장 공개 모델 스냅샷의 정확한 제공자·전송 ID 일치로 보완한다. 유형을 끝내
확인할 수 없으면 등록 전에 직접 선택한다. 한도 0은 미제공이며 화면에서 `—`로 표시한다.
가격 미제공과 명시적인 무료 요율을 구별한다.
모델 목록 조회 성공은 실제 생성 성공이나 모든 capability의 지원을 보장하지 않는다.
선택한 모델은 Settings에 최대 500개까지 저장하며 부팅과 설정 캐시 갱신에서 읽힌다.
인터넷이 끊겨도 저장된 모델과 사내 프로바이더로 실행할 수 있다. 새 설치는 빈 목록으로 시작한다.
공개 facts는 `pnpm sync-models`로 갱신한 `src/infrastructure/llm/data/publishedModels.json`을
사용한다. 격리망에서는 `pnpm sync-models --from <models.json>`으로 갱신한다. 런타임은
공개 카탈로그에 접속하지 않으며 스냅샷의 모델을 자동 등록하지 않는다.

기본 모델은 새 Agent와 모델 선택기의 첫 선택에 적용한다. 이미 저장한 Agent 설정은 유지한다.
기본·Workspace·Embedding·Rerank에 지정된 모델은 사용 설정을 먼저 변경해야 삭제할 수 있다.
삭제된 모델을 사용하는 새 실행은 거부된다. 공개 API와 하위 Agent도 등록된 모델만 호출한다.

검색 모델 선택은 `CATALOG_ENABLED=true`인 배포에서 사용한다. Embedding 변경은 명시적인
재색인 승인과 migration lock을 요구하며, 실패하면 이전 선택과 인덱스 복원을 시도한다.
Rerank 변경은 실제 query/document probe가 성공한 뒤 저장한다. 검색·전사는 self-hosted를
포함하여 선택한 모델의 프로바이더 URL·키·전송 ID를 함께 사용한다.

`UNKNOWN_MODEL_POLICY=allow|refuse`는 선택한 모델의 가격 미확인을 허용할지 정한다.
Settings → General의 **가격 정보가 없는 모델**에서 이 정책을 재정의할 수 있다.
기본값은 `allow`다. 미등록 모델의 실행은 이 값과 무관하게 거부된다. 제공자가 실제 비용을
반환하면 우선 사용하고, 가격을 계산할 수 없으면 비용 누락 경고·지표를 남긴다.

## 실행 제한

| 변수 | 기본값 | Runtime | 설명 |
|---|---|---|---|
| `MAX_RUN_DURATION_MS` | `600000` (10분) | — | 모든 진입점에 걸리는, 단일 런의 실제 경과 시간 상한. 멈춰 버린 provider 나 도구 호출이 무한정 돌거나 무한정 청구할 수 없다. 유효하지 않은 값은 경고와 함께 무시된다. Slack·Telegram·Teams 경로는 공용 메시징 파이프라인에서 추가로 고정된 3분 인터랙티브 데드라인(아래)을 적용하는데, 그것은 런을 짧게 만들 수만 있다. 런 슬롯 lease 는 이 값 + 60초, MCP OAuth 토큰 갱신 여유는 이 값 + 5분이다. 서명 URL 수명은 런 길이와 독립적으로 뷰 15분·지속되는 기록 7일이며 `src/shared/artifactUrlTtl.ts` 가 소유한다. |
| `MAX_CONCURRENT_RUNS_PER_ACTOR` | `10` | — | 한 호출자가 동시에 진행할 수 있는 런 수(최대 `1000`). `0` 은 제한을 끈다. 자기 `maxConcurrentRuns` 를 가진 멤버 tier(*코드에 고정된 제한* 참고)는 그 멤버 자신의 런에 대해 이 값을 덮어쓴다. 기본 `guest` tier 가 그런 값을 하나 들고 있다. `admin`/`member`, 프로젝트 토큰, 그리고 모든 기계 호출자는 이 값을 물려받는다. |
| `SCHEDULE_SCAN_TOKEN` | 미설정 | — | 모든 ticker 가 제시하는 단 하나의 자격증명(`X-Scan-Token`)이며, CronJob 이 POST 하는 세 엔드포인트가 공유한다: `/api/triggers/scan`(schedule), `/api/plugins/sync/scan`(plugins 저장소), `/api/catalog/reindex`(capability 카탈로그). 설정하지 않으면 이 배포에 ticker 가 없다는 뜻이다: 셋 다 503 으로 답하고 schedule 트리거는 결코 발화하지 않는다. 열리는 대신 꺼진다. |

유효하지 않은 값(정수가 아니거나 음수, 또는 위 동시성 상한 초과)은 `0` 이 아니라 경고와 함께 기본값으로 떨어진다.
`Number("abc") || 0` 은 "제한 꺼짐" 으로 읽히는데, 그것은 오타가 뜻해야 하는 바의 정반대다.

**이 문서의 거의 모든 숫자 설정이 그렇게 동작한다**: 이들은 `positiveIntEnv` 를 지나가며,
파싱과 경고까지 `src/lib/config.ts` 가 그것을 소유한다. 그 바깥에 있는 설정이 두 종류 있고
각각 자기 행에서 그렇게 말한다: `0`–`1` 값들(`CATALOG_MIN_SCORE`, `RERANKER_MIN_SCORE`)은
폴백하는 대신 **clamp** 하고, `MAX_RUN_DURATION_MS` 는 `src/shared/runDeadline.ts` 에서 스스로
파싱한다. `application` 이 그 데드라인을 필요로 하는데 `lib` 를 import 할 수 없기 때문이다.
`AbortSignal.timeout` 의 정의역에 대해 값을 검증하고 같은 경고와 함께 기본값으로 떨어진다.

한 설정이 어떤 헬퍼를 부르는지는 그것이 어디에서 자기를 *선언하는지* 와 별개의 문제다:
대부분은 `config.ts` 에서, 보존 기간은 `src/infrastructure/db/ttl.ts` 에서,
`SETTINGS_CACHE_TTL_MS` 는 `src/lib/runtime-settings.ts` 에서 선언한다. 어댑터는 변수를 직접
읽지 않는다. `tests/architecture.test.ts` 는 `domain`, `shared`, `infrastructure`,
`application` 어디에서든 `process.env` 를 읽으면 실패하고, `runDeadline.ts` 가 **이름이 명시된**
유일한 예외라서 두 번째 예외가 조용히 들어올 수 없다. 경고는 설정·값 조합마다 한 번씩 남긴다. Workspace 인프라는 별도 Zod schema로 검사해 잘못된
구성에 오류를 내며, 일부 오디오 설정도 허용되지 않는 형식이나 불완전한 쌍을 거절한다.

## MCP

| 변수 | 기본값 | Runtime | 설명 |
|---|---|---|---|
| `MCP_DISCOVERY_CACHE_TTL_MS` | `60000` | — | 바인딩된 서버의 도구 목록을 얼마나 오래 재사용하는지. 키는 `url + headers` 다. 캐시가 따뜻하면 세션이 지연 연결될 수도 있어서, 도구를 하나도 부르지 않는 턴은 MCP 요청을 아예 하지 않는다. `0` 은 캐싱을 통째로 끄며, 어떤 서버 힌트도 그것을 다시 켤 수 없다. 밀리초 정수. |
| `MCP_MAX_SERVER_TTL_MS` | `300000` (5분) | — | 서버가 `tools/list` 에서 요청할 수 있는 `ttlMs` 의 상한 (SEP-2549). `0` 은 서버 힌트를 완전히 무시하고 모든 항목을 로컬 TTL 로 되돌린다. 밀리초 정수. |
| `MCP_OAUTH_ALLOW_UNADVERTISED_PKCE` | `false` | — | `true` 면 `code_challenge_methods_supported` 를 광고하지 않는 OAuth authorization 서버를 받아들인다. 명세는 거부하라고 하지만(PKCE 다운그레이드 방어), 광고 없이 PKCE 를 지원하는 서버가 흔하다. 배포 단위의 결정이라 env 다. [SECURITY.md](SECURITY.md#mcp-oauth). |
| `MCP_INTERNAL_HOST_SUFFIXES` | 비어 있음 | — | 사설 주소로 resolve 되더라도 MCP 항목이 쓸 수 있는 호스트의 DNS suffix 목록, 쉼표 구분. `<namespace>.svc.cluster.local` 이나 사내 존. 명시한 `localhost`는 그 호스트만 허용하며 하위 도메인·IP 주소는 포함하지 않는다. 비어 있으면 SSRF 가드는 원래 그대로다. [SECURITY.md](SECURITY.md#선언된-내부-호스트) 를 보라. |
| `URL_FETCH_INTERNAL_HOST_SUFFIXES` | 비어 있음 | — | `FetchUrl` 빌트인이 사설 주소로 resolve 되는데도 읽어도 되는 호스트의 DNS suffix 목록. 사내 위키, 내부 API. **위와 의도적으로 별개의 목록이다**: 이 앱이 부르는 서비스라고 해서 모델이 설득당해 읽어도 되는 페이지인 것은 아니다. 같은 매칭 규칙(`isDeclaredInternalHost`, 레이블 경계, 명시한 `localhost`만 정확히 허용, 다른 단일 레이블·IP 리터럴 거부), 같은 이유로 env 전용. [SECURITY.md](SECURITY.md#모델이-고른-url). |
| `MANAGED_MCP_RUNTIME` | 미설정 | — | managed MCP 컨테이너를 어떻게 띄우는가. 유일한 값은 `docker`. 앱이 자기 호스트의 Docker CLI 를 직접 구동해 `127.0.0.1:<port>` 로 포트를 게시하고 그 주소를 등록한다. 다른 값은 경고와 함께 무시되어 기능이 꺼진다. 앱 프로세스가 `docker` 바이너리와 호스트 loopback 에 닿아야 한다. 기본 앱 이미지는 Docker CLI를 포함하지만 daemon 접근·권한·loopback 네트워크는 배포가 구성해야 한다. |
| `MANAGED_MCP_REGISTRY` | 미설정 | — | 관리형 MCP 기능을 켜기 위해 필요한 설정이다. 허용 이미지 registry를 제한하는 allowlist는 아니다. 앱이 `docker login` 을 수행하지 않으므로 호스트의 Docker credential 을 미리 준비해야 한다. 이미지 pull 은 호스트가 접근할 수 있는 레지스트리를 사용한다. |

`MANAGED_MCP_RUNTIME` 과 `MANAGED_MCP_REGISTRY` 중 하나라도 설정되지 않으면 managed-MCP 라우트는
기능을 절반만 켜는 대신 `503` 으로 답한다. 컨테이너의 `environment` 값은 저장 시 암호화되고,
Docker 를 호출하기 직전에만 0600 임시 env file 로 복호화된다. 호스트 파일 경로는 입력으로 받지
않는다. `PORT` 는 런타임이 써 넣으므로 거부된다.

로컬 TTL은 일반 캐시 수명, 서버 TTL 상한은 서버의 freshness 힌트를 얼마나 허용할지 결정한다.
편집 후 무효화는 프로세스 로컬이므로 다중 인스턴스의 도구 목록 갱신 지연도 고려한다.
실패한 discovery는 로컬 TTL과 30초 중 작은 기간 동안 캐시한다.
연결·hint·캐시 키의 상세 동작은 [MCP 설계](design/mcp.md#discovery-캐시)에 있다.

## 소스 저장소

| 변수 | 기본값 | Runtime | 설명 |
|---|---|---|---|
| `PLUGINS_REPO` | 미설정 | **runtime** | [Agent Plugins 1.0.0](https://agent-plugins.org/) 저장소의 `owner/repo`. `plugin.json` 을 가진 모든 디렉터리가. 저장소 루트를 포함해. 하나의 plugin 이다. 다른 루트 안에 중첩된 루트는 거부된다. plugin 당: `skills/<name>/SKILL.md` (Agent Skills 스펙, frontmatter 의 `name` 이 디렉터리와 일치해야 하고 `description` 은 필수), `mcp.json` (`type: "streamable-http"` 서버만 바인딩된다. `stdio` 와 `sse` 항목은 보고되고 건너뛰며 결코 실행되지 않는다), 그리고 닫힌 mcp.json 스키마에는 자리가 없는 각 서버의 설명(frontmatter)과 운영 노트(본문)를 담는 `org.opspresso.agent-studio/mcp/<server>.md` 확장 문서. |
| `PLUGINS_REPO_BRANCH` | `main` | **runtime** | |
| `GITHUB_TOKEN` | 미설정 | **runtime** | plugins 저장소에 대한 contents 읽기 권한이 필요하다. |
| `GITHUB_API_URL` | `https://api.github.com` | — | GitHub REST API 가 답하는 곳. GitHub Enterprise Server 나 미러라면 `https://<host>/api/v3`. 끝의 슬래시는 떼어 낸다. |
| `GITHUB_WEB_URL` | public GitHub 또는 표준 GHES API 주소에서 도출 | — | plugin 상세의 repository·commit 링크가 향하는 web base. API mirror나 비표준 경로처럼 도출할 수 없으면 명시하라. 없고 도출할 수도 없으면 잘못된 링크를 만드는 대신 텍스트만 표시한다. |

GitHub에 닿지 않는 배포는 `/plugins`에서 checkout의 tar 아카이브를 올린다.
원격과 업로드 경로는 같은 snapshot·sync 로직을 사용한다. provenance는 설정된 저장소,
없으면 `archive`로 기록한다. 아카이브 sync에는 GitHub token이 필요 없다.

sync는 선언된 이름의 항목을 갱신하고 사라진 항목은 orphan으로 보고한다. 삭제는 별도 작업이며
`mcp.json`의 credential header는 가져오지 않는다. 서버 주소 변경 시 저장된 credential을
새 주소로 옮기지 않는다. [Capabilities 설계](design/capabilities.md#skills)와
[Plugins API](API.md#레지스트리연동-오퍼레이션), [sync 티커](OPERATIONS.md#plugins-sync-티커)를 따른다.

## Slack

| 변수 | 기본값 | Runtime | 설명 |
|---|---|---|---|
| `SLACK_LOADING_INDICATOR` | `:hourglass_flowing_sand:` | — | Slack 답변이 아직 쓰이고 있는 동안 뒤에 붙였다가 마지막 편집에서 떼어 내는 표시. **edit-in-place 폴백에서만 그렇다**. 스트리밍되는 답변은 Slack 자신이 아직 도착 중이라고 표시해 준다. 자기 spinner 이모지를 가진 워크스페이스는 여기에 그 이름을 적는다. 기본값이 내장돼 있는 이유는, 워크스페이스가 정의하지 않은 커스텀 이름은 글자 그대로 렌더링되기 때문이다. |

프로젝트별 Slack 설정. 봇 토큰, signing secret, 추천 프롬프트, 그리고 멘션 없이 봇을 깨우는
**채널 키워드**. 는 환경이 아니라 프로젝트에 산다 (`/agents/{name}/settings`). Agent의
런이 워크스페이스를 *읽어도* 되는지는 Agent 파라미터(`slackWorkspace`)이고 기본은 꺼짐이다.

**생성되는 매니페스트는 릴리즈와 함께 바뀐다.** 이제 `message.channels` 와
`message.groups` 를 구독하고 `channels:read` 를 요청한다. 그 이전에 설치된 앱은 설치 당시의 scope 와 이벤트를
유지하므로, 매니페스트를 다시 적용하고 앱을 재설치하기 전까지 채널 후속 응답과 `SlackChannels`
도구는 작동하지 않는 채로 남는다.

## Telegram

환경에는 아무것도 없다. 프로젝트별 설정. 봇 토큰과 봇이 켜져 있는지 여부. 는 프로젝트에
산다 (`/agents/{name}/integrations`). webhook 시크릿은 거기서 발급되고, 봇을 켜면
`PUBLIC_BASE_URL/api/telegram/webhook/{project}` 에 webhook 이 등록되며 끄면 삭제된다 (*Register
webhook* 은 주소가 바뀐 뒤 다시 가리키는 용도다). 그래서 `PUBLIC_BASE_URL` 은 Telegram 이
도달할 수 있는 주소여야 한다. BotFather 의 *privacy mode* 는 켜 둔 채로 둬도 된다: 어차피 봇은
그룹에서 자기를 지목한 것에만 답한다 ([design/telegram.md](design/telegram.md)).

## Microsoft Teams

환경에는 아무것도 없다. 프로젝트별 설정. Azure Bot 의 Microsoft App ID, 클라이언트 시크릿,
(단일 테넌트 앱이면) 테넌트 id, 켜져 있는지 여부. 는 프로젝트에 산다
(`/agents/{name}/integrations`). Azure 에는 endpoint 를 가리키는 호출이 없으므로 콘솔은
`PUBLIC_BASE_URL/api/teams/messages/{project}` 를 보여 주고 운영자가 Azure Bot 의 messaging
endpoint 에 붙여 넣는다 ([design/teams.md](design/teams.md)).

## Workspace 실행

Workspace 도구 사용 여부는 Agent 설정의 `parameters.workspaceTools`로 선택한다. 현재 설정에서
켜면 프로젝트에 **워크스페이스 도구** 탭이 나타난다. 프로젝트 소유자·관리자는 그 탭에서 저장소 목록,
접근 모드, 기본 Runtime, 유휴 시간, 검사 명령과 배포 workflow를 관리한다. 기본 저장소는 없다.
기본 접근 모드는 `new`(등록 + 신규), 기본 Runtime은 모델 없이 실행하는 `command`다.
Codex·Claude·OpenCode의 모델은 **Model 사용 설정 → 워크스페이스 런타임 모델**에서 관리자가 선택한다.
선택 모델은 DB에 저장되며 환경변수의 모델 선언으로 대체하지 않는다. API 키와 URL은 기존 LLM
채널에서 실행 직전에 읽는다. Workspace 설정이나 모델 선택 응답에 자격증명을 복사하지 않는다.

배포는 Sandbox 실행 인프라만 제공한다.

| 변수 | 기본값 | 계약 |
|---|---|---|
| `WORKSPACE_IMAGE` | 미설정 | `sandbox/Dockerfile`로 만든 이미지. 미설정이면 새 실행을 거절한다 |
| `WORKSPACE_NETWORK` | `none` | egress를 제한한 Docker 네트워크. `host`, `bridge`, `default`는 거절한다 |
| `WORKSPACE_DOCKER_CONTEXT` | Docker 기본 context | 앱과 worker가 공유하는 전용 Docker daemon의 context |
| `WORKSPACE_MEMORY_MB`, `WORKSPACE_DISK_MB`, `WORKSPACE_CPUS` | `2048`, `2048`, `2` | 메모리·각 tmpfs·CPU 상한 |
| `WORKSPACE_WORKER_CONCURRENCY` | `4` | worker process의 동시 실행 수, 1~32 |

프로젝트 저장소·소유자 목록은 각각 최대 100개다. `selected`는 등록한 저장소만,
`owners`는 목록과 정확한 소유자 범위를, `all`은 서버 GitHub 계정으로 접근 가능한 전체를 허용한다.
`new`는 등록 목록을 유지하고 `Workspace.create_repository`의 실제 생성 성공을 자동 등록한다.
[정책 계약](design/workspaces.md#저장소-정책-관리)을 따른다. 유휴 시간은 기본 1800초, 범위는 60초~7일이다.
검사는 `test`, `lint`, `build`별 명령을 최대 하나씩 저장하며 각 Run 뒤 실행한다.

Codex는 Responses 호환 채널, Claude는 Anthropic 채널, OpenCode는 지원하는 OpenAI 호환 채널을
사용한다. OpenCode의 OpenAI 채널은 기본 Responses loader를 쓰고, 다른 호환 채널은 별도 provider와
번들된 `@ai-sdk/openai-compatible`로 Chat Completions를 사용한다. 외부 모델 카탈로그 자동 조회는 끄고
앱에서 선택한 모델을 전달한다. provider/model의 전송용 이름은 유지한다.
선택 가능한 모델은 text·tools 지원과 API 키 채널 연결이 필요하다. `sigv4`는 네이티브
CLI에 제공하지 않는다. 모델을 해제하면 새 native 작업은 거절하지만 이미 시작한 operation의 조회·복구는
유지한다. 일반 명령에는 모델이 필요 없다. Git·클라우드·운영 환경변수는 Sandbox에 상속하지 않는다.
Workspace 실행 시간은 `MAX_RUN_DURATION_MS`를 사용하며 재시작해도 최초 시작 시각에서 계산한다.
일반 명령은 앱 모델 설정 없이 공통 비용·동시성·메트릭 bracket을 사용한다. CLI 모델 사용량은
앱의 SDK 모델 usage와 별개이며 CLI/provider의 사용량 기록을 따른다.

Workspace worker가 자동 정리와 재시작 복구를 담당한다. 별도 worker를 실행하지 않으면 큐·TTL·승인 결과 전달과 CI 대기가
진행되지 않는다. Workspace task와 채팅 후속 실행은 각각 workerConcurrency 상한을 적용하는 별도 큐다. 설치·검증 명령은 [INSTALL.md](INSTALL.md#workspace-worker)를 따른다.

코딩 작업은 GitHub App 또는 서버 계정 토큰을 사용한다. 기본 `WORKSPACE_GITHUB_AUTH=app`은
`WORKSPACE_GITHUB_APP_ID`, `WORKSPACE_GITHUB_INSTALLATION_ID`, `WORKSPACE_GITHUB_PRIVATE_KEY`를
모두 요구한다. `WORKSPACE_GITHUB_AUTH=token`은 설정 화면의 GitHub token을 사용하며, 저장된
오버라이드가 없으면 `GITHUB_TOKEN`을 읽는다. 이 모드는 Git 인증을 서버에서만 수행하고
자격증명이 없는 Git bundle을 Sandbox에 전달한다. 서버에 Git 실행 파일과 임시 디스크 공간이
필요하며 bundle은 체크포인트와 같은 64 MiB 한도를 따른다. API·Git web 주소는 기존 `GITHUB_API_URL`과
`GITHUB_WEB_URL`을 사용한다. `WORKSPACE_GITHUB_INTERNAL_HOSTS`는 폐쇄망 GitHub Enterprise의
호스트 접미사를 선언하며, 다른 내부 URL 허용 목록과 공유하지 않는다.
`WORKSPACE_GITHUB_WEBHOOK_SECRET`은 `/api/workspaces/github/webhook`의 PR 메타데이터 갱신용이다.
`/api/webhook/{project}`는 프로젝트 Settings에서 발급한 별도 Trigger 시크릿을 사용한다.
App에는 Contents, Pull requests, Actions 쓰기와 Checks, Commit statuses 읽기를 부여하되,
각 요청의 installation token은 실제 작업에 필요한 권한과 저장소로 좁힌다.
GitHub App·fine-grained 토큰의 저장소 생성에는 Administration 쓰기가 필요하다. classic 토큰은
공개 저장소에 `public_repo` 또는 `repo`, 비공개 저장소에 `repo` scope가 필요하다. 계정 토큰은 자신의 개인
저장소 또는 권한 있는 조직에 생성하며, App은 설치된 조직에만 생성한다. 생성용 App token은
미래 저장소로 범위를 좁힐 수 없으므로 `administration: write`만 요청하고 서버에서만 사용한다.

Workspace 저장 개수 자체의 전역 고정 상한은 없다. 한 Chat은 실행 프로젝트별 선택을 최대 32개
보관한다. 이는 Workspace 개수나 동시에 실행할 수 있는 작업 수가 아니다. 저장소 목록·조회는
페이지 상한을 적용하고 실제 실행은 worker 동시성·소유자 run slot·시간·자원 한도를 따른다.
체크포인트는 64 MiB의 파일 bytes 또는 20,000개 항목을 넘으면 실패한다.
승인 결과의 Chat 재개는 기존 run lease를 사용하며, 등록된 PR 검사 대기는 15초마다 최대 30분 관찰한다.

## 관측성과 보존 기간

| 변수 | 기본값 | Runtime | 설명 |
|---|---|---|---|
| `OTEL_EXPORTER_OTLP_ENDPOINT` | 미설정 | — | OTLP HTTP base 엔드포인트 (없으면 `/v1/traces` 를 덧붙인다). 설정되면 플랫폼이 영속화하는 모든 trace 가 데이터베이스 쓰기 이후에 OTEL span 으로도 내보내진다. export 실패는 `[otel]` 로그 라인으로 드러날 뿐, 결코 런으로 드러나지 않는다. 설정하지 않으면 export 자체가 없고 OTEL SDK 는 로드되지도 않는다. |
| `OTEL_EXPORTER_OTLP_HEADERS` | 미설정 | — | 표준 `key=value,key2=value2` 형식이며 모든 OTLP 요청에 실려 간다. 대소문자를 보존한다: 값들이 collector 자격증명이고, 정규화된 bearer 토큰은 다른 토큰, 즉 틀린 토큰이 되기 때문이다. |
| `SETTINGS_CACHE_TTL_MS` | `5000` | — | settings 행의 인메모리 TTL. 모든 runtime 오버라이드의 인스턴스 간 낡음에 한계를 둔다. [해석 순서](#해석-순서) 를 보라. 하한이 `1` 이라 `0` 은 캐시를 끄는 대신 기본값으로 떨어진다. |
| `TRACE_RETENTION_DAYS` | `30` | — | Trace의 `createdAt` 기준. 프로젝트 삭제 참조도 같은 만료를 사용한다. |
| `USAGE_RETENTION_DAYS` | `400` | — | 대시보드의 184일 질의 창보다 한참 길게 유지한다. 하한은 `31`. 한 달 전체. 인데, 월간 비용 가드가 그 달의 일별 행들을 합산하기 때문이다. 더 짧은 창은 월말로 갈수록 지출을 조용히 적게 세게 된다. |
| `CHAT_RETENTION_DAYS` | `180` | — | Chat META는 마지막 활동, 화면 메시지는 각 `createdAt`, SDK Session은 저장 시점 기준이다. |
| `WORKSPACE_RETENTION_DAYS` | `180` | — | Workspace 실행·승인·이벤트·암호화된 체크포인트 보존 기간이다. Sandbox가 정리된 Workspace의 META도 이 기간을 따른다. 실행·정리 중인 META는 컴퓨팅 자원 정리 전에 sweep되지 않는다. |
| `TRIGGER_RUN_RETENTION_DAYS` | `30` | — | 실행한 이력의 `startedAt`, 아직 시작하지 않은 이력의 `queuedAt` 기준이다. |
| `ARTIFACT_RETENTION_DAYS` | `180` | — | 런이 만들어 낸 것의 이름을 담는 행. 기본값은 `CHAT_RETENTION_DAYS` 에 맞췄다. 그것이 이미 생성된 이미지의 실효 수명이기 때문이다. **`CHAT_RETENTION_DAYS` 이상으로 유지하라**: 더 짧으면 대화에서 아직 보이는 그림이 자기 갤러리에서 먼저 사라진다. 이 창과 버킷의 lifecycle 규칙은 서로 독립된 두 설정이다. [OPERATIONS.md](OPERATIONS.md#행-보존) 를 보라. |
| `AUDIT_RETENTION_DAYS` | `400` | — | 감사 행위의 `createdAt` 기준이다. |

보존 값은 일 단위 정수이고 최소 `1`이다. Usage만 최소 `31`일을 요구한다. 그 밖의 값은 여기 다른 모든 숫자 설정과 마찬가지로
**경고와 함께** 기본값으로 떨어진다. 운영자가 잘못 넣은 그 값이 바로 행이 얼마나 오래
살아남을지를 정하는 값이라, 조용한 폴백은 최악의 종류다. 만료된 행을 실제로 지우는 것은
**schedule-scan 틱**(`POST /api/triggers/scan`)에 얹힌 sweep 이다. 그래서
scan 호출이 없는 배포에서는 이 창들을 설정해도 DB 만료 sweep이 실행되지 않는다.
[OPERATIONS.md](OPERATIONS.md#행-보존) 를 보라.

## 로컬 스크립트 전용

| 변수 | 기본값 | 설명 |
|---|---|---|
| `MOCK_LLM_PORT` | `8002` | `scripts/mock-llm.ts` 의 리슨 포트. |
| `MOCK_LLM_DELAY_MS` | `0` | 스트리밍되는 chunk 사이의 밀리초. `0` 은 소켓이 받아 주는 만큼 빠르게 보낸다. 스크롤이 생기는 답변을 재현하려면 아래 행과 함께 이 값을 올려라. |
| `MOCK_LLM_CHUNKS` | `0` | 답변이 대략 몇 개의 chunk 로 채워지는지. `0` 은 한 줄짜리 답변을 그대로 둔다. |
| `INTEGRATION_MOCK_PORT` | `8002` | `scripts/integration-check.ts` 가 쓰는 mock LLM 포트. 기본 포트를 이미 점유한 mock 옆에서 검사를 돌릴 수 있도록 오버라이드 가능하다. CI 는 이 값을 설정하지 않는다. |

## 코드에 고정된 제한

이들은 런에 한계를 두며 환경으로 설정할 수 **없다**. 각각 소유 파일이 하나씩 있고, 사본이
생기면 어긋날 자리는 `tests/architecture.test.ts` 가 고정한다.

| 제한 | 값 | 소유자 |
|---|---|---|
| agent 런당 턴 수 (Agent 설정 `maxTurn` 기본값) | `50` | `src/application/runtime/execute.ts` |
| 멤버 tier 제한. 멤버당 동시 런 수 / 월 USD 상한 (`admin` —/—, `member` —/`20`, `guest` `1`/`2`. "—" 는 env 제한을 물려받거나 상한이 없다는 뜻). `guest` 는 추가로 프로젝트를 만들 수 없고 프로젝트 API 토큰도 쓸 수 없다 | `TIER_LIMITS` | `src/domain/member/tiers.ts` |
| SDK function tool 동시 실행 수 | `5` | `src/application/runtime/runner.ts` |
| 턴당 도구 결과 텍스트 | `200,000` 자 | `src/application/llm/toolResultBudget.ts` |
| subagent 로 넘기는 transfer transcript | `8,000` 자 | `src/application/runtime/transcript.ts` |
| subagent 중첩 깊이 | `5` | `src/application/execution/agentBindings.ts` |
| 한 런이 읽을 수 있는 주소 수 (`FetchUrl`) | `20` | `src/application/runtime/tools.ts` |
| `FetchUrl` 하나가 끌어올 수 있는 바이트 | `5 MiB` | `src/application/llm/urlContent.ts` |
| `FetchUrl` 요청 하나, 모델에 도구 에러가 건네지기 전까지 | `15s` | `src/infrastructure/net/httpResource.ts` |
| 가져온 주소 하나에서 유지하는 텍스트 | `90,000` 자 | `src/application/llm/urlContent.ts` |
| 추출 전에 훑어 읽는 HTML 원문 | `500,000` 자 | `src/infrastructure/llm/htmlText.ts` |
| MCP 도구 결과 하나가 나를 수 있는 파일 | `10.5 MB` × 4 | `src/infrastructure/mcp/toolManager.ts` |
| artifact 행에 남기는 프롬프트 발췌 | `500` 자 | `src/application/artifact/storeArtifact.ts` |
| `/view` 가 메모리로 읽어 들이는 artifact | `2 MiB` | `src/domain/artifact/types.ts` |
| `/view`에서 렌더하는 Markdown | `256 KiB`; 넘는 내용은 생략 표시 | `src/app/api/artifacts/[artifactId]/view/_lib/viewPage.tsx` |
| `/view` 가 CSV 에서 그리는 행 수 | `2,000` | `src/app/api/artifacts/[artifactId]/view/_lib/viewPage.tsx` |
| `SaveFile` 생성 및 `File` 평문 편집의 바이트(중간 결과 포함) | `1 MiB` | `src/domain/artifact/types.ts` |
| `/api/objects` 가 proxied 주소 하나에 대해 메모리로 읽어 들이는 오브젝트. 고른 숫자가 아니라 저장될 수 있는 것의 최대(첨부 · 문서 · 저장 파일 상한 중 큰 쪽) | `10 MiB` | `src/infrastructure/storage/artifactAccess.ts` 의 `MAX_PROXIED_OBJECT_BYTES` |
| 올리는 plugins 아카이브. 전송 크기 / 풀었을 때 / 엔트리 수 (헤더 기준, 파일·디렉터리·확장 레코드 모두) | `32 MiB` / `64 MiB` / `20,000` | `src/app/api/plugins/sync/upload/route.ts`, `src/infrastructure/archive/tar.ts` |
| 한 틱의 retention sweep 이 지우는 행 수 (나머지는 다음 틱) | `items` 최대 `5,000` + Better Auth session 최대 `5,000` + SDK Session 최대 `1,000` | `store.deleteExpired`, `memberRepository.deleteExpiredSessions`, `runtimeSessionRepository.sweepExpired` |
| Chat 재접속 로그와 Session 삭제 tombstone의 보존 | 행을 쓴 시각부터 실행 lease + `15분` | `src/infrastructure/db/ttl.ts`의 `RUN_LOG_TTL_SECONDS` |
| Webhook·Schedule의 멱등 claim / 메신저 delivery claim 행 TTL | 생성부터 `24시간`; 실제 삭제는 sweep | `src/infrastructure/db/repositories/triggerRepository.ts`, `inboundClaimRepository.ts` |
| 한 런의 파일 쓰기 시도 수 (`SaveFile`과 `File` 생성·편집 공유) | `10` | `src/application/runtime/tools.ts` |
| 카탈로그 검색 하나가 런에 더할 수 있는 capability 수 (Skill / MCP 서버) | `5` / `3` | `src/application/execution/bindings.ts` |
| 각 MCP 인덱스에 요청하는 카탈로그 매치 수. 그 상한을 넘겨 oversampling 한다. 여러 도구 행이 한 서버로 합쳐지고, 런이 바인딩할 수 없는 후보가 슬롯을 잡아먹어서는 안 되기 때문이다 | MCP 서버 상한의 `4×`(tool 인덱스) / `3×`(server 인덱스) | `src/application/execution/bindings.ts` |
| 카탈로그 검색어 (요청 없을 때의 시스템 프롬프트 / 최근 사용자 턴 / 최신 요청 + 관련 기억) | `2,000` 자 / `3` 턴 / `2,000` 자(각 절반 최대 `1,000` 자) | `src/application/execution/bindings.ts` |
| 메모리 recall (`memoryRecall`): 보내는 질의 / 프롬프트에 유지하는 텍스트 / 첫 토큰이 그것을 기다리는 시간 | `2,000` 자 / `4,000` 자 / `10s` | `src/application/execution/memoryRecall.ts` |
| 인코딩된 대화 id (그것을 넘으면 대화가 없고, API 헤더는 400 으로 답한다) | `512` 자 | `src/domain/execution/actor.ts` 의 `MAX_CONVERSATION_ID_LENGTH` |
| 런당 MCP 도구 준비 상한 (= 128 − 예약 builtin 16개) | `112`; 최종 도구 집합은 위임을 포함해 `128`개 이하 | `src/domain/llm/toolLimits.ts` |
| MCP 도구 결과 하나 | `100,000` 자 | `src/infrastructure/mcp/toolManager.ts` |
| MCP 서버의 HTTP 응답 | `14.5MB` | `src/infrastructure/mcp/session.ts` |
| MCP 서버 하나에서 읽는 `tools/list` 페이지 수 (상한에 닿으면 그 discovery 는 실패한다, SDK 는 부분 카탈로그를 남기지 않는다) | `64` | `src/infrastructure/mcp/session.ts` |
| MCP OAuth 메타데이터 / 토큰 응답 | 각 `256,000 bytes` | `src/infrastructure/mcp/oauthMetadata.ts`, `oauthClient.ts` |
| MCP discovery 캐시 항목 수 | `200` | `src/infrastructure/mcp/discoveryCache.ts` |
| 호스트당 managed MCP 서버 수 / 컨테이너당 메모리·swap·CPU·PID·writable tmpfs | `8` / `512MiB`·`512MiB`·`1`·`256`·`64MiB` | `src/application/mcp/managedMcpUseCases.ts`, `src/infrastructure/mcp/dockerProvisioner.ts` |
| MCP 도구 호출 하나, 모델에 타임아웃 에러가 건네지기 전까지 (도구가 정당하게 몇 분씩 걸릴 수도 있다) | `120s` | `src/infrastructure/mcp/session.ts` |
| MCP discovery. 모든 런의 첫 토큰이 지나는 크리티컬 패스 위에 있어서, 빠르게 실패하고 그 서버의 도구만 잃는다. **요청당**: 연결과 `tools/list` 가 각각 이 값을 받는다 (그래서 느린 서버 하나에 최대 ~20초). 캐시로 제공된 세션의 첫 도구 호출에서 일어나는 지연 연결도 이 값을 받는다 | `10s` | `src/infrastructure/mcp/session.ts` |
| 런이 끝날 때 MCP 세션을 해제하기. 단계별로: 레거시 세션이 보내는 `DELETE`, 그다음 close | 각 `5s` | `src/infrastructure/mcp/session.ts` |
| MCP OAuth well-known 문서 / 토큰 엔드포인트와 RFC 7591 등록 (상수 하나) | `10s` / `15s` | `src/infrastructure/mcp/oauthMetadata.ts`, `oauthClient.ts` |
| Slack Web API 호출 하나 / Slack 파일 전송 하나 | `30s` / `120s` | `src/infrastructure/slack/client.ts` |
| Telegram Bot API 호출 하나 / Telegram 파일 전송 하나 | `30s` / `120s` | `src/infrastructure/telegram/client.ts` |
| Bot Framework(Teams) 호출 하나 / 첨부 전송 하나 | `30s` / `120s` | `src/infrastructure/teams/client.ts` |
| Bot Framework 서명 키 캐시 / 모르는 `kid` 에 대한 재조회 최소 간격 / 토큰 시각 skew / 앱 토큰 만료 여유 | `24h` / `60s` / `5m` / `60s` | `src/infrastructure/teams/client.ts` |
| OpenAI-compatible SDK client cache (text / image / embedding, adapter별) / Teams 앱 token cache | 각 `16` / `32` | `src/infrastructure/llm/clientCache.ts`, `src/infrastructure/teams/client.ts` |
| 프로젝트 설정에 표시하는 최근 Telegram destination | `100` | `src/application/telegram/projectTelegram.ts` |
| GitHub API 요청 하나 (plugins sync) | `15s` | `src/infrastructure/github/client.ts` |
| 인터랙티브(Slack, Telegram, Teams) 런 데드라인 | `3` 분 | `src/shared/runDeadline.ts` |
| 턴당 입력 이미지 수 / 이미지당 바이트(입력·생성·MCP) | `4` / `5 MiB` | `src/domain/llm/imageLimits.ts` |
| PDF에 삽입하는 PNG의 총 디코딩 픽셀 | `16,777,216` | `src/domain/llm/imageLimits.ts`의 `MAX_PDF_IMAGE_PIXELS` |
| 앱 프로세스당 문서 워커 동시 실행 / 대기 작업 | `2` / `8` | `src/infrastructure/documents/workerPool.ts` |
| 문서 작업 기한 (대기 포함) / 자식 V8 old-space | `30s` / `256MiB` | `src/infrastructure/documents/workerPool.ts` |
| 문서 생성 Markdown / 편집 요청 JSON 문자 예산 | `500,000` 자 | `src/infrastructure/documents/engine/limits.ts`, `workerPool.ts` |
| Office ZIP 엔트리 / 전체 전개 / 단일 엔트리 / 압축비 | `2,000` / `100 MiB` / `25 MiB` / `1,000` | `src/infrastructure/documents/engine/limits.ts` |
| 문서 XML 이벤트 / 깊이 | `1,000,000` / `256` | `src/infrastructure/documents/engine/limits.ts` |
| Spreadsheet 처리 행 / 셀 / 검사 셀 | `100,000` / `1,000,000` / `10,000` | `src/infrastructure/documents/engine/limits.ts` |
| 문서 검사 block / block preview 문자 | `500` / `120` | `src/infrastructure/documents/engine/limits.ts` |
| 생성·편집 문서 출력 | `10,000,000` bytes | `src/infrastructure/documents/engine/limits.ts` |
| 문서 생성 이미지 asset 수 / 총 바이트 | `12` / `6 MiB` | `src/domain/document/processor.ts` |
| File 읽기·검사 텍스트 / 한 번의 편집 수 | `90,000` 자 / `100` | `src/domain/document/processor.ts` |
| XLSX 생성 시트 JSON 입력(UTF-8) | `10 MiB` | `src/infrastructure/documents/workerPool.ts` |
| 턴당 문서 수 / 각 바이트 | `4` / `10 MiB` | `src/domain/llm/documentLimits.ts` |
| 유지하는 추출 텍스트, 문서당 / 턴당 | `20,000` / `40,000` 자 | `src/domain/llm/documentLimits.ts` |
| 턴을 나르는 요청 본문 (첨부 상한에서 파생) | `84,148,240 bytes` (약 `80.25 MiB`) | `src/app/api/_lib/body.ts` |
| 프로세스가 동시에 보유하는 attachment-scale turn 본문 바이트 (`256KiB` 초과분만 과금, 상한은 최대 turn 본문의 2배) | `168,296,480 bytes` (약 `160.5 MiB`) | `src/app/api/_lib/body.ts` |
| Skill 첨부. 파일당 바이트 / skill 당 파일 수 / skill 당 바이트 (어느 하나라도 넘는 파일은 sync 에서 건너뛰고 이유를 보고한다) | `64 KiB` / `20` / `200 KiB` | `src/domain/skill/files.ts` |
| 레지스트리 또는 Agent 설정 편집의 요청 본문 (skill 파일 상한에서 파생) | `456 KiB` | `src/app/api/_lib/body.ts` |
| 턴이 넘칠 때 유지하는 transfer transcript 한 줄 | 최소 `500` 자 | `src/application/runtime/transcript.ts` |
| 컨텍스트 예산 추정 (ASCII / 그 외 / 이미지 part / 여유분) | 토큰당 `3` 자 / 자당 `1.5` 토큰 / `2,500` 토큰 / `2,000` 토큰 | `src/application/llm/contextBudget.ts` |
| 런의 컨텍스트 예산이 잘라 낼 때 유지하는 도구 결과 | 최소 `500` 자 | `src/application/llm/toolResultBudget.ts` |
| chat 메시지 하나가 보관하는 텍스트 (답변 · 도구 결과) | `350,000` 바이트 | `src/application/chat/run.ts` |
| chat 메시지 하나가 보관하는 추론. 답변 **뒤에**, 같은 아이템 예산에서 | `40,000` 바이트 | `src/application/chat/run.ts` |
| SDK Session 이력 | `256` items / 이미지 bytes를 제외한 JSON `150,000`자; 최신 완전한 턴은 보존 | `src/application/runtime/session.ts` |
| SDK Session/checkpoint 저장 원문 | `64MiB`; 압축 후 인증 암호화 | `src/application/runtime/session.ts` |
| Agent 정책의 입력 문자 상한 설정 범위 / 각 도구 정책 목록 | `1`–`1,000,000` / 최대 `128`개, 이름당 `1`–`64`자 | `src/app/api/projects/_lib/schemas.ts`의 `agentParametersSchema` |
| 승인 재개 요청의 결정 수 / 승인 항목 ID | `1`–`128`개 / SHA-256 hex `64`자 | `src/app/api/chats/[chatId]/approval/route.ts`, `src/application/runtime/session.ts` |
| 다음 턴의 SDK Session 이미지 | 최신 `4`개 | `src/application/runtime/historyImages.ts`, `src/domain/llm/imageLimits.ts` |
| 인바운드 webhook / Slack 이벤트 / Telegram update / Teams activity 본문 | 넷이 함께 `1MB` | `src/app/api/_lib/inboundEvent.ts` 의 `MAX_INBOUND_EVENT_BYTES` |
| webhook 의 message-mode payload / 트리거 이력에 저장하는 result·error·warning 각각 | `20,000` 자 / `2,000` 자 | `src/application/trigger/runTrigger.ts` |
| 컨텍스트로 쓰는 Slack 스레드 턴 수 | `50` | `src/application/slack/handleSlackEvent.ts` |
| 컨텍스트로 쓰는 transcript 턴 수 / 합계 문자 수 / 한 턴에서 유지하는 문자 수 (Telegram, Teams) | `50` / `100,000` / `20,000` | `src/application/messaging/transcriptHistory.ts` |
| Telegram 앨범의 캡션 없는 멤버가 claim 전에 기다리는 시간 | `1s` | `src/application/telegram/handleUpdate.ts` |
| Slack 스레드 제목 | `60` 자 | `src/application/slack/handleSlackEvent.ts` |
| 모든 chat-bot 표면에서의 이력 이미지 되짚기 범위 | `10` 메시지 | `src/application/messaging/attachments.ts` |
| 프로젝트당 Slack 추천 프롬프트 수 | `4` | `src/domain/slack/types.ts` |
| Slack 프롬프트 제목 / 메시지 / agent 설명 | `80` / `500` / `300` 자 | `src/domain/slack/types.ts` |
| Slack 앱의 짧은 설명 | `140` 자 | `src/domain/slack/types.ts` |
| Slack 중단 요청 확인 주기 | `1` 초 | `src/application/slack/watchStop.ts` |
| Slack thread 중단 기록 보존 | `24h` | `src/infrastructure/db/ttl.ts` |
| Slack thread 실행 lease | `90` 초, 남은 시간이 절반 이하일 때 갱신 | `src/infrastructure/db/ttl.ts`, `slackRunControlRepository.ts` |
| 프로젝트당 Slack 채널 키워드 수 / 각 길이 | `20` / `2`–`50` 자 | `src/domain/slack/types.ts` |
| 봇이 답한 채널 스레드에서 참여 상태로 머무는 시간 (답할 때마다 갱신) | `24h` | `src/infrastructure/db/ttl.ts` |
| 채널 체크리스트가 나열할 수 있는 서로 다른 도구 수, 그 뒤의 것들은 한 행을 함께 쓴다 | `25` | `src/application/slack/replyStream.ts` |
| `SlackHistory`/`SlackThread` 읽기 하나가 돌려주는 메시지 수 (기본값 / 상한) | `20` / `100` | `src/application/slack/workspaceRead.ts` |
| `SlackChannels` 목록 하나가 돌려주는 채널 수 | `200` | `src/application/slack/workspaceRead.ts` |
| Slack transcript 또는 리액션 목록 하나가 이름으로 해석하는 사람 수 (한 번에 최대 `5` 명) | `25` | `src/application/slack/workspaceRead.ts` |
| `SlackUsers` 검색 하나가 훑는 `users.list` 페이지 수 (멈췄다는 사실을 보고한다) | `5` × `200` | `src/application/slack/workspaceRead.ts` |
| `SlackUsers` 검색 하나가 출력하는 매치 수 (나머지는 개수만 센다) | `20` | `src/application/slack/workspaceRead.ts` |
| Slack 답변 쓰기 주기 (스트림 / 편집) | `1s` / `3s` | `src/application/slack/replyStream.ts` |
| 스트리밍되는 Slack `markdown_text` 쓰기 하나 (Slack 자신의 상한이다. edit-in-place 폴백은 잘리지 않는다) | `12,000` 자 | `src/application/slack/replyStream.ts` |
| Slack 상태 갱신 (Slack 은 `2m` 에 만료시킨다) | `45s` | `src/application/slack/replyStream.ts` |
| Slack 프로필 캐시 (성공 / 실패 / 항목 수) | `1h` / `1m` / `2000` | `src/infrastructure/slack/profileCache.ts` |
| Telegram 메시지 하나 (Telegram 자신의 상한이다. 더 긴 답변은 다음 메시지로 이어지며, 마지막 `800` 자 범위에서 공통 문단·줄·문장·공백 경계를 선택한다) | `4,096` 자 | `src/application/telegram/replyChannel.ts` |
| Telegram 답변 편집 주기 / typing 갱신 (Telegram 은 typing 을 `5s` 에 만료시킨다) | `2s` / `4s` | `src/application/telegram/replyChannel.ts` |
| Teams 메시지 하나 (더 긴 답변은 다음 메시지로 이어진다) / inline 그림 (Teams 가 문서화한 상한) | `20,000` 자 / `1 MiB` | `src/application/teams/replyChannel.ts` |
| Teams 답변 편집 주기 / typing 갱신 | `2s` / `3s` | `src/application/teams/replyChannel.ts` |
| Telegram·Teams 대화의 턴을 유지하는 기간 | `7` 일 | `src/infrastructure/db/ttl.ts` |
| usage 요약 질의 범위 | `184` 일 | `src/app/api/usages/summary/validation.ts` |
| 프로젝트 호출자 usage 한 요청의 원시 행 / 반환·Slack 프로필 해석 수 | `10,000` / `100` | `src/application/usage/listActors.ts` |
| schedule 따라잡기 창 (장애가 한 번에 발화시킬 수 있는 양에 한계를 둔다) | `10` 분 | `src/application/trigger/scanSchedules.ts` |
| scan tick 하나가 동시에 굴리는 schedule 발화 수 | `8` | `src/application/trigger/scanSchedules.ts` |
| 대기 중 schedule 예약 갱신 간격 / 유실 판정 | 실행 lease의 `1/3` / 마지막 queue lease 만료 | `src/application/trigger/queuedFiring.ts`, `repairLostRuns.ts` |
| schedule 복구 스윕 주기 (잃어버린 런 회수) | `5` 분마다 | `src/application/trigger/scanSchedules.ts` |
| 복구 스윕 하나가 훑는 행 수 | `50` | `src/application/trigger/repairLostRuns.ts` |
| 트리거 런을 유실로 판정하는 시점 | 런 lease 만료 + `10` 분 | `src/application/trigger/repairLostRuns.ts` |
| SSE 응답이 첫 chunk 를 기다리는 유예 | `25s` | `src/app/api/_lib/sse.ts` 의 `FIRST_CHUNK_GRACE_MS` |

### 런 전체의 컨텍스트 예산

`contextBudget.ts`는 agent의 입력·도구 정의·출력·도구 결과·위임 응답이 함께 쓰는 문맥을 추정한다.
모델별 입력 용량은 `contextWindow − 출력 예약 − 프로토콜 여유`이고, fallback이 있으면
두 모델의 용량 중 작은 쪽을 쓴다. 출력 예약은 Agent 설정의 `maxTokens`, 없으면 각 모델의
카탈로그 출력 상한이다.

토큰은 위 표의 문자·이미지 추정값으로 계산한다. 결과가 남은 예산을 넘으면 표시 문자열까지
포함해 자르고 warning으로 알린다. 등록 모델의 윈도 정보가 없거나 입력·도구만으로 양의 예산을
확보하지 못하면 문맥 예산을 강제할 수 없다. 이 경우의 경고를 확인해야 하며 provider가
요청을 수락한다고 보장하지 않는다.

## 오디오 전사 설정

오디오의 [처리 계약](design/audio-processing-spec.md)은 HTTP API·Agent 도구·별도 worker에서 공유한다. Memory delivery에는 수신 서버의 수집·멱등 저장 계약이 필요하다.
worker 실행과 별개로 schedule을 설정해야 하며 이 값을 넣는 것만으로 자동 수집이 시작되지는 않는다.
원본·전사·요약은 기존 `S3_BUCKET_NAME`을 재사용한다. 비공개·versioning 비활성화와 경로별
보존 정책은 [설치 안내](INSTALL.md#오디오-worker)를 따른다. 별도 원본 bucket 설정은 없다.

| 변수 | 기본값 | 역할 |
| --- | --- | --- |
| `TRANSCRIPTION_RESPONSE_FORMAT` | `json` | `json`, `verbose_json`, `diarized_json` 중 provider가 지원하는 형식 |
| `TRANSCRIPTION_CHUNKING_STRATEGY` | 미설정 | provider가 지원할 때만 `auto` 사용 |
| `TRANSCRIPTION_MAX_INPUT_BYTES` | `26214400` | 변환된 구간 하나의 provider 전송 상한. 원본 파일 상한과 별개 |
| `TRANSCRIPTION_SEGMENT_SECONDS` | `300` | 구간 길이 상한. byte 상한이 더 작으면 그에 맞춰 분할 |
| `FFMPEG_PATH` | `ffmpeg` | 운영 이미지에 설치된 오디오 decoder 실행 파일 |

전사 모델은 카탈로그의 Transcription 타입이어야 한다. HTTP multipart를 지원하지 않는 SigV4
채널과 미설정 채널은 거절한다. 비용 계산에 필요한 사용량이 없으면 결과는 unknown이며 0이 아니다.
이 경우 작업은 transcription_cost_unknown으로 중단하므로 provider 응답의 사용량·가격 계약을 확인한다.

오디오 고정 한계는 다음 코드가 소유한다. 앱의 일반 문서 처리·런 제한과 별도로 적용한다.

| 한계 | 값 | 소유 코드 |
| --- | --- | --- |
| 원본 파일 크기 / 미완료 업로드 유효 시간 | 512 MiB / 24시간 | `src/application/artifact/sourceFiles.ts` |
| 원본 오디오 길이 | 6시간 | `src/domain/audio/segmenter.ts` |
| 다운로드 / 구간 전사 요청 제한 | 각각 10분 | `src/infrastructure/net/sourceDownloader.ts`, `src/infrastructure/llm/transcription.ts` |
| 비공개 파일 object 요청 / 삭제·multipart 정리 요청 | 10분 / 30초 | `src/infrastructure/storage/sourceObjectStore.ts` |
| worker 동시 작업 / poll / 만료 sweep | 2개 / 10초 / 60초 | `src/application/audio/worker.ts` |
| job lease / heartbeat / 실행 구간 | 2분 / 30초 / 24시간 | `src/application/audio/processJob.ts` |
| 자동 재시도 대기 | 1·5·15·60분, 최초 포함 5회 | `src/application/audio/processJob.ts` |
| 후처리 입력 / 출력 / 호출 수 | 16,000자 / 최대 6,000자 / 64회 | `src/application/audio/postprocess.ts` |

수동 재시도는 실행 구간만 새로 시작하며 원본·파생 파일의 만료를 연장하지 않는다.
프로젝트의 maxActive·maxPerOccurrence 기본은 각각 1이며, 저장 설정에서 1–100 범위로 지정한다.

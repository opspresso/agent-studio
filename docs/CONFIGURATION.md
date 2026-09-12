# 설정

Agent Studio 가 환경에서 읽는 모든 값, 그리고 코드에 고정돼 있어 *설정할 수 없는* 제한들.
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

오버라이드 계층은 admin 전용 `/settings` 페이지다. 아래 표에서 **runtime** 으로 표시된 키만
거기서 오버라이드할 수 있고, 나머지는 전부 env 전용이다. settings 행을 읽기 전에 필요한
값이거나(`AES_ENCRYPTION_KEY` 가 그 행을 복호화한다) 프로세스가 이미 묶여 있는
인프라이기 때문이다(`STAGE`, `DATABASE_URL`, Better Auth).

읽기는 `src/lib/runtime-settings.ts` 를 지나가며, dispatch 시점에 `process.env` 를 직접
읽는 일은 결코 없다. 그러지 않으면 오버라이드가 settings 페이지에서만 적용되고 다른
어디에도 적용되지 않는다. 값은 `SETTINGS_CACHE_TTL_MS` 동안 메모리에 캐시되고 쓰기 시
캐시가 무효화되지만, **무효화는 프로세스 로컬**이다: 다중 인스턴스 배포에서 TTL 은 강등된
admin 이나 회전된 A2A 키가 그 쓰기를 처리하지 않은 인스턴스들에서 계속 동작하는 시간이다.
기본값이 1분이 아니라 5초인 이유가 그것이다.

settings 쓰기는 최신 `SETTINGS#app` 행을 row lock 아래에서 읽고 patch를 합친 뒤 같은 transaction
에서 저장한다. 일반 설정 저장, A2A key 회전, Embedding/Rerank 선택이 동시에 도착해도 한 요청의
오래된 full-row snapshot이 다른 요청의 필드를 되돌리지 않는다. Embedding migration 동안의
vector/query model 일치는 별도의 reindex lease generation이 지킨다. 검색은 시작 전·vector 조회
후·반환 직전에 generation을 비교하고, migration과 겹쳤으면 결과를 버린다.

오버라이드와 환경변수는 *"설정돼 있는가?"* 에 같은 방식으로 답한다: 비어 있거나 공백뿐인
값은 **설정되지 않음**으로 치고, 유효 값이 되는 대신 다음 계층으로 떨어진다.
`/settings` 에서 빈 칸을 저장하면 오버라이드가 제거되고, `A2A_API_KEY=" "` 는 키가 아니다. 부팅
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
| `assertRequiredConfig` | `DATABASE_URL`, `LLM_BASE_URL`, `LLM_API_KEY`, `AES_ENCRYPTION_KEY` 가 모든 stage 에서 설정돼 있어야 한다. 암호화 키는 canonical base64 로 인코딩한 정확히 32바이트여야 한다. |
| `assertAccessControlConfig` | `NODE_ENV=production` 은 명시적인 `STAGE` 를 요구한다. `STAGE=alpha` 또는 `prod` 는 추가로 `ADMIN_EMAILS` 와 **로그인 수단 하나 이상**(`OIDC_ISSUER`/`OIDC_CLIENT_ID`/`OIDC_CLIENT_SECRET`, `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET`, 또는 `AUTH_PASSWORD=true`)을 요구한다. 빈 `ALLOWED_EMAIL_DOMAINS` 는 모든 도메인을 허용하는 정상 설정이다. |

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
| `DATABASE_URL` | — (필수) | — | PostgreSQL 접속 문자열 (`postgres://user:pass@host:5432/db`). 이 앱의 모든 행. 아이템 테이블, Better Auth 의 테이블, capability 카탈로그의 벡터. 이 여기 있다. 서버에 `pgvector` 확장을 *만들 수 있어야* 한다 (`CREATE EXTENSION IF NOT EXISTS vector` 를 부팅 때 앱이 실행한다). 스키마는 부팅 때 마이그레이션된다. |
| `DATABASE_POOL_SIZE` | `10` | — | 인스턴스 하나가 열어 두는 커넥션 수. 런은 모델 호출 동안 커넥션을 쥐지 않고 밀리초 단위로만 빌리므로 10 이면 넉넉하고, 함대 전체가 기본 `max_connections` 100 아래에 남을 만큼 작다. 하한 `1`. |
| `AWS_REGION` | `ap-northeast-2` | — | AWS 를 쓰는 기능. Bedrock 임베딩, `S3_ENDPOINT` 없이 AWS S3 자체를 쓸 때의 클라이언트. 이 쓰는 리전. 그 밖에는 읽히지 않는다. |
| `AES_ENCRYPTION_KEY` | — (필수) | — | 32바이트 base64. 저장되는 모든 시크릿을 암호화하고, proxied 오브젝트 주소의 서명 키도 여기서 HKDF 로 파생된다. [SECURITY.md](SECURITY.md#저장된-시크릿) 를 보라. |
| `S3_BUCKET_NAME` | 미설정 | — | Artifacts의 공통 버킷. 일반 생성 파일은 `artifacts/<kind>/`, 비공개 오디오·전사·요약은 `source-files/`에 저장한다. 어느 S3 호환 스토어든 된다 (MinIO, Garage, Ceph RGW, AWS S3). 행에는 오브젝트 키가 저장되고 URL 은 절대 저장되지 않는다. 자격증명은 스토어 자신의 `S3_ACCESS_KEY_ID`/`S3_SECRET_ACCESS_KEY` 쌍이고, 비어 있으면 SDK 기본 체인(`AWS_*`, 인스턴스 역할, AWS 자신에는 이것이 맞다)이다; 그 주체에게는 (레거시 `images/*` 만이 아니라) **`artifacts/*`와 `source-files/*`**의 put·get·delete와 비공개 파일의 multipart 업로드 권한이 있어야 한다. 설정하지 않으면 영속화가 통째로 꺼진다: 런은 여전히 그림을 그리고, 바이트는 표면까지 도달했다가 거기서 멈추며, artifact 갤러리는 404 로 답한다. |
| `S3_ENDPOINT` | 미설정 | — | AWS 가 아닌 스토어의 주소 (`http://minio:9000`). 설정되면 path-style 로 주소를 만든다. 자체 호스팅 엔드포인트는 버킷 서브도메인을 해석하지 못하는 것이 보통이다. 비어 있으면 SDK 자신의 리전·자격증명 해석으로 AWS S3 에 간다. |
| `S3_ACCESS_KEY_ID` / `S3_SECRET_ACCESS_KEY` | 미설정 | — | 오브젝트 스토어의 키 쌍. `AWS_*` 에 넣지 않는다. 그 쌍은 프로세스의 다른 모든 AWS 클라이언트(Bedrock 채널·Cohere 임베딩)가 읽으므로, MinIO 의 키를 거기 두면 AWS 에 MinIO 키로 서명하게 된다. 비어 있으면 SDK 기본 체인을 따른다. |
| `S3_PUBLIC_BASE_URL` | 미설정 | — | `public` 모드에서 독자가 오브젝트에 닿는 base 가 앱이 업로드하는 엔드포인트와 다를 때 (리버스 프록시 뒤의 MinIO). 비어 있으면 `S3_ENDPOINT`/`<bucket>`, 그것도 없으면 AWS 의 virtual-host 형태. |
| `ARTIFACT_ACCESS_MODE` | `authenticated` | **runtime** | 독자가 저장된 오브젝트에 어떻게 닿는가. **`proxied`**. 앱 자신의 주소 `PUBLIC_BASE_URL/api/objects/<key>?exp=&sig=[&dl=]` 를 건네고 앱이 바이트로 답한다(`PUBLIC_BASE_URL` 이 없으면 경로만, 콘솔은 같은 origin 이라 닿지만 Slack·A2A 같은 외부 독자에게는 주소가 아니다). 모델 입력 이미지는 URL이 아니라 저장소에서 읽은 bounded inline bytes로 전달된다. 스토어는 앱에게만 닿으면 되므로 설치형의 선택이다. 토큰이 증명하는 것과 수명은 [SECURITY.md](SECURITY.md#데이터-노출과-보존). **`authenticated`**. 유효 기간이 있는 스토어의 pre-signed URL. 브라우저가 스토어에 직접 닿을 수 있어야 한다. **`public`**. 영구적인 직접 URL. 버킷 정책이 `artifacts/*` 와 레거시 `images/*` 의 공개 읽기를 허용할 때만 동작한다. **다운로드 링크는 `public` 에서도 pre-signed 다**: 브라우저가 저장할 파일명이 요청 서명에 실려 가는데 S3 는 익명 GET 에서 `response-*` 오버라이드를 거부하기 때문이다. 그래서 `public` 모드에서 문서의 주소는 유효 기간이 있고 이미지의 주소는 영구로 남는다. public 모드는 갤러리 메타데이터와 삭제가 인증을 유지하더라도 URL 을 손에 넣은 누구에게나 오브젝트를 노출한다. 모르는 값은 `authenticated` 로 fail-closed 된다. |
| `CATALOG_ENABLED` | `false` | — | `true` 면 이 배포가 capability 카탈로그를 갖는다. 벡터는 데이터베이스의 `catalog_vectors` 에 있고 따로 가리킬 것은 없다. 설정하지 않으면 `POST /api/catalog/reindex` 는 503 으로 답하고, 런은 자기 버전이 바인딩한 것만 제공한다. 그 503 에는 원인이 둘 있고 토큰 검사가 먼저 돌므로, `SCHEDULE_SCAN_TOKEN` 이 설정되지 않은 경우에도 메시지만 다른 같은 상태 코드가 나온다. 기본이 꺼짐인 이유: 카탈로그에는 배포의 채널이 서빙하는 임베딩 모델이 필요한데 부팅 때 그것을 확인할 길이 없다. 켜는 것은 그 모델이 있다는 선언이다. |
| `EMBEDDING_PROVIDER` | `openai` | — | `openai` \| `cohere` \| `bedrock`. `openai` 는 `EMBEDDING_BASE_URL` 이 있으면 전용 채널을, 없으면 `LLM_BASE_URL`/`LLM_API_KEY` 를 재사용하며 그 엔드포인트가 `/embeddings` 를 제공할 것을 요구한다. OpenAI 호환이면 무엇이든 되므로 폐쇄망의 vLLM · TEI · Ollama 가 여기 해당한다. `cohere` 와 `bedrock` 은 Bedrock 을 통해 가고 프로세스의 AWS 자격증명(`bedrock:InvokeModel`)을 쓴다. 인식되지 않는 값은 무엇이든 `openai` 로 읽힌다. 어느 모델을 고를지는 아래 표의 실측을 보라. |
| `EMBEDDING_BASE_URL` / `EMBEDDING_API_KEY` | 미설정 | — | OpenAI 호환 embedding 전용 채널. 등록된 공개 모델의 provider 채널이 있으면 그 URL·key·wire ID를 우선 사용한다. Self-hosted 모델은 이 전용 채널을 사용하며, base URL 이 없으면 기본 LLM 채널을 재사용한다. base URL 만 설정한 인증 없는 endpoint에는 비밀이 아닌 placeholder credential을 보내며 LLM key를 전달하지 않는다. 인증이 필요하면 API key도 설정하라. |
| `EMBEDDING_MODEL` | provider 별로: `text-embedding-3-small`, `global.cohere.embed-v4:0`, `amazon.titan-embed-text-v2:0` | **models** | 배포 기본값. `/models`에서 Embedding 타입의 등록 모델을 선택하면 DB override가 우선한다. 선택 변경은 승인 뒤 전체 인덱스를 다시 만들며, 실패하면 이전 선택과 vector를 복원한다. 두 모델에서 나온 벡터는 비교할 수 없다. Cohere v4 는 **inference profile** 을 통해 도달한다. |
| `EMBEDDING_DIM` | `1024` | — | provider 에 요청하는 폭. `native` 는 폭 파라미터를 생략해 모델의 native dimension을 쓴다. 테이블의 모든 행이 같은 폭이어야 pgvector 가 거리를 계산하므로 값을 바꾼 뒤 반드시 재색인하라. Cohere v4, Titan v2, OpenAI v3처럼 폭 선택을 지원하는 모델은 명시값을 사용하고, 폭 파라미터를 거부하는 모델은 `native` 를 사용한다. |
| `CATALOG_MIN_SCORE` | `0.25` | — | 관련성 하한, 범위는 `[0, 1]`. 이 값은 검색이 아니라 **임베딩 모델**에 속한다, `EMBEDDING_MODEL` 이 바뀔 때마다 다시 측정하라. 그러지 않으면 카탈로그가 전부 답하거나 아무것도 답하지 않는다. 아래 표를 보라. `TRACE_SAMPLE_RATE` 처럼 폴백하는 대신 경고와 함께 `0`–`1` 로 **clamp** 된다. 숫자가 아닌 값은 기본값을 쓴다. 이것은 컷의 절반일 뿐이고, 나머지 절반은 그 쿼리 자신의 최고 점수에 대한 쿼리별 비율이며, 둘 중 높은 쪽이 이긴다, 그래서 `0` 으로 clamp 된 값이 전부를 통과시키지는 않는다. 비율이 볼 수 없는 경우, 즉 카탈로그에 맞는 것이 아예 하나도 없다는 경우에 대한 답을 없앨 뿐이다. |
| `RERANKER_BASE_URL` / `RERANKER_MODEL` | 미설정 | `RERANKER_MODEL`은 **models** | 둘을 함께 설정하면 query별로 모든 capability kind의 오버샘플 vector 후보를 한 `/rerank` 호출로 2차 정렬한다. endpoint 실패는 기존 cosine/name 순위로 격하되고, 사용자 취소는 즉시 전파된다. `RERANKER_MODEL`은 배포 기본값이고 `/models`의 Rerank 타입 선택이 DB override한다. 등록된 공개 모델의 provider 채널이 있으면 그 URL·key·wire ID로 probe와 검색을 수행한다. Self-hosted 모델은 reranker 전용 채널을 사용한다. 하나만 설정하면 부팅을 거부한다. 미설정이면 기존 cosine/name 순위를 그대로 쓴다. |
| `RERANKER_API_KEY` | 미설정 | — | reranker의 선택형 Bearer credential. 인증 없는 사내 vLLM endpoint는 비워 둔다. |
| `RERANKER_MIN_SCORE` | `0.01` | **models** | activation된 reranker relevance score의 noise floor. 각 query에서 최고 점수의 10%와 이 값 중 높은 쪽을 최종 하한으로 쓴다. 범위 밖 env 값은 `0`–`1`로 clamp한다. capability 설명은 답 자체가 아니라 답을 만들 도구이므로 adapter는 전용 instruction을 함께 보낸다. 모델을 바꾸면 다시 측정하고 `/models`에서 함께 저장하라. DB override가 env보다 우선하며 다음 검색부터 적용된다. |
| `PUBLIC_BASE_URL` | `BETTER_AUTH_URL`; 일반 URL 조립은 요청 origin, 없으면 `http://localhost:3000` | **runtime** | 바깥을 향하는 URL (A2A Agent Card, Slack 매니페스트, MCP OAuth 콜백, MCP client ID 메타데이터 문서)을 만들 때 쓰는 scheme + host. 리버스 프록시 뒤에서는 요청 URL 이 bind 주소를 반영하므로 이 값은 설정에서 와야 한다. 요청 origin 단계는 요청이 손에 있는 일반 URL 조립에서만 적용된다. A2A Agent Card 경로에는 요청이 없어서, 두 변수 모두 설정되지 않으면 카드가 `localhost` 를 광고한다. **거부된 사인인의 리디렉션(`/login?error=`)은 부팅 시 env 값으로 고정된다**: Better Auth 옵션은 한 번만 평가되므로 runtime 설정을 보지 못하고, env 가 비어 있으면 상대 경로가 되어 프록시 뒤에서 bind 주소 기준으로 해석될 수 있다. OIDC/Google 사인인을 쓰는 배포는 env 로도 설정하라. **MCP client ID 메타데이터 문서는 예외다**: 설정된 base 가 없으면 요청 origin 이나 localhost 를 추측하지 않고 503 으로 답한다. 그 URL 이 곧 OAuth `client_id` 이고 authorization server 가 가져가므로, loopback 이나 평문 http 값이면 흐름이 시작되기 전에 거부되고 provider 가 제공하는 경우 연결은 dynamic registration 으로 폴백한다. [SECURITY.md](SECURITY.md#mcp-oauth) 를 보라. |

### 임베딩 모델 선택

영어로 기술돼 있고 한국어로 질의되는 opspresso 의 레지스트리를 대상으로, 파이프라인 전체를
통과시켜 측정했다 (셋 중 Titan 과 Cohere 는 Bedrock 경유, `3-large` 는 OpenAI 호환 엔드포인트
폐쇄망의 자체 임베딩 서버도 같은 `openai` 경로로 붙고 같은 방법으로 다시 재면 된다):

| 모델 | 정답 | 무관 | 한국어 질의, 영어 설명 |
|---|---|---|---|
| `amazon.titan-embed-text-v2:0` | 0.34–0.41 | 0.04–0.12 | **0.065**. 노이즈와 구별되지 않는다 |
| `text-embedding-3-large` | 0.41–0.58 | 0.21–0.22 | 0.169. 노이즈보다 *아래* |
| **`global.cohere.embed-v4:0`** | 0.30–0.53 | 0.21–0.24 | **0.393**. 노이즈에서 확실히 벗어난다 |
| `Qwen/Qwen3-Embedding-4B` | 0.81–0.83 | 0.25–0.46 | **0.811**. `EMBEDDING_DIM=native`, `CATALOG_MIN_SCORE=0.5` |

관리형 세 모델 중 실제 케이스를 갈라내는 것은 Cohere 뿐이다. Titan 에서
"깃헙 레포 알려줘" 는 `github` 서버에 대해 0.065, 무관한 skill 에 대해 0.041 이 나와서
어떤 임계값으로도 찾아낼 수 없다. `3-large` 에서는 무관한 행들보다 *낮은* 점수가 나온다. Cohere 는 토큰당 비용이
`3-large` 와 비슷하고 Titan 의 몇 배인데, 카탈로그 규모에서 그것은 한 달에 1~2달러다.
선택 기준은 가격이 아니라 정확도다.

Cohere 가 대신 치르는 대가는 모든 점수가 더 높게 나온다는 것이고, 그래서 여기서
`CATALOG_MIN_SCORE` 는 0.25 이며 Titan 이었다면 0.15 였을 것이다. 자체 호스팅한 Qwen3은
한국어 질의도 정답과 잡음을 더 넓게 갈랐고 `0.5`를 쓴다. 레지스트리와 요청이 같은 언어를 쓰는
배포는 이 차이를 덜 본다.

## 인증과 접근 제어

| 변수 | 기본값 | Runtime | 설명 |
|---|---|---|---|
| `BETTER_AUTH_SECRET` | — | — | 세션 서명 시크릿 (`openssl rand -base64 32`). |
| `BETTER_AUTH_URL` | — | — | Better Auth 가 콜백을 만들 때 기준으로 삼는 base URL. |
| `OIDC_ISSUER` / `OIDC_CLIENT_ID` / `OIDC_CLIENT_SECRET` | — | — | 표준 OIDC 제공자. Keycloak, Entra ID, Okta, Authentik, `<issuer>/.well-known/openid-configuration` 을 내놓는 것이면 무엇이든. 셋이 모두 있을 때만 켜진다(Better Auth 의 `genericOAuth`, PKCE). 콜백은 `BETTER_AUTH_URL/api/auth/callback/oidc` 이고 제공자에 그 리디렉션 URI 를 등록한다. 배포당 하나: 기업에는 디렉터리가 하나이고, 두 번째 제공자는 사람이 누구인지에 대한 두 번째 정본이다. |
| `OIDC_DISPLAY_NAME` / `OIDC_SCOPES` | `SSO` / `openid email profile` | — | 로그인 버튼의 이름, 그리고 공백으로 구분한 scope. |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | — | — | Google 로그인. 둘 다 있을 때만 켜진다. 콜백은 `/api/auth/callback/google`. |
| `AUTH_PASSWORD` | `false` | — | `true` 면 이메일 + 비밀번호 로그인. **가입 폼은 없다**. 아무도 보증하지 않는 계정이므로 부트스트랩 관리자는 부팅 때 만들어지고, 그 밖의 비밀번호 계정은 관리자의 의도적인 행위다. 신원 제공자가 아직 닿지 않는 설치의 첫 관리자와, 제공자가 죽었을 때의 비상 접근을 위한 것이다. |
| `BOOTSTRAP_ADMIN_EMAIL` / `BOOTSTRAP_ADMIN_PASSWORD` | — | — | `AUTH_PASSWORD=true` 일 때 부팅 시 준비되는 계정 (`ensureBootstrapAdmin`). 같은 이메일의 사용자에게 비밀번호 credential 이 이미 있으면 변경하지 않는다. 사용자는 있지만 credential 이 없으면 기존 사용자 행을 유지하고 비밀번호 credential 을 추가한다. 기존 비밀번호는 환경변수 변경으로 갱신되지 않는다. 이메일은 `ADMIN_EMAILS` 에도 넣어야 admin 이 된다. `ALLOWED_EMAIL_DOMAINS` 는 이 주소에 적용되지 않는다. 제공자나 도메인 목록이 모두를 잠갔을 때의 비상 계정이므로. `AUTH_PASSWORD` 없이 설정하면 경고만 남기고 만들지 않는다. |
| `ALLOWED_EMAIL_DOMAINS` | 비어 있음 | **runtime** | 로그인이 허용되는 도메인의 쉼표 구분 목록. 세 제공자 모두에 적용된다(사용자 생성과 세션 생성의 훅). 비어 있으면 아무 도메인이나 허용한다. |
| `TRUSTED_PROXY_CIDRS` | 비어 있음 | — | 이 배포 앞에 있는 리버스 프록시들의 IP/CIDR 범위, 쉼표 구분 (예: Caddy 와 ingress controller 처럼 두 홉이 `X-Forwarded-For` 에 덧붙일 때). Better Auth 는 rate limiting 의 키로 삼는 클라이언트 IP 를 알아내기 위해 체인 오른쪽에서 이 홉들을 벗겨 낸다. 비어 있으면 값이 하나뿐인 헤더만 신뢰하므로, 프록시 두 개 뒤에서는 모든 요청이 하나의 공유 버킷에 떨어진다. |
| `ADMIN_EMAILS` | 비어 있음 | **runtime** | 쉼표 구분. 레지스트리·설정 변경 권한과 남이 소유한 프로젝트에 대한 쓰기 권한을 준다. 목록에 있는 멤버는 저장된 `admin` tier 로 승격되고 거기 고정된다. 목록에서 빼도 자동 강등은 없다. 비어 있으면 레지스트리·설정 변경에는 *제한 없음*, 프로젝트 오버라이드에는 *아무도 아님* 을 뜻한다. 두 질문이 서로 다른 술어로 답해지는 것은 의도적이다 ([SECURITY.md](SECURITY.md#인가-모델)). |

## LLM 채널

기본 텍스트 생성 채널은 OpenAI Chat Completions 프로토콜로 말한다. 모델 id 는 `provider/model` 이다.

| 변수 | 기본값 | Runtime | 설명 |
|---|---|---|---|
| `LLM_BASE_URL` | — (필수) | **runtime** | 기본 채널. OpenRouter 나 LiteLLM 같은 라우터. provider 채널이 가져가지 않는 한 모든 모델 id 가 여기로 간다. |
| `LLM_API_KEY` | — (필수) | **runtime** | 그 채널의 자격증명. |
| `LLM_PROVIDER_<NAME>_BASE_URL` | 미설정 | **runtime** | provider 별 채널을 등록한다. `<NAME>` 은 모델 id 의 provider 접두사를 대문자로 쓴 것이다. 레지스트리의 provider 는 `OPENAI`, `ANTHROPIC`, `GOOGLE`, `XAI`, `BEDROCK`, `OPENROUTER`, `SELFHOSTED` 다. env 파서는 `[A-Z0-9_]+` 형태의 이름을 받아 사용자 정의 provider 접두사의 모델도 해당 채널로 보낸다. `/settings` 오버라이드는 지원 provider 목록으로 제한된다. |
| `LLM_PROVIDER_<NAME>_API_KEY` | 미설정 | **runtime** | 그 채널의 자격증명. `_AUTH=sigv4` 가 아닌 한 필수다: 키가 없는 채널은 **조용히 건너뛰어지고**, 그 모델들은 기본 채널로 떨어진다. |
| `LLM_PROVIDER_<NAME>_AUTH` | `bearer` | **runtime** | `bearer` \| `sigv4`. `sigv4` 는 프로세스의 AWS 자격증명(역할, 또는 `AWS_ACCESS_KEY_ID`/`AWS_PROFILE`, SDK 의 표준 해석 순서)으로 매 요청에 서명하고 API 키를 **받지 않는다**. 문자 그대로의 `sigv4` 가 아닌 값은 전부 `bearer` 로 읽히므로, 오타가 서명도 키도 없는 채널을 만들어 낼 수는 없다. |
| `LLM_PROVIDER_<NAME>_KEEP_MODEL_PREFIX` | `false` | **runtime** | provider 채널은 맨 모델 이름(`provider/` 접두사를 벗긴 것)을 받는다. 그 채널 자체가 전체 id 를 기대하는 라우터일 때 이 값을 켜라. |

`/settings` 에서 기본 채널의 URL, 또는 provider 채널의 URL·인증 방식을 바꿀 때는 새 API key 를
같이 입력해야 한다. 마스킹된 key 는 같은 endpoint 와 인증 방식에서만 보존되며 새 주소로 이동하지
않는다. 기본 URL 과 key override 를 함께 비우면 두 값 모두 env 설정으로 돌아간다.

> base URL 에는 provider 가 서비스하는 API 버전 경로가 포함돼야 한다. 어댑터는 거기에
> `/chat/completions` 와 `/images/generations` 를 글자 그대로 덧붙인다. `https://api.x.ai/v1`
> 대신 `https://api.x.ai` 를 쓰면 그 provider 로 가는 **모든** 호출이 텍스트든 이미지든 404 가
> 되고, 증상은 `The requested resource was not found` 라고 적힌 도구 결과다. `pnpm
> check-models` 는 각 채널의 도달 가능성을 보고하며, 그것이 이 문제를 확인하는 가장 빠른
> 방법이다.

provider 채널이 하나라도 설정돼 있으면 `GET /api/models` 는 그 provider 들의 모델만
나열한다. 하나도 설정돼 있지 않으면 레지스트리에서 보이는(`hidden` 이 아닌) 모든 모델을
나열한다. 단 `selfhosted/` 모델은 예외다: 그 접두사는 기본 채널의 라우터가 서빙하지
않으므로, 전용 채널이 설정된 경우에만 나열된다 (`providerOffered`). 덕분에 selfhosted
모델이 채널 없는 배포의 피커에 보증된 404 로 나타나는 일이 없다.

`/settings` 에 저장된 `llmProviders` 오버라이드는 `LLM_PROVIDER_*` env 집합과 병합되는 것이
아니라 **그 집합 전체를 대체한다**. 부분 병합은 "이 provider 를 제거한다" 를 표현할 수 없는
편집으로 만들어 버린다.

**`selfhosted` 는 배포가 직접 운영하는 route 이고, 그 모델의 발행자는 배포 자신이다.**
LM Studio 든 vLLM 이든, 운영자가 띄운 OpenAI 호환 서버를
`LLM_PROVIDER_SELFHOSTED_BASE_URL` 이 가리킨다 (bearer 채널이라 키가 필수인데, LM Studio
처럼 키를 무시하는 서버에는 아무 placeholder 값이나 준다). agent-models 는 **전역적으로
참인** 사실만 담는다. 벤더의 가격은 어디서나 같다. 반면 어떤 모델이 selfhosted 채널에
서빙되는지는 그 배포의 하드웨어에 대한 사실이라, 이 모델들은 카탈로그가 아니라 **배포의
선언**(runtime settings 의 `selfHostedModels`, `/models` 콘솔의 Self-hosted 섹션)에서 온다.
선언은 카탈로그 엔트리와 같은 모양이고 같은 로더 검증을 지나 레지스트리 **오버레이**에
설치된다 (`loadSelfHostedModels`). 카탈로그 refresh 는 오버레이를 건드리지 않고, 매 틱마다
선언을 다시 읽어 재설치하므로 다른 인스턴스의 설정 변경도 한 틱 안에 도달한다.

`family` 는 서빙 스택이 쓰는 모델 이름 *그대로*이고 슬래시도 그 일부다. LM Studio 의
`qwen/qwen3.8-27b` 는 family 가 `qwen/qwen3.8-27b` 인 `selfhosted/qwen/qwen3.8-27b` 가 되고,
디스패치는 접두사 하나만 벗겨 정확히 그 이름을 보낸다. 이름이 정확해야 하는 이유: LM Studio
는 모르는 이름을 받으면 404 대신 **로드돼 있는 모델로 조용히 폴백**하므로, 근사한 이름은
다른 모델의 답을 성공처럼 돌려준다. 콘솔 섹션은 채널의 `/v1/models` 목록(LM Studio 네이티브
API 의 컨텍스트 길이·vlm 타입으로 보강, `GET /api/models/selfhosted`)에서 선언을 시작하게
해 주고, 목록에 있다고 실행이 보장되는 것도 아니다. RAM 이 모자라 로드가 안 되는 모델은
목록에 남는다. 최종 판정은 언제나 모델 카드의 Test 다.

### 모델 레지스트리: agent-models 의 카탈로그

Text, Image, Embedding, Rerank, Transcription 모델. 가격, 컨텍스트 윈도, 출력 상한, capability 플래그, 어떤 route 가 그것을
서빙하는지. 는 **이 저장소에 있지 않다.** [opspresso/agent-models](https://github.com/opspresso/agent-models)
가 관리한다: 모델마다 **family** 하나(표시 이름, 가격, 윈도, capability), 경로마다 **offering**
하나(provider, wire 이름, 그 경로가 바꾸는 것), 그리고 provider 들의 공개 카탈로그로부터 매일
갱신(가격·할인·한도, 신규 모델과 경로의 추가, 7일 연속 부재 뒤 은퇴). 그 결과가
`https://models.opspresso.com/models.json` 으로 발행되고, 이 앱은 그것을 **읽기만 한다**. 모델을
추가하거나 은퇴시키거나 요율을 고치는 일은 거기서 하며, 여기서는 절대 하지 않는다.
`tests/models.test.ts` 가 `src/domain/llm/models.ts` 에 숫자가 돌아오는 것을 막는다.
유일한 예외가 selfhosted 모델이다: 그 발행자는 배포 자신이고, 카탈로그가 아니라 배포의
선언이 레지스트리 오버레이로 들어온다 (위 *LLM 채널* 절).

카탈로그의 항목은 이 앱의 `ModelConfig` 그대로다. 타입은 별도 필드가 아니라 capability 에서
파생한다: `embedding: true` 는 Embedding, `rerank: true` 는 Rerank,
`transcription: true` 는 Transcription, `imageGeneration: true` 는 Image, 모두 없으면 Text 다.
네 플래그는 동시에 참일 수 없다. Embedding은 input token으로, Rerank는 input token 또는
`perSearch`로, Transcription은 input/output token 또는 `perAudioMinute`로 가격을 표현한다.
Embedding과 Rerank의 `outputPer1M`·`maxTokens`는 0이다. `/models` 카탈로그에는 다섯 타입을 모두 표시하지만 version picker와 `/api/models` 는 실행
가능한 Text·Image만 제공한다. id 는 `provider/family` 이고, 같은 모델의 세 경로는 같은
이름·윈도·타입을 가진다. `wireId` 는 경로가 모델 이름을 다르게 쓸 때만 둔다. 두 벌이 프로세스에
도달한다:

- **스냅샷** `src/domain/llm/catalog.json`. 커밋된 사본. 모듈 평가 시 로드되어 단위 테스트와
  `next build` 가 보는 것이고, 발행된 카탈로그를 못 가져온 부팅이 기대는 것이다.
  `pnpm sync-models` 가 갱신하고(`--check` 는 뒤처졌으면 1 로 종료), 릴리즈 전이나 테스트가 새
  모델을 봐야 할 때 돌린다. agent-models 가 바뀔 때마다는 아니다.
- **발행된 카탈로그**. `MODELS_CATALOG_URL` 을 설정하면 부팅 때 읽어(`src/instrumentation.ts`, 첫 요청
  전에 await, 소스 자체의 10초 데드라인), 이후 `MODELS_CATALOG_REFRESH_MS` 마다 다시 읽는다
  (`application/llm/modelCatalogRefresh.ts`). 실패는 로그를 남기고 레지스트리를 그대로 둔다.
  정적 사이트가 내려갔다고 부팅을 거부하는 것은 낡은 가격을 무서비스와 바꾸는 일이다.

- **admin 이 업로드한 문서**. 발행된 카탈로그에 닿지 못하는 배포의 길이다. `/models` 콘솔에서
  카탈로그 JSON 을 올리면 (`PUT /api/models/catalog/document`, 최대 4MB) refresh 가 검증하는
  방식 그대로 먼저 검증해 거절하거나, 올린 사람과 시각과 함께 `MODELCATALOG#doc` 행에 저장하고
  바로 레지스트리를 갱신한다. **업로드는 어느 배포에서든 네트워크보다 우선한다**. 문서가
  있는 동안 refresher 는 그것만 읽고(`modelCatalogStoredSource.ts`), 지우면(`DELETE`) 다음
  refresh 부터 발행 카탈로그를 다시 읽으며, 읽을 발행 카탈로그가 없으면 프로세스가 재시작해
  스냅샷으로 돌아갈 때까지 마지막 설치본을 유지한다. 레지스트리는 결코 비워지지 않는다.
  우선순위는 부팅 때 한 번이 아니라 **읽을 때마다** 결정되므로, 다른 인스턴스의 업로드도 한
  틱 안에 도달한다. 같은 프로세스의 boot 틱과 console refresh 는 하나의 coordinator 로
  직렬화되고, 진행 중인 읽기 사이에 업로드나 삭제가 오면 뒤따르는 읽기를 한 번 더 수행한다.
  로컬 스냅샷을 그 문서로 맞추려면 `pnpm sync-models --from <file>`.

`loadModelCatalog` (`src/domain/llm/models.ts`) 가 유일한 입구다: 버전을 확인하고, 항목마다 런이
읽는 필드(가격이 숫자인지, 윈도가 양의 정수인지, `provider` 가 이 앱이 가진 채널인지.
`SUPPORTED_PROVIDERS` 는 카탈로그가 아니라 코드다)를 검증해 맞지 않는 것은 이유와 함께 건너뛰고,
레지스트리를 **원자적으로** 바꾼다. Text 모델은 양쪽 모두 0보다 큰 가격을 요구하고, Image는
image output token 또는 장당 가격을 요구하며, Embedding은 input 가격과 0인 output 가격을
요구한다. Rerank는 input 가격 또는 `perSearch`, Transcription은 양쪽 token 가격 또는
`perAudioMinute`를 요구한다. self-hosted
provider(`SELF_HOSTED_PROVIDERS`, 역시 코드)는 예외다. 직접 서빙하는 모델은 0 이 참값이라서
명시적 0 은 통과하고, 가격 필드의 *부재*는 다른 provider 와 똑같이 거부된다. 진행 중인 런은 이미 해석한 config 를 그대로 쓴다. 쓸 수 있는
항목이 하나도 없는 카탈로그는 거부되고 이전 상태가 남는다. 빈 레지스트리는 낡은 것보다 나쁜 유일한
결과다.

| 변수 | 기본값 | Runtime | 설명 |
|---|---|---|---|
| `MODELS_CATALOG_URL` | — (원격 읽기 꺼짐) | boot | 발행된 카탈로그의 주소. 명시한 배포만 부팅과 간격마다 읽는다. 구성값이지 사용자가 친 주소가 아니라서 SSRF 가드를 지나지 않는다. 미설정 또는 **`none`**(대소문자 무관)이면 fetch 가 없고, 카탈로그는 스냅샷과 admin 의 업로드뿐이다. 간격 자체는 켜져 있다: 다른 인스턴스의 업로드와 self-hosted 선언이 이 프로세스에 닿는 길이므로, URL 없는 틱은 데이터베이스만 읽는다. |
| `MODELS_CATALOG_REFRESH_MS` | `3600000` (1시간) | boot | 다시 읽는 간격. `0` 이면 간격을 끄고 부팅 때만 읽는다. |

**Bedrock 의 모델 목록은 이 프로토콜이 도달할 수 있는 모델의 목록이 아니다.** OpenAI 호환
엔드포인트는 `bedrock-mantle`(`https://bedrock-mantle.<region>.api.aws/v1`, `_AUTH=sigv4`)
인데, 거기의 `GET /v1/models` 는 `POST /v1/chat/completions` 가 그다음 거부하는 모델들을
돌려준다: 모든 `anthropic.*` 모델(이들은 Anthropic Messages API 를 받는데 이 앱은 그 말을
하지 못한다), `xai.grok-4.3`, 그리고 `openai.gpt-5.4`\|`5.5`\|`5.6-*` 전부
(`isn't supported on this route`)이며, AWS 는 그것들에 대해 가격도 공개한다. 즉 목록에서
독점 모델을 보고 경로가 생겼다고 읽으면 안 된다. 목록에 오르는 것과 이 라우트로 호출되는
것은 별개다. 그래서 Bedrock offering 은 실제 호출이 답을 돌려준 뒤에만 추가한다.
레지스트리에 있는 것들은 open-weight 모델이고 하나하나 smoke test 를 거쳤다. 또한
`bedrock-mantle` 은 `ap-northeast-2` 에 존재하지 않으므로 그 base URL 은 배포의 나머지와
다른 리전을 지목한다. 서명자는 `AWS_REGION` 이 아니라 그 URL 에서 리전을 읽는다.

**자기 비용을 보고하는 채널은 믿는다. 텍스트 경로에서.** OpenRouter 는 모든 호출에
`usage.cost`(USD)를 돌려주고, usage 행에 기록되는 것은 레지스트리의 요율이 아니라 그 수치다.
레지스트리 가격은 런 전에 보여 주는 추정치이자, 토큰만 보고하는 모든 채널을 위한 폴백으로 남는다.

**이미지 경로는 그렇지 않다.** `ImageGenerationResult.usage` 는 토큰 셋만 나르고 보고된 금액을
담을 자리가 없어서, OpenRouter 이미지 모델도 레지스트리 요율로 값이 매겨진다. 실측 오차는
2% 안쪽이지만(추정 $0.0336 대 청구 $0.03418), **레지스트리 숫자가 곧 청구액이 되는 유일한
경로**라는 뜻이다. 그 숫자가 틀리면 그것을 바로잡을 것이 아무것도 없다.

**레지스트리에 없는 모델도 기본값에서는 그대로 실행되지만, 그 usage 는 $0 으로 값이 매겨진다**
그래서 그 공백은 자기가 망가뜨리는 비용 대시보드에서 보이지 않는다. 놓칠 때마다
`[cost] unknown model id` 를 한 번 로그하고 `agent_studio_unknown_model_calls_total` 을
증가시킨다. 비용을 알아차릴 때까지 기다리지 말고 0 이 아닌 비율에 알림을 걸어라.
`pnpm check-models` 는 레지스트리를 설정된 채널들이 실제로 제공하는 것과 비교한다.
[DEVELOPMENT.md](DEVELOPMENT.md#스크립트) 를 보라.

| 변수 | 기본값 | Runtime | 설명 |
|---|---|---|---|
| `UNKNOWN_MODEL_POLICY` | `allow` | **runtime** | `allow` \| `refuse`. 레지스트리가 값을 매길 수 없는 모델을 런이 실행해도 되는지. 그 밖의 값은 전부 `allow` 로 읽히므로, 잘못된 형식의 값이 배포가 멈추는 이유가 되는 일은 없다. |

`refuse` 는 **런 브래킷**에서 검사한다. 네 개의 admit 함수가 모두 지나가는 한 지점이며,
버전의 `model` 뿐 아니라 `fallbackModel` 까지 함께 다룬다. 폴백은 주 모델이 rate limit 에
걸릴 때마다 런 전체를 떠맡으므로, 값이 매겨지지 않은 폴백은 정확히 같은 만큼 새어 나가되
간헐적으로 그럴 뿐이다. dispatch 전에 throw 하므로, 호출자는 열렸다가 실패하는 스트림이 아니라
`400` 을 받는다.

**subagent transfer** 도 자식의 버전이 해석되는 자리에서 검사한다. 그것은 브래킷을 열지
않지만. top-level run 이 아니다. dispatch 하고 usage 를 기록하는 것은 똑같으며, 부모의
모델은 자식의 모델에 대해 아무것도 말해 주지 않는다. 거기서 거부는 런이 아니라 transfer 를
실패시킨다: 부모는 이유를 전달받고 그 자식 없이 답할 수 있다.

**버전 저장은 건드리지 않는다**: 레지스트리가 아직 따라잡지 못한 id 를 저장하는 것이야말로
새 모델을 도입하는 방식이고, 그 경로는 자기 경고를 유지한다. 이 설정이 한계를 두는 것은
무엇으로도 값을 매길 수 없는 id 아래에서 돈을 쓰는 일이다.

## 실행 제한

| 변수 | 기본값 | Runtime | 설명 |
|---|---|---|---|
| `MAX_RUN_DURATION_MS` | `600000` (10분) | — | 모든 진입점에 걸리는, 단일 런의 실제 경과 시간 상한. 멈춰 버린 provider 나 도구 호출이 무한정 돌거나 무한정 청구할 수 없다. 유효하지 않은 값은 경고와 함께 무시된다. Slack·Telegram·Teams 경로는 공용 메시징 파이프라인에서 추가로 고정된 3분 인터랙티브 데드라인(아래)을 적용하는데, 그것은 런을 짧게 만들 수만 있다. 런 슬롯 lease 는 이 값 + 60초, MCP OAuth 토큰 갱신 여유는 이 값 + 5분이다. 서명 URL 수명은 런 길이와 독립적으로 뷰 15분·지속되는 기록 7일이며 `src/shared/artifactUrlTtl.ts` 가 소유한다. |
| `MAX_CONCURRENT_RUNS_PER_ACTOR` | `10` | — | 한 호출자가 동시에 진행할 수 있는 런 수(최대 `1000`). `0` 은 제한을 끈다. 자기 `maxConcurrentRuns` 를 가진 멤버 tier(*코드에 고정된 제한* 참고)는 그 멤버 자신의 런에 대해 이 값을 덮어쓴다. 기본 `guest` tier 가 그런 값을 하나 들고 있다. `admin`/`member`, 프로젝트 토큰, 그리고 모든 기계 호출자는 이 값을 물려받는다. |
| `MAX_CONCURRENT_RUNS_A2A` | `50` | — | **공유** A2A 키로 이뤄진 호출을 위한 별도 상한(최대 `1000`). 그 actor id 는 상수라서, 하나의 정체성이 거기의 모든 기계 호출자를 대표한다. 그러지 않으면 호출자별 제한이 A2A 표면 전체에 상한을 씌우게 된다. 이름이 붙은 클라이언트 키는 호출자 하나이며 사람과 마찬가지로 `MAX_CONCURRENT_RUNS_PER_ACTOR` 아래에 놓인다. |
| `SCHEDULE_SCAN_TOKEN` | 미설정 | — | 모든 ticker 가 제시하는 단 하나의 자격증명(`X-Scan-Token`)이며, CronJob 이 POST 하는 세 엔드포인트가 공유한다: `/api/triggers/scan`(schedule), `/api/plugins/sync/scan`(plugins 저장소), `/api/catalog/reindex`(capability 카탈로그). 설정하지 않으면 이 배포에 ticker 가 없다는 뜻이다: 셋 다 503 으로 답하고 schedule 트리거는 결코 발화하지 않는다. 열리는 대신 꺼진다. |

유효하지 않은 값(정수가 아니거나 음수, 또는 위 동시성 상한 초과)은 `0` 이 아니라 경고와 함께 기본값으로 떨어진다.
`Number("abc") || 0` 은 "제한 꺼짐" 으로 읽히는데, 그것은 오타가 뜻해야 하는 바의 정반대다.

**이 문서의 거의 모든 숫자 설정이 그렇게 동작한다**: 이들은 `positiveIntEnv` 를 지나가며,
파싱과 경고까지 `src/lib/config.ts` 가 그것을 소유한다. 그 바깥에 있는 설정이 두 종류 있고
각각 자기 행에서 그렇게 말한다: `0`–`1` 값들(`TRACE_SAMPLE_RATE`, `CATALOG_MIN_SCORE`)은
폴백하는 대신 **clamp** 하고, `MAX_RUN_DURATION_MS` 는 `src/shared/runDeadline.ts` 에서 스스로
파싱한다. `application` 이 그 데드라인을 필요로 하는데 `lib` 를 import 할 수 없기 때문이다.
`AbortSignal.timeout` 의 정의역에 대해 값을 검증하고 같은 경고와 함께 기본값으로 떨어진다.

한 설정이 어떤 헬퍼를 부르는지는 그것이 어디에서 자기를 *선언하는지* 와 별개의 문제다:
대부분은 `config.ts` 에서, 보존 기간은 `src/infrastructure/db/ttl.ts` 에서,
`SETTINGS_CACHE_TTL_MS` 는 `src/lib/runtime-settings.ts` 에서 선언한다. 어댑터는 변수를 직접
읽지 않는다. `tests/architecture.test.ts` 는 `domain`, `shared`, `infrastructure`,
`application` 어디에서든 `process.env` 를 읽으면 실패하고, `runDeadline.ts` 가 **이름이 명시된**
유일한 예외라서 두 번째 예외가 조용히 들어올 수 없다. 경고는 설정마다 값마다 한 번씩만
나온다. 이 중 몇몇은 행을 쓸 때마다 읽히기 때문이다.

## MCP

| 변수 | 기본값 | Runtime | 설명 |
|---|---|---|---|
| `MCP_DISCOVERY_CACHE_TTL_MS` | `60000` | — | 바인딩된 서버의 도구 목록을 얼마나 오래 재사용하는지. 키는 `url + headers` 다. 캐시가 따뜻하면 세션이 지연 연결될 수도 있어서, 도구를 하나도 부르지 않는 턴은 MCP 요청을 아예 하지 않는다. `0` 은 캐싱을 통째로 끄며, 어떤 서버 힌트도 그것을 다시 켤 수 없다. 밀리초 정수. |
| `MCP_MAX_SERVER_TTL_MS` | `300000` (5분) | — | 서버가 `tools/list` 에서 요청할 수 있는 `ttlMs` 의 상한 (SEP-2549). `0` 은 서버 힌트를 완전히 무시하고 모든 항목을 로컬 TTL 로 되돌린다. 밀리초 정수. |
| `MCP_OAUTH_ALLOW_UNADVERTISED_PKCE` | `false` | — | `true` 면 `code_challenge_methods_supported` 를 광고하지 않는 OAuth authorization 서버를 받아들인다. 명세는 거부하라고 하지만(PKCE 다운그레이드 방어), 광고 없이 PKCE 를 지원하는 서버가 흔하다. 배포 단위의 결정이라 env 다. [SECURITY.md](SECURITY.md#mcp-oauth). |
| `MCP_INTERNAL_HOST_SUFFIXES` | 비어 있음 | — | 사설 주소로 resolve 되더라도 MCP 항목이 쓸 수 있는 호스트의 DNS suffix 목록, 쉼표 구분. `<namespace>.svc.cluster.local` 이나 사내 존. 명시한 `localhost`는 그 호스트만 허용하며 하위 도메인·IP 주소는 포함하지 않는다. 비어 있으면 SSRF 가드는 원래 그대로다. [SECURITY.md](SECURITY.md#선언된-내부-호스트) 를 보라. |
| `URL_FETCH_INTERNAL_HOST_SUFFIXES` | 비어 있음 | — | `FetchUrl` 빌트인이 사설 주소로 resolve 되는데도 읽어도 되는 호스트의 DNS suffix 목록. 사내 위키, 내부 API. **위와 의도적으로 별개의 목록이다**: 이 앱이 부르는 서비스라고 해서 모델이 설득당해 읽어도 되는 페이지인 것은 아니다. 같은 매칭 규칙(`isDeclaredInternalHost`, 레이블 경계, 명시한 `localhost`만 정확히 허용, 다른 단일 레이블·IP 리터럴 거부), 같은 이유로 env 전용. [SECURITY.md](SECURITY.md#모델이-고른-url). |
| `MANAGED_MCP_RUNTIME` | 미설정 | — | managed MCP 컨테이너를 어떻게 띄우는가. 유일한 값은 `docker`. 앱이 자기 호스트의 Docker CLI 를 직접 구동해 `127.0.0.1:<port>` 로 포트를 게시하고 그 주소를 등록한다. 다른 값은 경고와 함께 무시되어 기능이 꺼진다. 앱 프로세스가 `docker` 바이너리와 호스트 loopback 에 닿아야 한다. 기본 앱 이미지에는 Docker CLI가 없으므로 배포 저장소가 이미지와 네트워크를 명시적으로 구성해야 한다. |
| `MANAGED_MCP_REGISTRY` | 미설정 | — | 관리형 MCP 기능을 켜기 위해 필요한 레지스트리 설정이다. 앱이 `docker login` 을 수행하지 않으므로 호스트의 Docker credential 을 미리 준비해야 한다. 이미지 pull 은 호스트가 접근할 수 있는 레지스트리를 사용한다. |

`MANAGED_MCP_RUNTIME` 과 `MANAGED_MCP_REGISTRY` 중 하나라도 설정되지 않으면 managed-MCP 라우트는
기능을 절반만 켜는 대신 `503` 으로 답한다. 컨테이너의 `environment` 값은 저장 시 암호화되고,
Docker 를 호출하기 직전에만 0600 임시 env file 로 복호화된다. 호스트 파일 경로는 입력으로 받지
않는다. `PORT` 는 런타임이 써 넣으므로 거부된다.

**discovery TTL 에 손잡이가 둘인 이유.** 항목의 수명은 숫자 하나로 두 질문에 답한다. 서버의
힌트는 첫 번째에 답한다. 자기 카탈로그가 얼마나 신선한가. 그리고 그건 이 앱보다 서버가 더
잘 안다. 그런데 같은 숫자가 두 번째에도 한계를 둔다: 레지스트리 편집 시의 무효화는 프로세스
로컬이라, 그 숫자는 *다른* 인스턴스들에서 그 편집이 보이지 않는 시간이기도 하다. 두 번째
답은 서버가 아니라 배포에 속하고, 상한이 없으면 한 시간을 요청하는 서버 하나가 그것을 함대
전체에 대해 결정해 버린다. 대신 `MCP_DISCOVERY_CACHE_TTL_MS` 를 올리면 힌트가 없는 서버들도
다시 읽히지 않게 되는데, 그건 반대 방향의 거래다. 그래서 손잡이가 따로 있다. 단일 인스턴스
배포는 `MCP_MAX_SERVER_TTL_MS` 를 마음껏 올려도 되고, 다중 인스턴스 배포는 감수할 수 있는
낡음 정도에 가깝게 유지해야 한다.

실패한 discovery 도 캐시되며, 기간은 `MCP_DISCOVERY_CACHE_TTL_MS` 와 30초 중 작은 쪽이다.
그것이 없으면 죽어 있는 서버는. 또는 토큰이 폐기된 연결은. 모든 메시지의 첫 토큰 전에
실패하는 연결 비용을 다시 치른다. 창이 짧은 이유는, 낡은 실패는 복구를 가리는 반면 낡은
성공은 조금 오래된 도구 목록을 내놓을 뿐이기 때문이다.

## 소스 저장소

| 변수 | 기본값 | Runtime | 설명 |
|---|---|---|---|
| `PLUGINS_REPO` | 미설정 | **runtime** | [Agent Plugins 1.0.0](https://agent-plugins.org/) 저장소의 `owner/repo`. `plugin.json` 을 가진 모든 디렉터리가. 저장소 루트를 포함해. 하나의 plugin 이다. 다른 루트 안에 중첩된 루트는 거부된다. plugin 당: `skills/<name>/SKILL.md` (Agent Skills 스펙, frontmatter 의 `name` 이 디렉터리와 일치해야 하고 `description` 은 필수), `mcp.json` (`type: "streamable-http"` 서버만 바인딩된다. `stdio` 와 `sse` 항목은 보고되고 건너뛰며 결코 실행되지 않는다), 그리고 닫힌 mcp.json 스키마에는 자리가 없는 각 서버의 설명(frontmatter)과 운영 노트(본문)를 담는 `org.opspresso.agent-studio/mcp/<server>.md` 확장 문서. |
| `PLUGINS_REPO_BRANCH` | `main` | **runtime** | |
| `GITHUB_TOKEN` | 미설정 | **runtime** | plugins 저장소에 대한 contents 읽기 권한이 필요하다. |
| `GITHUB_API_URL` | `https://api.github.com` | — | GitHub REST API 가 답하는 곳. GitHub Enterprise Server 나 미러라면 `https://<host>/api/v3`. 끝의 슬래시는 떼어 낸다. |
| `GITHUB_WEB_URL` | public GitHub 또는 표준 GHES API 주소에서 도출 | — | plugin 상세의 repository·commit 링크가 향하는 web base. API mirror나 비표준 경로처럼 도출할 수 없으면 명시하라. 없고 도출할 수도 없으면 잘못된 링크를 만드는 대신 텍스트만 표시한다. |

**GitHub 에 닿지 않는 배포는 저장소를 아카이브로 올린다.** `/plugins` 의 업로드
(`POST /api/plugins/sync/upload`, 체크아웃의 `.tar.gz`/`.tgz`/`.tar`, `git archive` 든
`tar czf` 든)는 *같은 sync* 에 입력만 다르게 넣는 것이다: 트리를 스냅샷으로 만드는 워커
(`src/infrastructure/plugin/snapshot.ts`)를 GitHub 클라이언트와 공유하므로 어느 디렉터리가
무엇인지는 한 번만 정해진다. 행의 provenance 는 설정된 `PLUGINS_REPO`, 없으면 고정 이름
`archive` 이고(`archiveSyncRepo`). 그래서 GitHub 가 닿던 시절 sync 된 행은 같은 저장소가
손으로 도착해도 주인을 유지한다. `branch` 는 `archive`, `commitSha` 는 아카이브의 sha256
이라 같은 파일을 다시 올리면 unchanged 로 보고된다. `PLUGINS_REPO` 없이도 동작하고,
`GITHUB_TOKEN` 은 필요 없다. 상한은 [코드에 고정된 제한](#코드에-고정된-제한).

**저장소는 자기가 선언한 것을. 이름으로. 소유하고, 삭제는 사람이 소유한다.** sync 가 만든
항목, 다른 출처에서 입양한 항목(provenance 는 plugin 단위로 `github:<repo>#<plugin>`), 그리고
sync 가 존재하기 전에 손으로 등록된 항목은 전부 매 sync 마다 provenance 를 포함해 저장소의
버전으로 자동으로 맞춰진다. 저장소가 선언한 이름에 가한 콘솔 편집은 대체된다. 어떤 plugin 도
선언하지 않은 이름을 가진, 손으로 등록된 항목은 손대지 않는다. 이전 sync 가 만들었지만
저장소가 더 이상 들고 있지 않은 이름은 plugin 단위로 고아로 보고될 뿐이고, 사람이 콘솔에서
그것을 골랐을 때 삭제된다. MCP 항목은 자격증명을 담고 있을 수 있다.

`mcp.json` 에 선언된 헤더는 **가져오지 않으며**. 시크릿은 git 에 있을 것이 아니다. 버려진
헤더 이름들은 보고된다. 자격증명은 sync 이후 콘솔에서 설정하고, 그것들은 결코 주소를 따라가지
않는다: 저장소가 서버의 URL 을 옮기면 저장된 헤더와 OAuth 블록은 새 호스트로 보내지는 대신
버려지고 보고된다(`credentials-reset`). 클러스터 내부 URL 은 그 호스트가
`MCP_INTERNAL_HOST_SUFFIXES` 에 덮여 있을 때만 이 방식으로 등록 가능하다. sync 는 타이핑된
URL 과 똑같은 outbound 가드를 마주하며, 거부는 전체 실행을 실패시키는 대신 skip 으로 보고된다.

sync 는 저장소당 한 번에 하나씩만 돈다(두 번째 요청은 409 로 답한다). 자기 리포트를 영속화하며
(`/plugins` 에서 새로고침을 넘어 보인다), schedule CronJob 이
`POST /api/plugins/sync/scan` (`X-Scan-Token`: `SCHEDULE_SCAN_TOKEN`)으로 tick 을 걸 수 있다.
이 경로는 브랜치 head 가 마지막 클린 리포트와 일치하는 동안에는 스냅샷을 통째로 건너뛴다.

## Slack

| 변수 | 기본값 | Runtime | 설명 |
|---|---|---|---|
| `SLACK_LOADING_INDICATOR` | `:hourglass_flowing_sand:` | — | Slack 답변이 아직 쓰이고 있는 동안 뒤에 붙였다가 마지막 편집에서 떼어 내는 표시. **edit-in-place 폴백에서만 그렇다**. 스트리밍되는 답변은 Slack 자신이 아직 도착 중이라고 표시해 준다. 자기 spinner 이모지를 가진 워크스페이스는 여기에 그 이름을 적는다. 기본값이 내장돼 있는 이유는, 워크스페이스가 정의하지 않은 커스텀 이름은 글자 그대로 렌더링되기 때문이다. |

프로젝트별 Slack 설정. 봇 토큰, signing secret, 추천 프롬프트, 그리고 멘션 없이 봇을 깨우는
**채널 키워드**. 는 환경이 아니라 프로젝트에 산다 (`/projects/{name}/settings`). 어떤 버전의
런이 워크스페이스를 *읽어도* 되는지는 버전 파라미터(`slackWorkspace`)이고 기본은 꺼짐이다.

**생성되는 매니페스트는 릴리즈와 함께 바뀐다.** 이제 `message.channels` 와
`message.groups` 를 구독하고 `channels:read` 를 요청한다. 그 이전에 설치된 앱은 설치 당시의 scope 와 이벤트를
유지하므로, 매니페스트를 다시 적용하고 앱을 재설치하기 전까지 채널 후속 응답과 `SlackChannels`
도구는 작동하지 않는 채로 남는다.

## Telegram

환경에는 아무것도 없다. 프로젝트별 설정. 봇 토큰과 봇이 켜져 있는지 여부. 는 프로젝트에
산다 (`/projects/{name}/integrations`). webhook 시크릿은 거기서 발급되고, 봇을 켜면
`PUBLIC_BASE_URL/api/telegram/webhook/{project}` 에 webhook 이 등록되며 끄면 삭제된다 (*Register
webhook* 은 주소가 바뀐 뒤 다시 가리키는 용도다). 그래서 `PUBLIC_BASE_URL` 은 Telegram 이
도달할 수 있는 주소여야 한다. BotFather 의 *privacy mode* 는 켜 둔 채로 둬도 된다: 어차피 봇은
그룹에서 자기를 지목한 것에만 답한다 ([design/telegram.md](design/telegram.md)).

## Microsoft Teams

환경에는 아무것도 없다. 프로젝트별 설정. Azure Bot 의 Microsoft App ID, 클라이언트 시크릿,
(단일 테넌트 앱이면) 테넌트 id, 켜져 있는지 여부. 는 프로젝트에 산다
(`/projects/{name}/integrations`). Azure 에는 endpoint 를 가리키는 호출이 없으므로 콘솔은
`PUBLIC_BASE_URL/api/teams/messages/{project}` 를 보여 주고 운영자가 Azure Bot 의 messaging
endpoint 에 붙여 넣는다 ([design/teams.md](design/teams.md)).

## A2A

| 변수 | 기본값 | Runtime | 설명 |
|---|---|---|---|
| `A2A_API_KEY` | 미설정 | **runtime** | 인바운드 A2A JSON-RPC 를 위한 공유 키 (`X-A2A-Key`). 이 표면은 이 값이 설정되지 않고 **그리고** 이름이 붙은 클라이언트 키도 하나도 없을 때만 꺼진다 (`/settings` → Client keys). 값을 지어내지 말고 `/settings` 에서 발급하라. |

Agent Card URL 은 `PUBLIC_BASE_URL` 로부터 만들어진다.

## 관측성과 보존 기간

| 변수 | 기본값 | Runtime | 설명 |
|---|---|---|---|
| `TRACE_SAMPLE_RATE` | `0.1` | — | `0`–`1`, top-level predict 런과 이미지 런에 적용된다. agent 런은 항상 trace 된다. 위의 제한들과 달리, 범위를 벗어난 값은 폴백하는 대신 범위 안으로 **clamp** 된다. `2` 라는 비율은 "가능한 한 많이" 를 뜻한다. 반면 숫자가 아닌 값은 기본값을 쓴다. 둘 다 로그에 그렇게 남긴다: 조용히 다른 값이 돼 버린 샘플링 비율은 배포가 기록한 적도 없는 trace 로부터 추론하게 만드는 방식이다. |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | 미설정 | — | OTLP HTTP base 엔드포인트 (없으면 `/v1/traces` 를 덧붙인다). 설정되면 플랫폼이 영속화하는 모든 trace 가 데이터베이스 쓰기 이후에 OTEL span 으로도 내보내진다. export 실패는 `[otel]` 로그 라인으로 드러날 뿐, 결코 런으로 드러나지 않는다. 설정하지 않으면 export 자체가 없고 OTEL SDK 는 로드되지도 않는다. |
| `OTEL_EXPORTER_OTLP_HEADERS` | 미설정 | — | 표준 `key=value,key2=value2` 형식이며 모든 OTLP 요청에 실려 간다. 대소문자를 보존한다: 값들이 collector 자격증명이고, 정규화된 bearer 토큰은 다른 토큰, 즉 틀린 토큰이 되기 때문이다. |
| `SETTINGS_CACHE_TTL_MS` | `5000` | — | settings 행의 인메모리 TTL. 모든 runtime 오버라이드의 인스턴스 간 낡음에 한계를 둔다. [해석 순서](#해석-순서) 를 보라. 하한이 `1` 이라 `0` 은 캐시를 끄는 대신 기본값으로 떨어진다. |
| `TRACE_RETENTION_DAYS` | `30` | — | 행의 `expiresAt` 까지의 일수. 지난 행은 schedule-scan 틱이 쓸어낸다. |
| `USAGE_RETENTION_DAYS` | `400` | — | 대시보드의 184일 질의 창보다 한참 길게 유지한다. 하한은 `31`. 한 달 전체. 인데, 월간 비용 가드가 그 달의 일별 행들을 합산하기 때문이다. 더 짧은 창은 월말로 갈수록 지출을 조용히 적게 세게 된다. |
| `CHAT_RETENTION_DAYS` | `180` | — | chat 의 마지막 활동 시점부터 잰다. |
| `TRIGGER_RUN_RETENTION_DAYS` | `30` | — | 전달 이력은 운영 로그이지 보관할 기록이 아니다. |
| `A2A_TASK_RETENTION_DAYS` | `1` | — | 일시적인 작업 상태로, `SendMessage` 이후 `GetTask`/`CancelTask` 가 가능할 만큼만 유지한다. |
| `ARTIFACT_RETENTION_DAYS` | `180` | — | 런이 만들어 낸 것의 이름을 담는 행. 기본값은 `CHAT_RETENTION_DAYS` 에 맞췄다. 그것이 이미 생성된 이미지의 실효 수명이기 때문이다. **`CHAT_RETENTION_DAYS` 이상으로 유지하라**: 더 짧으면 대화에서 아직 보이는 그림이 자기 갤러리에서 먼저 사라진다. 이 창과 버킷의 lifecycle 규칙은 서로 독립된 두 설정이다. [OPERATIONS.md](OPERATIONS.md#행-보존) 를 보라. |
| `AUDIT_RETENTION_DAYS` | `400` | — | 감사 기록. usage 와 함께 여기서 가장 긴 창이다: 감사 행이 답하는 질문은 그 행위로부터 한참 뒤에 던져지고, 그 행은 런당 하나가 아니라 민감한 행위당 하나다. |

보존 값은 일 단위 정수이고 최소 `1` 이다. 그 밖의 값은 여기 다른 모든 숫자 설정과 마찬가지로
**경고와 함께** 기본값으로 떨어진다. 운영자가 잘못 넣은 그 값이 바로 행이 얼마나 오래
살아남을지를 정하는 값이라, 조용한 폴백은 최악의 종류다. 만료된 행을 실제로 지우는 것은
**schedule-scan 틱**(`POST /api/triggers/scan`)에 얹힌 sweep 이다. 그래서
`SCHEDULE_SCAN_TOKEN` 이 없는 배포는 이 창들을 설정해 두고도 아무것도 지우지 않는다.
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
| agent 런당 턴 수 (버전 `maxTurn` 기본값) | `50` | `src/application/runtime/execute.ts` |
| 멤버 tier 제한. 멤버당 동시 런 수 / 월 USD 상한 (`admin` —/—, `member` —/`20`, `guest` `1`/`2`. "—" 는 env 제한을 물려받거나 상한이 없다는 뜻). `guest` 는 추가로 프로젝트를 만들 수 없고 프로젝트 API 토큰도 쓸 수 없다 | `TIER_LIMITS` | `src/domain/member/tiers.ts` |
| SDK function tool 동시 실행 수 | `5` | `src/application/runtime/runner.ts` |
| 턴당 도구 결과 텍스트 | `200,000` 자 | `src/application/llm/toolResultBudget.ts` |
| subagent 로 넘기는 transfer transcript | `8,000` 자 | `src/application/runtime/transcript.ts` |
| subagent 중첩 깊이 | `5` | `src/application/execution/agentBindings.ts` |
| 한 런이 읽을 수 있는 주소 수 (`FetchUrl`) | `20` | `src/application/runtime/tools.ts` |
| `FetchUrl` 하나가 끌어올 수 있는 바이트 | `5 MB` | `src/application/llm/urlContent.ts` |
| `FetchUrl` 요청 하나, 모델에 도구 에러가 건네지기 전까지 | `15s` | `src/infrastructure/net/httpResource.ts` |
| 가져온 주소 하나에서 유지하는 텍스트 | `90,000` 자 | `src/application/llm/urlContent.ts` |
| 추출 전에 훑어 읽는 HTML 원문 | `500,000` 자 | `src/infrastructure/llm/htmlText.ts` |
| MCP 도구 결과 하나가 나를 수 있는 파일 | `10.5 MB` × 4 | `src/infrastructure/mcp/toolManager.ts` |
| artifact 행에 남기는 프롬프트 발췌 | `500` 자 | `src/application/artifact/storeArtifact.ts` |
| `/view` 가 메모리로 읽어 들이는 artifact | `2 MB` | `src/domain/artifact/types.ts` |
| `/view` 가 CSV 에서 그리는 행 수 | `2,000` | `src/app/api/artifacts/[artifactId]/view/_lib/viewPage.tsx` |
| `SaveFile` 생성 및 `File` 평문 편집의 바이트(중간 결과 포함) | `1 MB` | `src/domain/artifact/types.ts` |
| `/api/objects` 가 proxied 주소 하나에 대해 메모리로 읽어 들이는 오브젝트. 고른 숫자가 아니라 저장될 수 있는 것의 최대(첨부 · 문서 · 저장 파일 상한 중 큰 쪽) | `10 MB` | `src/infrastructure/storage/artifactAccess.ts` 의 `MAX_PROXIED_OBJECT_BYTES` |
| admin 이 올리는 모델 카탈로그 문서 | `4 MB` | `src/app/api/_lib/body.ts` |
| 올리는 plugins 아카이브. 전송 크기 / 풀었을 때 / 엔트리 수 (헤더 기준, 파일·디렉터리·확장 레코드 모두) | `32 MB` / `64 MB` / `20,000` | `src/app/api/plugins/sync/upload/route.ts`, `src/infrastructure/archive/tar.ts` |
| 한 틱의 retention sweep 이 지우는 행 수 (나머지는 다음 틱) | `items` 최대 `5,000` + Better Auth session 최대 `5,000` | `src/infrastructure/db/store.ts` 의 `deleteExpired`, `src/infrastructure/db/repositories/memberRepository.ts` 의 `deleteExpiredSessions` |
| 한 런의 파일 쓰기 시도 수 (`SaveFile`과 `File` 생성·편집 공유) | `10` | `src/application/runtime/tools.ts` |
| 카탈로그 검색 하나가 런에 더할 수 있는 capability 수 (skill / 외부 agent / MCP 서버) | `5` / `3` / `3` | `src/application/execution/bindings.ts` |
| 각 MCP 인덱스에 요청하는 카탈로그 매치 수. 그 상한을 넘겨 oversampling 한다. 여러 도구 행이 한 서버로 합쳐지고, 런이 바인딩할 수 없는 후보가 슬롯을 잡아먹어서는 안 되기 때문이다 | MCP 서버 상한의 `4×`(tool 인덱스) / `3×`(server 인덱스) | `src/application/execution/bindings.ts` |
| 런이 카탈로그를 검색할 때 쓰는 것 (시스템 프롬프트 / 가장 최근 사용자 턴 / 최신 요청 + 관련 기억을 합친 검색어) | `2,000` 자 / `3` 턴 / `2,000` 자(각 절반 최대 `1,000` 자) | `src/application/execution/bindings.ts` |
| 메모리 recall (`memoryRecall`): 보내는 질의 / 프롬프트에 유지하는 텍스트 / 첫 토큰이 그것을 기다리는 시간 | `2,000` 자 / `4,000` 자 / `10s` | `src/application/execution/memoryRecall.ts` |
| 인코딩된 대화 id (그것을 넘으면 대화가 없고, API 헤더는 400 으로 답한다) | `512` 자 | `src/domain/execution/actor.ts` 의 `MAX_CONVERSATION_ID_LENGTH` |
| 원격 agent 의 `contextId` 를 우리 쪽 대화 하나에 대해 유지하는 기간 | `7` 일, 사용 시 갱신 | `src/infrastructure/db/ttl.ts` |
| 런당 선언되는 MCP 도구 수 (= 128 − builtin 수) | `114` | `src/domain/llm/toolLimits.ts` |
| MCP 도구 결과 하나 | `100,000` 자 | `src/infrastructure/mcp/toolManager.ts` |
| MCP 서버의 HTTP 응답 | `14.5MB` | `src/infrastructure/mcp/session.ts` |
| MCP 서버 하나에서 읽는 `tools/list` 페이지 수 (상한에 닿으면 그 discovery 는 실패한다, SDK 는 부분 카탈로그를 남기지 않는다) | `64` | `src/infrastructure/mcp/session.ts` |
| MCP OAuth 메타데이터 / 토큰 응답 | 각 `256KB` | `src/infrastructure/mcp/oauthMetadata.ts`, `oauthClient.ts` |
| MCP discovery 캐시 항목 수 | `200` | `src/infrastructure/mcp/discoveryCache.ts` |
| 호스트당 managed MCP 서버 수 / 컨테이너당 메모리·swap·CPU·PID·writable tmpfs | `8` / `512MiB`·`512MiB`·`1`·`256`·`64MiB` | `src/application/mcp/managedMcpUseCases.ts`, `src/infrastructure/mcp/dockerProvisioner.ts` |
| 원격 agent(A2A / 외부)의 응답 | `2MB` | `src/infrastructure/agent/dispatcher.ts`, `agentClient.ts` |
| MCP 도구 호출 하나, 모델에 타임아웃 에러가 건네지기 전까지 (도구가 정당하게 몇 분씩 걸릴 수도 있다) | `120s` | `src/infrastructure/mcp/session.ts` |
| MCP discovery. 모든 런의 첫 토큰이 지나는 크리티컬 패스 위에 있어서, 빠르게 실패하고 그 서버의 도구만 잃는다. **요청당**: 연결과 `tools/list` 가 각각 이 값을 받는다 (그래서 느린 서버 하나에 최대 ~20초). 캐시로 제공된 세션의 첫 도구 호출에서 일어나는 지연 연결도 이 값을 받는다 | `10s` | `src/infrastructure/mcp/session.ts` |
| 런이 끝날 때 MCP 세션을 해제하기. 단계별로: 레거시 세션이 보내는 `DELETE`, 그다음 close | 각 `5s` | `src/infrastructure/mcp/session.ts` |
| MCP OAuth well-known 문서 / 토큰 엔드포인트와 RFC 7591 등록 (상수 하나) | `10s` / `15s` | `src/infrastructure/mcp/oauthMetadata.ts`, `oauthClient.ts` |
| OpenAI 형태의 원격 agent 로 가는 transfer | `120s` | `src/infrastructure/agent/dispatcher.ts` |
| A2A 원격 agent 로 가는 transfer. `capabilities.streaming` 을 광고하는 카드에서 이 값은 교환 전체가 아니라 **침묵**에 한계를 둔다. 타이머는 스트리밍되는 이벤트마다 리셋되고 총량은 런 데드라인이 제한한다. 광고하지 않는 카드에서는 블로킹 `SendMessage` 에 타이머를 리셋할 이벤트가 없으므로 같은 숫자가 요청 전체의 상한이 된다 | `120s` | `src/infrastructure/a2a/client.ts` |
| 레지스트리가 외부 agent 에 보내는 "test message". OpenAI 형태다. `a2a` 항목의 테스트는 위의 A2A 클라이언트를 지나 그 `120s` idle 상한 아래 놓이고 뒤에 런 데드라인도 없으므로, 스트리밍 카드는 침묵으로만 제한된다 | `60s` | `src/infrastructure/agent/agentClient.ts` |
| Slack Web API 호출 하나 / Slack 파일 전송 하나 | `30s` / `120s` | `src/infrastructure/slack/client.ts` |
| Telegram Bot API 호출 하나 / Telegram 파일 전송 하나 | `30s` / `120s` | `src/infrastructure/telegram/client.ts` |
| Bot Framework(Teams) 호출 하나 / 첨부 전송 하나 | `30s` / `120s` | `src/infrastructure/teams/client.ts` |
| Bot Framework 서명 키 캐시 / 모르는 `kid` 에 대한 재조회 최소 간격 / 토큰 시각 skew / 앱 토큰 만료 여유 | `24h` / `60s` / `5m` / `60s` | `src/infrastructure/teams/client.ts` |
| OpenAI-compatible SDK client cache (text / image / embedding, adapter별) / Teams 앱 token cache | 각 `16` / `32` | `src/infrastructure/llm/clientCache.ts`, `src/infrastructure/teams/client.ts` |
| 프로젝트 설정에 표시하는 최근 Telegram destination | `100` | `src/application/telegram/projectTelegram.ts` |
| GitHub API 요청 하나 (plugins sync) | `15s` | `src/infrastructure/github/client.ts` |
| 모델 응답당 동시 SDK function tool 수(공유 풀) | `5` | `src/application/runtime/runner.ts` |
| 인터랙티브(Slack, Telegram, Teams) 런 데드라인 | `3` 분 | `src/shared/runDeadline.ts` |
| 턴당 입력 이미지 수 / 이미지당 바이트(입력·생성·MCP·원격 A2A) | `4` / `5MB` | `src/domain/llm/imageLimits.ts` |
| PDF에 삽입하는 PNG의 총 디코딩 픽셀 | `16,777,216` | `src/domain/llm/imageLimits.ts`의 `MAX_PDF_IMAGE_PIXELS` |
| 앱 프로세스당 문서 워커 동시 실행 / 대기 작업 | `2` / `8` | `src/infrastructure/documents/workerPool.ts` |
| 문서 작업 기한 (대기 포함) / 자식 V8 old-space | `30s` / `256MiB` | `src/infrastructure/documents/workerPool.ts` |
| 문서 생성 Markdown / 편집 요청 JSON 문자 예산 | `500,000` 자 | `src/infrastructure/documents/engine/limits.ts`, `workerPool.ts` |
| 생성·편집 문서 출력 | `10,000,000` bytes | `src/infrastructure/documents/engine/limits.ts` |
| 문서 생성 이미지 asset 수 / 총 바이트 | `12` / `6 MiB` | `src/domain/document/processor.ts` |
| File 읽기·검사 텍스트 / 한 번의 편집 수 | `90,000` 자 / `100` | `src/domain/document/processor.ts` |
| XLSX 생성 시트 JSON 입력(UTF-8) | `10 MiB` | `src/infrastructure/documents/workerPool.ts` |
| 턴당 문서 수 / 각 바이트 | `4` / `10MB` | `src/domain/llm/documentLimits.ts` |
| 유지하는 추출 텍스트, 문서당 / 턴당 | `20,000` / `40,000` 자 | `src/domain/llm/documentLimits.ts` |
| 턴을 나르는 요청 본문 (첨부 상한에서 파생) | ~`80MB` | `src/app/api/_lib/body.ts` |
| 프로세스가 동시에 보유하는 attachment-scale turn 본문 바이트 (`256KiB` 초과분만 과금, 상한은 최대 turn 본문의 2배) | ~`168MB` | `src/app/api/_lib/body.ts` |
| Skill 첨부. 파일당 바이트 / skill 당 파일 수 / skill 당 바이트 (어느 하나라도 넘는 파일은 sync 에서 건너뛰고 이유를 보고한다) | `64KB` / `20` / `200KB` | `src/domain/skill/files.ts` |
| 레지스트리 또는 버전 편집의 요청 본문 (skill 파일 상한에서 파생) | `456KB` | `src/app/api/_lib/body.ts` |
| 턴이 넘칠 때 유지하는 transfer transcript 한 줄 | 최소 `500` 자 | `src/application/runtime/transcript.ts` |
| 컨텍스트 예산 추정 (ASCII / 그 외 / 이미지 part / 여유분) | 토큰당 `3` 자 / 자당 `1.5` 토큰 / `2,500` 토큰 / `2,000` 토큰 | `src/application/llm/contextBudget.ts` |
| 런의 컨텍스트 예산이 잘라 낼 때 유지하는 도구 결과 | 최소 `500` 자 | `src/application/llm/toolResultBudget.ts` |
| chat 메시지 하나가 보관하는 텍스트 (답변 · 도구 결과) | `350,000` 바이트 | `src/application/chat/run.ts` |
| chat 메시지 하나가 보관하는 추론. 답변 **뒤에**, 같은 아이템 예산에서 | `40,000` 바이트 | `src/application/chat/run.ts` |
| SDK Session 이력 | `256` items / `150,000` 자; 최신 완전한 턴은 보존 | `src/application/runtime/session.ts` |
| SDK Session/checkpoint 저장 원문 | `64MiB`; 압축 후 인증 암호화 | `src/application/runtime/session.ts` |
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
| Telegram 메시지 하나 (Telegram 자신의 상한이다. 더 긴 답변은 다음 메시지로 이어지며, 마지막 `800` 자 안에 줄바꿈이 있으면 거기서 자른다) | `4,096` 자 | `src/application/telegram/replyChannel.ts` |
| Telegram 답변 편집 주기 / typing 갱신 (Telegram 은 typing 을 `5s` 에 만료시킨다) | `2s` / `4s` | `src/application/telegram/replyChannel.ts` |
| Teams 메시지 하나 (더 긴 답변은 다음 메시지로 이어진다) / inline 그림 (Teams 가 문서화한 상한) | `20,000` 자 / `1MB` | `src/application/teams/replyChannel.ts` |
| Teams 답변 편집 주기 / typing 갱신 | `2s` / `3s` | `src/application/teams/replyChannel.ts` |
| Telegram·Teams 대화의 턴을 유지하는 기간 | `7` 일 | `src/infrastructure/db/ttl.ts` |
| usage 요약 질의 범위 | `184` 일 | `src/app/api/usages/summary/validation.ts` |
| 프로젝트 호출자 usage 한 요청의 원시 행 / 반환·Slack 프로필 해석 수 | `10,000` / `100` | `src/application/usage/listActors.ts` |
| schedule 따라잡기 창 (장애가 한 번에 발화시킬 수 있는 양에 한계를 둔다) | `10` 분 | `src/application/trigger/scanSchedules.ts` |
| scan tick 하나가 동시에 굴리는 schedule 발화 수 | `8` | `src/application/trigger/scanSchedules.ts` |
| schedule 복구 스윕 주기 (잃어버린 런 회수) | `5` 분마다 | `src/application/trigger/scanSchedules.ts` |
| 복구 스윕 하나가 훑는 행 수 | `50` | `src/application/trigger/repairLostRuns.ts` |
| 트리거 런을 유실로 판정하는 시점 | 런 lease 만료 + `10` 분 | `src/application/trigger/repairLostRuns.ts` |
| SSE 응답이 첫 chunk 를 기다리는 유예 | `25s` | `src/app/api/_lib/sse.ts` 의 `FIRST_CHUNK_GRACE_MS` |

### 런 전체의 컨텍스트 예산

위의 항목별 제한들은 그 합에 대해서는 아무 말도 하지 않으므로,
`src/application/llm/contextBudget.ts` 가 한계 하나를 더 소유한다: agent 런의 전체 컨텍스트로,
모델의 `contextWindow` 에서 출력 예약분과 프로토콜 여유분을 뺀 값이다. 예약분은 버전의
`maxTokens` 가 설정돼 있으면 그 값이고, 없으면 그 모델의 레지스트리 최대치다. `max_tokens` 가
wire 에 실리지 않으면 호출을 처리하는 모델이 자기 최대치까지 생성할 수 있기 때문이다. 폴백이
설정돼 있으면 예산은 **두 용량 중 작은 쪽**이고, 각 용량은 그 모델 *자신의* 창에서 자신의
예약분을 뺀 값이다. 런 중간에 폴백으로 바뀌어도 그때까지 쌓인 것이 담겨야 하기 때문이다.
"각자 자기 창에서" 가 요점이다: 한 모델의 출력 예약을 다른 모델의 창에서 빼면 아무것도
강제되지 않으면서 예산만 사라진다. 근거는 "각 모델의 입력 + 그 모델의 출력이 그 모델의 창에
들어가야 한다" 하나뿐이다. "출력 상한이 큰 모델은 창도 크다" 는 더 짧은 설명은 이 레지스트리에서
거짓이다(`minimax-m2.5` 는 204,800 창에 196,608 을 생성하고, `nemotron-3-super-120b` 는
1,000,000 창에 16,384 를 생성한다). **입력과 도구 선언만으로 예산이 이미 0 이 되는 런은 예산 없이
돌고 경고를 하나 남긴다**. 막아야 할 넘침이 이미 요청 안에 들어 있어 자를 것이 없고, 그대로 두면
턴 0부터 모든 도구 호출을 거부하기 때문이다. 입력, 도구
정의, 매 턴의 출력, 도구 결과, 전달받은 답변이 모두 이 예산에서 차감된다. 절단 표시, 래퍼,
생략 문자열까지 포함해서이며, 표시는 잘라 낸 안쪽에 자리를 예약해 두지 결코 그 위에 덧붙이지
않는다. 더 이상 들어가지 않는 것은 모델이 읽을 수 있는 표시와 함께 잘리고 `warning` chunk 로
한 번 보고된다. 런 도중에 provider `400` 으로 넘쳐 버리는 대신에 그렇게 한다.

토큰은 문자로부터 보수적으로 추정한다 (부류별로: ASCII 는 토큰당 3자, 그 외는 자당 1.5토큰,
이미지 part 는 일괄 2,500토큰). 정확한 개수를 세려면 각 provider 의 tokenizer 가 필요하다.
레지스트리에 없는 모델은 **예산을 받지 못한다**: 예산을 도출할 윈도가 없기 때문이고, 그런 런은
예산이라는 것이 존재하기 전의 모든 런이 그랬듯 예산 없이 남는다. `maxTokens` 가 윈도에 용량을
전혀 남기지 않는 버전도 마찬가지다. 0 예산은 런이 채워 보지도 못한 예산을 탓하면서 모든 도구
호출을 거부하게 되기 때문이다. 단발성(`llm`) 런도 예산이 없다. 한 번의 호출에서는 아무것도
누적되지 않고, 입력은 호출자 자신의 것이다.

## 오디오 전사 설정

오디오의 [처리 계약](design/audio-processing-spec.md)은 HTTP API·Agent 도구·별도 worker에서 공유한다. Memory delivery에는 수신 서버의 수집·멱등 저장 계약이 필요하다.
worker 실행과 별개로 schedule을 설정해야 하며 이 값을 넣는 것만으로 자동 수집이 시작되지는 않는다.
원본·전사·요약은 기존 `S3_BUCKET_NAME`을 재사용한다. 비공개·versioning 비활성화와 경로별
보존 정책은 [설치 안내](INSTALL.md#오디오-worker)를 따른다. 별도 원본 bucket 설정은 없다.

| 변수 | 기본값 | 역할 |
| --- | --- | --- |
| `TRANSCRIPTION_BASE_URL` | 미설정 | `/audio/transcriptions` 앞의 ASR base URL. 없으면 선택 모델의 명시적 provider 채널을 요구한다 |
| `TRANSCRIPTION_API_KEY` | 미설정 | 전용 ASR key. base URL 없이 설정하면 거절하며 다른 LLM key를 가져오지 않는다 |
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

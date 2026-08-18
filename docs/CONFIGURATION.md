# 설정

AgentDure 가 환경에서 읽는 모든 값, 그리고 코드에 고정돼 있어 *설정할 수 없는* 제한들.
`.env.example` 은 복사해 쓰는 템플릿이고, 이 문서는 각 값이 무엇을 하는지와 값이 잘못됐을
때 무슨 일이 일어나는지를 설명하는 레퍼런스다.

관련 문서: 배포된 인스턴스에 무엇을 설정할지는 [OPERATIONS.md](OPERATIONS.md), 로컬
`.env.local` 은 [DEVELOPMENT.md](DEVELOPMENT.md), 자격증명에 해당하는 값들은
[SECURITY.md](SECURITY.md).

## 해석 순서

한 설정은 세 곳에서 올 수 있고, 그 값을 가진 첫 번째가 이긴다:

```
DynamoDB SETTINGS#app override   →   environment variable   →   built-in default
```

오버라이드 계층은 admin 전용 `/settings` 페이지다. 아래 표에서 **runtime** 으로 표시된 키만
거기서 오버라이드할 수 있고, 나머지는 전부 env 전용이다 — settings 행을 읽기 전에 필요한
값이거나(`AES_ENCRYPTION_KEY` 가 그 행을 복호화한다) 프로세스가 이미 묶여 있는
인프라이기 때문이다(`STAGE`, DynamoDB, Better Auth).

읽기는 `src/lib/runtime-settings.ts` 를 지나가며, dispatch 시점에 `process.env` 를 직접
읽는 일은 결코 없다 — 그러지 않으면 오버라이드가 settings 페이지에서만 적용되고 다른
어디에도 적용되지 않는다. 값은 `SETTINGS_CACHE_TTL_MS` 동안 메모리에 캐시되고 쓰기 시
캐시가 무효화되지만, **무효화는 프로세스 로컬**이다: 다중 인스턴스 배포에서 TTL 은 강등된
admin 이나 회전된 A2A 키가 그 쓰기를 처리하지 않은 인스턴스들에서 계속 동작하는 시간이다.
기본값이 1분이 아니라 5초인 이유가 그것이다.

오버라이드와 환경변수는 *"설정돼 있는가?"* 에 같은 방식으로 답한다: 비어 있거나 공백뿐인
값은 **설정되지 않음**으로 치고, 유효 값이 되는 대신 다음 계층으로 떨어진다.
`/settings` 에서 빈 칸을 저장하면 오버라이드가 제거되고, `A2A_API_KEY=" "` 는 키가 아니다 — 부팅
시점도 포함해서이며, 거기서는 없는 것으로 보고된다. 이것이 가장 중요한 곳은 파일에서
마운트된 시크릿이다. 헤더가 나를 수 없는 개행이 끝에 붙어 오기 때문이다. 규칙은
`src/shared/env.ts` 가 소유하고, 거기서 돌려주는 값은 trim 돼 있다. `STAGE`,
`DYNAMODB_TABLE_NAME`, `AWS_REGION` 은 예외로, 빈 값을 문자 그대로 받는다. `STAGE` 에서
그것은 의도적이다: 빈 값은 throw 하는데, `local` 로 폴백하면 배포된 stage 에서
`assertAccessControlConfig` 를 건너뛰게 되기 때문이다. `ARTIFACT_ACCESS_MODE` 는 trim
없이 읽는다: 정확히 `public` 이 아닌 것은 무엇이든 `authenticated` 로 읽힌다.
다만 프로덕션 Node 프로세스에서 `STAGE` 를 비워 두는 것은 그 자체로 부팅 에러다. 로컬
컨테이너는 `STAGE=local` 로 명시적으로 남고, 배포된 이미지가 변수 하나가 빠졌다는 이유로
fail-open 이 될 수는 없다.

## 부팅 시 검증

`src/instrumentation.ts` 는 서버가 연결을 받기 전에 검사 두 개를 돌린다. 설정 오류가 그
값을 필요로 하는 첫 요청에서 500 으로 나타나는 대신 시작 시점에 실패하게 하기 위해서다.

| 검사 | 규칙 |
|---|---|
| `assertRequiredConfig` | `LLM_BASE_URL`, `LLM_API_KEY`, `AES_ENCRYPTION_KEY` 가 모든 stage 에서 설정돼 있어야 한다. |
| `assertAccessControlConfig` | `NODE_ENV=production` 은 명시적인 `STAGE` 를 요구한다. `STAGE=alpha` 또는 `prod` 는 추가로 `ADMIN_EMAILS` 를 요구한다. `ALLOWED_EMAIL_DOMAINS` 는 비어 있어도 부팅하며, 대신 경고 한 줄을 남긴다. |

두 번째 검사가 있는 이유는 두 목록 모두 비어 있을 때 fail-open 이기 때문이다 —
`ADMIN_EMAILS` 가 설정되지 않으면 로그인한 모든 사용자가 공유 레지스트리에 대한 admin 이
되고, `ALLOWED_EMAIL_DOMAINS` 가 설정되지 않으면 아무 Google 계정이나 로그인할 수 있다.
앞의 것은 무설정 로컬 개발에만 옳은 기본값이라 `local` 은 그대로 두고 배포된 stage 들이
부팅을 거부한다. 뒤의 것은 배포가 고르는 것이다 — 열린 가입을 의도한 배포가 있고, 이
검사가 읽는 것은 env 인 반면 `getAllowedEmailDomains` 는 여기서 보이지 않는 저장된
오버라이드를 우선하므로 거부는 콘솔에서 도메인을 설정한 배포까지 함께 막는다. 그래서
거부하는 대신 부팅 로그에 경고를 남긴다: 열린 문이어서는 안 될 것이 아니라, 조용해서는
안 될 것이다.

Google OAuth 자격증명은 의도적으로 부팅 필수가 *아니다*: 로컬 dev-session 흐름
(`scripts/dev-session.ts`)은 OAuth 를 통째로 우회한다.

## 핵심

| 변수 | 기본값 | Runtime | 설명 |
|---|---|---|---|
| `STAGE` | production 밖에서는 `local` | — | `local` \| `alpha` \| `prod`. 그 밖의 값은 부팅 시 throw 하며, 프로덕션 프로세스는 이 값을 명시적으로 설정해야 한다. 위의 접근 제어 검사를 게이트한다. |
| `AWS_REGION` | `ap-northeast-2` | — | 모든 AWS 클라이언트가 쓰는 리전. DynamoDB Local 은 액세스 키 **와** 리전으로 테이블 네임스페이스를 나누므로, 앱과 `pnpm init-local-table` 이 서로 일치해야 한다. |
| `DYNAMODB_TABLE_NAME` | `agentdure` | — | 단일 테이블. 공유 로컬 DynamoDB 에서는 포트가 아니라 이것이 프로젝트들을 갈라놓는다. |
| `DYNAMODB_ENDPOINT` | 미설정 | — | DynamoDB Local 전용. **alpha/prod 에서는 반드시 비어 있어야 한다.** 남아 있는 값은 앱을 존재하지도 않는 localhost 로 향하게 한다. |
| `AES_ENCRYPTION_KEY` | — (필수) | — | 32바이트 base64. 저장되는 모든 시크릿을 암호화한다. [SECURITY.md](SECURITY.md#저장된-시크릿) 를 보라. |
| `S3_BUCKET_NAME` | 미설정 | — | 런이 만들어 낸 것 — 생성된 이미지와 저장된 문서 — 이 `artifacts/<kind>/` 아래로 들어가는 버킷. 행에는 오브젝트 키가 저장되고 URL 은 절대 저장되지 않는다. 역할의 권한은 (레거시 `images/*` 만이 아니라) **`artifacts/*`** 를 `s3:PutObject`, `s3:GetObject`, `s3:DeleteObject` 로 덮어야 한다. 설정하지 않으면 영속화가 통째로 꺼진다: 런은 여전히 그림을 그리고, 바이트는 표면까지 도달했다가 거기서 멈추며, artifact 갤러리는 404 로 답한다. |
| `ARTIFACT_ACCESS_MODE` | `authenticated` | **runtime** | `authenticated` 는 유효 기간이 있는 pre-signed URL 을 돌려주고 버킷을 비공개로 유지한다. `public` 은 영구적인 S3 직접 URL 을 돌려주는데, 버킷 정책과 S3 Block Public Access 설정이 `artifacts/*` 와 레거시 `images/*` 의 공개 읽기를 허용할 때만 동작한다. **다운로드 링크는 어느 모드에서든 pre-signed 다.** 브라우저가 저장할 파일명이 요청 서명에 실려 가는데 S3 는 익명 GET 에서 `response-*` 오버라이드를 거부하기 때문이다 — 그래서 `public` 모드에서 문서의 주소는 유효 기간이 있고 이미지의 주소는 영구로 남는다. public 모드는 갤러리 메타데이터와 삭제가 인증을 유지하더라도 URL 을 손에 넣은 누구에게나 오브젝트를 노출한다. 모르는 값은 `authenticated` 로 fail-closed 된다. |
| `VECTOR_BUCKET` | 미설정 | — | capability 카탈로그를 담는 S3 Vectors 버킷. 설정하지 않았다면 그 배포에 카탈로그가 없다는 뜻이다: `POST /api/catalog/reindex` 는 503 으로 답하고, 런은 자기 버전이 바인딩한 것만 제공한다. 그 503 에는 원인이 둘 있고 토큰 검사가 먼저 돌므로, `SCHEDULE_SCAN_TOKEN` 이 설정되지 않은 경우에도 메시지만 다른 같은 상태 코드가 나온다. 역할에는 인덱스에 대한 `s3vectors:PutVectors`, `QueryVectors`, `GetVectors`, `ListVectors`, `DeleteVectors` 가 필요하다 — `GetVectors` 가 필요한 이유는 검색이 각 매치의 메타데이터를 요구하는데 쿼리가 그 액션 아래에서만 그것을 돌려주기 때문이다. 이것이 빠진 역할은 **재색인은 성공하고 그다음 모든 조회에 실패한다**: 쓰기는 통과하고, 콘솔에는 건강한 카탈로그가 보이는 채로 런마다 `capability discovery failed; running with bindings only` 를 로그에 남긴다. |
| `CATALOG_INDEX` | `capabilities` | — | 그 버킷 안의 인덱스. 차원이 `EMBEDDING_MODEL` 의 것과 맞아야 하고 metric 은 cosine 이어야 한다. |
| `EMBEDDING_PROVIDER` | `openai` | — | `cohere` \| `bedrock` \| `openai`. 앞의 둘은 Bedrock 이라 자격증명이 필요 없고 — pod 역할이 `bedrock:InvokeModel` 을 들고 있다 — `openai` 는 `LLM_BASE_URL`/`LLM_API_KEY` 를 재사용하며 그 엔드포인트가 `/embeddings` 를 제공할 것을 요구한다. 인식되지 않는 값은 무엇이든 `openai` 로 읽힌다. **데모 클러스터는 `cohere` 로 돈다.** 아래 표를 보라. |
| `EMBEDDING_MODEL` | provider 별로: `global.cohere.embed-v4:0`, `amazon.titan-embed-text-v2:0`, `text-embedding-3-small` | — | 이 값을 바꾸는 것은 **인덱스를 다시 만드는 것**을 뜻한다 — 두 모델에서 나온 벡터는 비교할 수 없고, 섞인 인덱스에서는 아무것도 그 사실을 알려 주지 않는다. 점수가 그냥 틀릴 뿐이다. Cohere v4 는 **inference profile** 을 통해 도달한다. 맨 모델 id 는 on-demand 호출을 아예 거부한다. |
| `EMBEDDING_DIM` | `1024` | — | 인덱스를 만들 때 쓴 폭이며, 모든 경로에서 이 값을 요청한다. Cohere v4, Titan v2, OpenAI 의 v3 모델은 각각 여러 폭을 제공하는데 그 기본값 중 1024 인 것은 하나도 없다 — `text-embedding-3-small` 은 원래 1536 이다 — 그래서 provider 를 기본값에 맡기면 인덱스가 거부하는 벡터로 답하고, 카탈로그는 이유를 말해 주는 것이라곤 백그라운드 로그 한 줄뿐인 채로 비어 있게 된다. |
| `CATALOG_MIN_SCORE` | `0.25` | — | 관련성 하한, 범위는 `(0, 1]`. 이 값은 검색이 아니라 **임베딩 모델**에 속한다 — `EMBEDDING_MODEL` 이 바뀔 때마다 다시 측정하라. 그러지 않으면 카탈로그가 전부 답하거나 아무것도 답하지 않는다. 아래 표를 보라. `TRACE_SAMPLE_RATE` 처럼 폴백하는 대신 경고와 함께 `0`–`1` 로 **clamp** 된다. 숫자가 아닌 값은 기본값을 쓴다. 이것은 컷의 절반일 뿐이고 — 나머지 절반은 그 쿼리 자신의 최고 점수에 대한 쿼리별 비율이며, 둘 중 높은 쪽이 이긴다 — 그래서 `0` 으로 clamp 된 값이 전부를 통과시키지는 않는다. 비율이 볼 수 없는 경우, 즉 카탈로그에 맞는 것이 아예 하나도 없다는 경우에 대한 답을 없앨 뿐이다. |
| `PUBLIC_BASE_URL` | `BETTER_AUTH_URL`, 없으면 요청 origin, 그것도 없으면 `http://localhost:3000` | **runtime** | 바깥을 향하는 URL (A2A Agent Card, Slack 매니페스트, OAuth 콜백, MCP client ID 메타데이터 문서)을 만들 때 쓰는 scheme + host. 리버스 프록시 뒤에서는 요청 URL 이 bind 주소를 반영하므로 이 값은 설정에서 와야 한다. 요청 origin 단계는 요청이 손에 있는 곳에서만 적용된다 — A2A Agent Card 경로에는 요청이 없어서, 두 변수 모두 설정되지 않으면 카드가 `localhost` 를 광고한다. **메타데이터 문서는 올바르기만 해서는 안 되고 공개적으로 fetch 가능해야 하는 소비자다**: 그 URL 이 곧 OAuth `client_id` 이고, authorization server 가 그것을 가져간다. 거기에 loopback 이나 평문 http 값이 있으면 흐름이 시작되기 전에 거부되고, provider 가 제공하는 경우 연결은 dynamic registration 으로 폴백한다 — [SECURITY.md](SECURITY.md#mcp-oauth) 를 보라. |

### 임베딩 모델 선택

영어로 기술돼 있고 한국어로 질의되는 이 배포의 레지스트리를 대상으로, 파이프라인 전체를
통과시켜 측정했다:

| 모델 | 정답 | 무관 | 한국어 질의, 영어 설명 |
|---|---|---|---|
| `amazon.titan-embed-text-v2:0` | 0.34–0.41 | 0.04–0.12 | **0.065** — 노이즈와 구별되지 않는다 |
| `text-embedding-3-large` | 0.41–0.58 | 0.21–0.22 | 0.169 — 노이즈보다 *아래* |
| **`global.cohere.embed-v4:0`** | 0.30–0.53 | 0.21–0.24 | **0.393** — 노이즈에서 확실히 벗어난다 |

이 배포가 실제로 가진 케이스를 갈라내는 것은 Cohere 뿐이다. Titan 에서
"깃헙 레포 알려줘" 는 `github` 서버에 대해 0.065, 무관한 skill 에 대해 0.041 이 나와서
어떤 임계값으로도 찾아낼 수 없다. `3-large` 에서는 무관한 행들보다 *낮은* 점수가 나온다. Cohere 는 토큰당 비용이
`3-large` 와 비슷하고 Titan 의 몇 배인데, 카탈로그 규모에서 그것은 한 달에 1~2달러다 —
선택 기준은 가격이 아니라 정확도다.

Cohere 가 대신 치르는 대가는 모든 점수가 더 높게 나온다는 것이고, 그래서 여기서
`CATALOG_MIN_SCORE` 는 0.25 이며 Titan 이었다면 0.15 였을 것이다. 레지스트리와 요청이 같은
언어를 쓰는 배포는 이 차이를 보지 못하며 셋 중 무엇을 써도 된다.

## 인증과 접근 제어

| 변수 | 기본값 | Runtime | 설명 |
|---|---|---|---|
| `BETTER_AUTH_SECRET` | — | — | 세션 서명 시크릿 (`npx @better-auth/cli secret`). |
| `BETTER_AUTH_URL` | — | — | Better Auth 가 콜백을 만들 때 기준으로 삼는 base URL. |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | — | — | 실제 로그인에만 필요하다. |
| `ALLOWED_EMAIL_DOMAINS` | 비어 있음 | **runtime** | 로그인이 허용되는 도메인의 쉼표 구분 목록. 비어 있으면 = 아무 도메인이나 — 배포된 stage 에서는 부팅을 막지 않고 경고를 남긴다. |
| `TRUSTED_PROXY_CIDRS` | 비어 있음 | — | 이 배포 앞에 있는 리버스 프록시들의 IP/CIDR 범위, 쉼표 구분 (예: ALB 와 Istio 가 둘 다 `X-Forwarded-For` 에 덧붙일 때의 VPC CIDR). Better Auth 는 rate limiting 의 키로 삼는 클라이언트 IP 를 알아내기 위해 체인 오른쪽에서 이 홉들을 벗겨 낸다. 비어 있으면 값이 하나뿐인 헤더만 신뢰하므로, 프록시 두 개 뒤에서는 모든 요청이 하나의 공유 버킷에 떨어진다. |
| `ADMIN_EMAILS` | 비어 있음 | **runtime** | 쉼표 구분. 레지스트리·설정 변경 권한과 남이 소유한 프로젝트에 대한 쓰기 권한을 준다. 목록에 있는 멤버는 저장된 `admin` tier 로 승격되고 거기 고정된다. 목록에서 빼도 자동 강등은 없다. 비어 있으면 레지스트리·설정 변경에는 *제한 없음*, 프로젝트 오버라이드에는 *아무도 아님* 을 뜻한다 — 두 질문이 서로 다른 술어로 답해지는 것은 의도적이다 ([SECURITY.md](SECURITY.md#인가-모델)). |

## LLM 채널

모든 트래픽은 OpenAI Chat Completions 프로토콜로 말한다. 모델 id 는 `provider/model` 이다.

| 변수 | 기본값 | Runtime | 설명 |
|---|---|---|---|
| `LLM_BASE_URL` | — (필수) | **runtime** | 기본 채널 — OpenRouter 나 LiteLLM 같은 라우터. provider 채널이 가져가지 않는 한 모든 모델 id 가 여기로 간다. |
| `LLM_API_KEY` | — (필수) | **runtime** | 그 채널의 자격증명. |
| `LLM_PROVIDER_<NAME>_BASE_URL` | 미설정 | **runtime** | provider 별 채널을 등록한다. `<NAME>` 은 모델 id 의 provider 접두사를 대문자로 쓴 것이다. 레지스트리의 provider 는 `OPENAI`, `ANTHROPIC`, `GOOGLE`, `XAI`, `BEDROCK`, `OPENROUTER` 다. env 파서는 `[A-Z0-9_]+` 형태의 이름이면 무엇이든 받지만, 그 목록 밖의 채널은 어떤 모델 id 와도 절대 매치될 수 없다 — `/settings` 오버라이드 경로는 그런 것을 아예 거부한다. |
| `LLM_PROVIDER_<NAME>_API_KEY` | 미설정 | **runtime** | 그 채널의 자격증명. `_AUTH=sigv4` 가 아닌 한 필수다: 키가 없는 채널은 **조용히 건너뛰어지고**, 그 모델들은 기본 채널로 떨어진다. |
| `LLM_PROVIDER_<NAME>_AUTH` | `bearer` | **runtime** | `bearer` \| `sigv4`. `sigv4` 는 프로세스의 AWS 자격증명(클러스터에서는 Pod Identity, 로컬에서는 `AWS_PROFILE`)으로 매 요청에 서명하고 API 키를 **받지 않는다**. 문자 그대로의 `sigv4` 가 아닌 값은 전부 `bearer` 로 읽히므로, 오타가 서명도 키도 없는 채널을 만들어 낼 수는 없다. |
| `LLM_PROVIDER_<NAME>_KEEP_MODEL_PREFIX` | `false` | **runtime** | provider 채널은 맨 모델 이름(`provider/` 접두사를 벗긴 것)을 받는다. 그 채널 자체가 전체 id 를 기대하는 라우터일 때 이 값을 켜라. |

> base URL 에는 provider 가 서비스하는 API 버전 경로가 포함돼야 한다 — 어댑터는 거기에
> `/chat/completions` 와 `/images/generations` 를 글자 그대로 덧붙인다. `https://api.x.ai/v1`
> 대신 `https://api.x.ai` 를 쓰면 그 provider 로 가는 **모든** 호출이 텍스트든 이미지든 404 가
> 되고, 증상은 `The requested resource was not found` 라고 적힌 도구 결과다. `pnpm
> check-models` 는 각 채널의 도달 가능성을 보고하며, 그것이 이 문제를 확인하는 가장 빠른
> 방법이다.

provider 채널이 하나라도 설정돼 있으면 `GET /api/models` 는 그 provider 들의 모델만
나열한다. 하나도 설정돼 있지 않으면 레지스트리에서 보이는(`hidden` 이 아닌) 모든 모델을
나열한다.

`/settings` 에 저장된 `llmProviders` 오버라이드는 `LLM_PROVIDER_*` env 집합과 병합되는 것이
아니라 **그 집합 전체를 대체한다** — 부분 병합은 "이 provider 를 제거한다" 를 표현할 수 없는
편집으로 만들어 버린다.

### 모델 레지스트리: family 와 offering

선택 가능한 모델은 `src/domain/llm/models.ts` 에 살고 손으로 관리된다. 가격, 컨텍스트 윈도,
capability 플래그가 각 provider 의 문서에만 존재하기 때문이다.

이 파일은 목록 둘을 담는다. **family** 는 모델을 한 번 기술한다 — 표시 이름, 가격, 윈도,
capability. **offering** 은 어떤 provider 가 그 family 를 어떤 wire 이름으로 제공하는지,
그리고 그 경로가 무엇을 바꾸는지를 말한다. `MODEL_CONFIGS` 는 그 둘에서 파생되며 id 는
`provider/family` 다. 그래서 세 가지 경로로 도달하는 같은 모델은 하나의 숫자 묶음과 한 줄짜리
경로 셋이 된다:

```ts
{ family: "claude-opus-4.8", provider: "anthropic",  wireId: "claude-opus-4-8" },
{ family: "claude-opus-4.8", provider: "openrouter", wireId: "anthropic/claude-opus-4.8" },
```

offering 은 `pricing`, `capabilities`, `contextWindow`, `maxTokens`, `hidden` 을 오버라이드할
수 있다 — 얕은 병합이라, 다른 것만 이름 붙이면 된다. 오버라이드는 *경로* 가 바꾸는 것(라우터
자신의 요율, structured output 을 못 하는 게이트웨이)을 위한 것이지, 모델이 무엇인가를 위한
것은 결코 아니다: `tests/models.test.ts` 는 두 경로가 이름, 윈도, 혹은 그것이 이미지를
생성하는지 여부에 대해 서로 다른 말을 하면 실패한다.

레지스트리 id 는 라우터 관례(`anthropic/claude-opus-4.8`)를 따르고, 저장된 프로젝트 버전이
들고 있는 것도 그것이다. 어떤 경로가 모델 이름을 다르게 쓸 때 — Anthropic 은
`claude-opus-4-8` 을 제공하고 점이 있는 형태에는 404 를 낸다. OpenRouter 는
`anthropic/claude-opus-4.8` 을, Bedrock 은 `openai.gpt-oss-120b` 를 제공한다 — `wireId` 를
설정하라. 채널이 접두사를 벗겨 낸 뒤 실제로 전송되는 것이 그것이다. 대신 항목 이름을 바꾸면
옛 id 를 참조하던 모든 저장된 버전이 고아가 된다.

**Bedrock 의 모델 목록은 이 프로토콜이 도달할 수 있는 모델의 목록이 아니다.** OpenAI 호환
엔드포인트는 `bedrock-mantle`(`https://bedrock-mantle.<region>.api.aws/v1`, `_AUTH=sigv4`)
인데, 거기의 `GET /v1/models` 는 `POST /v1/chat/completions` 가 그다음 거부하는 모델들을
돌려준다: 모든 `anthropic.*` 모델(이들은 Anthropic Messages API 를 받는데 이 앱은 그 말을
하지 못한다)과 `xai.grok-4.3`(`isn't supported on this route`)이며, AWS 는 둘 다에 대해
가격도 공개한다. 그래서 Bedrock offering 은 실제 호출이 답을 돌려준 뒤에만 추가한다 —
레지스트리에 있는 것들은 open-weight 모델이고 하나하나 smoke test 를 거쳤다. 또한
`bedrock-mantle` 은 `ap-northeast-2` 에 존재하지 않으므로 그 base URL 은 배포의 나머지와
다른 리전을 지목한다. 서명자는 `AWS_REGION` 이 아니라 그 URL 에서 리전을 읽는다.

**자기 비용을 보고하는 채널은 믿는다.** OpenRouter 는 모든 호출에 `usage.cost`(USD)를
돌려주고, usage 행에 기록되는 것은 레지스트리의 요율이 아니라 그 수치다. 레지스트리 가격은
런 전에 보여 주는 추정치이자, 토큰만 보고하는 모든 채널을 위한 폴백으로 남는다.

**레지스트리에 없는 모델도 기본값에서는 그대로 실행되지만, 그 usage 는 $0 으로 값이 매겨진다**
— 그래서 그 공백은 자기가 망가뜨리는 비용 대시보드에서 보이지 않는다. 놓칠 때마다
`[cost] unknown model id` 를 한 번 로그하고 `agentdure_unknown_model_calls_total` 을
증가시킨다. 비용을 알아차릴 때까지 기다리지 말고 0 이 아닌 비율에 알림을 걸어라.
`pnpm check-models` 는 레지스트리를 설정된 채널들이 실제로 제공하는 것과 비교한다 —
[DEVELOPMENT.md](DEVELOPMENT.md#스크립트) 를 보라.

| 변수 | 기본값 | Runtime | 설명 |
|---|---|---|---|
| `UNKNOWN_MODEL_POLICY` | `allow` | **runtime** | `allow` \| `refuse`. 레지스트리가 값을 매길 수 없는 모델을 런이 실행해도 되는지. 그 밖의 값은 전부 `allow` 로 읽히므로, 잘못된 형식의 값이 배포가 멈추는 이유가 되는 일은 없다. |

`refuse` 는 **런 브래킷**에서 검사한다. 네 개의 admit 함수가 모두 지나가는 한 지점이며,
버전의 `model` 뿐 아니라 `fallbackModel` 까지 함께 다룬다 — 폴백은 주 모델이 rate limit 에
걸릴 때마다 런 전체를 떠맡으므로, 값이 매겨지지 않은 폴백은 정확히 같은 만큼 새어 나가되
간헐적으로 그럴 뿐이다. dispatch 전에 throw 하므로, 호출자는 열렸다가 실패하는 스트림이 아니라
`400` 을 받는다.

**subagent transfer** 도 자식의 버전이 해석되는 자리에서 검사한다. 그것은 브래킷을 열지
않지만 — top-level run 이 아니다 — dispatch 하고 usage 를 기록하는 것은 똑같으며, 부모의
모델은 자식의 모델에 대해 아무것도 말해 주지 않는다. 거기서 거부는 런이 아니라 transfer 를
실패시킨다: 부모는 이유를 전달받고 그 자식 없이 답할 수 있다.

**버전 저장은 건드리지 않는다**: 레지스트리가 아직 따라잡지 못한 id 를 저장하는 것이야말로
새 모델을 도입하는 방식이고, 그 경로는 자기 경고를 유지한다. 이 설정이 한계를 두는 것은
무엇으로도 값을 매길 수 없는 id 아래에서 돈을 쓰는 일이다.

## 실행 제한

| 변수 | 기본값 | Runtime | 설명 |
|---|---|---|---|
| `MAX_RUN_DURATION_MS` | `600000` (10분) | — | 모든 진입점에 걸리는, 단일 런의 실제 경과 시간 상한. 멈춰 버린 provider 나 도구 호출이 무한정 돌거나 무한정 청구할 수 없다. 유효하지 않은 값은 경고와 함께 무시된다. Slack 경로는 추가로 고정된 3분 인터랙티브 데드라인(아래)을 적용하는데, 그것은 런을 짧게 만들 수만 있다. 이 값과 함께 움직이는 파생값이 셋 있다: 런 슬롯 lease(이 값 + 60초), MCP OAuth 토큰 갱신 여유(이 값 + 5분), 리플레이 signed URL 수명(이 값 + 15분, `src/application/artifact/urlTtl.ts`). |
| `MAX_CONCURRENT_RUNS_PER_ACTOR` | `10` | — | 한 호출자가 동시에 진행할 수 있는 런 수. `0` 은 제한을 끈다. 자기 `maxConcurrentRuns` 를 가진 멤버 tier(*코드에 고정된 제한* 참고)는 그 멤버 자신의 런에 대해 이 값을 덮어쓴다 — 기본 `guest` tier 가 그런 값을 하나 들고 있다. `admin`/`member`, 프로젝트 토큰, 그리고 모든 기계 호출자는 이 값을 물려받는다. |
| `MAX_CONCURRENT_RUNS_A2A` | `50` | — | **공유** A2A 키로 이뤄진 호출을 위한 별도 상한. 그 actor id 는 상수라서, 하나의 정체성이 거기의 모든 기계 호출자를 대표한다. 그러지 않으면 호출자별 제한이 A2A 표면 전체에 상한을 씌우게 된다. 이름이 붙은 클라이언트 키는 호출자 하나이며 사람과 마찬가지로 `MAX_CONCURRENT_RUNS_PER_ACTOR` 아래에 놓인다. |
| `SCHEDULE_SCAN_TOKEN` | 미설정 | — | 모든 ticker 가 제시하는 단 하나의 자격증명(`X-Scan-Token`)이며, CronJob 이 POST 하는 세 엔드포인트가 공유한다: `/api/triggers/scan`(schedule), `/api/plugins/sync/scan`(plugins 저장소), `/api/catalog/reindex`(capability 카탈로그). 설정하지 않으면 이 배포에 ticker 가 없다는 뜻이다: 셋 다 503 으로 답하고 schedule 트리거는 결코 발화하지 않는다 — 열리는 대신 꺼진다. |

유효하지 않은 값(정수가 아니거나 음수)은 `0` 이 아니라 경고와 함께 기본값으로 떨어진다 —
`Number("abc") || 0` 은 "제한 꺼짐" 으로 읽히는데, 그것은 오타가 뜻해야 하는 바의 정반대다.

**이 문서의 거의 모든 숫자 설정이 그렇게 동작한다**: 이들은 `positiveIntEnv` 를 지나가며,
파싱과 경고까지 `src/lib/config.ts` 가 그것을 소유한다. 그 바깥에 있는 설정이 두 종류 있고
각각 자기 행에서 그렇게 말한다: `0`–`1` 값들(`TRACE_SAMPLE_RATE`, `CATALOG_MIN_SCORE`)은
폴백하는 대신 **clamp** 하고, `MAX_RUN_DURATION_MS` 는 `src/shared/runDeadline.ts` 에서 스스로
파싱한다 — `application` 이 그 데드라인을 필요로 하는데 `lib` 를 import 할 수 없기 때문이다 —
`AbortSignal.timeout` 의 정의역에 대해 값을 검증하고 같은 경고와 함께 기본값으로 떨어진다.

한 설정이 어떤 헬퍼를 부르는지는 그것이 어디에서 자기를 *선언하는지* 와 별개의 문제다:
대부분은 `config.ts` 에서, 보존 기간은 `src/infrastructure/db/ttl.ts` 에서,
`SETTINGS_CACHE_TTL_MS` 는 `src/lib/runtime-settings.ts` 에서 선언한다. 어댑터는 변수를 직접
읽지 않는다 — `tests/architecture.test.ts` 는 `domain`, `shared`, `infrastructure`,
`application` 어디에서든 `process.env` 를 읽으면 실패하고, `runDeadline.ts` 가 **이름이 명시된**
유일한 예외라서 두 번째 예외가 조용히 들어올 수 없다. 경고는 설정마다 값마다 한 번씩만
나온다. 이 중 몇몇은 행을 쓸 때마다 읽히기 때문이다.

## MCP

| 변수 | 기본값 | Runtime | 설명 |
|---|---|---|---|
| `MCP_DISCOVERY_CACHE_TTL_MS` | `60000` | — | 바인딩된 서버의 도구 목록을 얼마나 오래 재사용하는지. 키는 `url + headers` 다. 캐시가 따뜻하면 세션이 지연 연결될 수도 있어서, 도구를 하나도 부르지 않는 턴은 MCP 요청을 아예 하지 않는다. `0` 은 캐싱을 통째로 끄며, 어떤 서버 힌트도 그것을 다시 켤 수 없다. 밀리초 정수. |
| `MCP_MAX_SERVER_TTL_MS` | `300000` (5분) | — | 서버가 `tools/list` 에서 요청할 수 있는 `ttlMs` 의 상한 (SEP-2549). `0` 은 서버 힌트를 완전히 무시하고 모든 항목을 로컬 TTL 로 되돌린다. 밀리초 정수. |
| `MCP_INTERNAL_HOST_SUFFIXES` | 비어 있음 | — | 사설 주소로 resolve 되더라도 MCP 항목이 쓸 수 있는 호스트의 DNS suffix 목록, 쉼표 구분 — 보통 `<namespace>.svc.cluster.local`. 비어 있으면 SSRF 가드는 원래 그대로다. [SECURITY.md](SECURITY.md#선언된-내부-호스트) 를 보라. |
| `MANAGED_MCP_INSTANCE_ID` | 미설정 | — | managed MCP 컨테이너가 SSM Run Command 를 통해 기동되는 호스트. 문자 그대로의 값 `local` 은 대신 이 머신에서 Docker 를 돌린다 — 그러면 앱과 컨테이너가 loopback 인터페이스를 직접 공유하는데, 그것이 EC2 없이 이 경로를 실행해 볼 수 있는 유일한 방법이다. |
| `MANAGED_MCP_REGISTRY` | 미설정 | — | `docker login` 이 인증하는 레지스트리. 덕분에 이 계정 자신의 이미지는 자격증명을 타이핑하지 않고도 pull 된다. 호스트가 pull 할 수 있는 다른 어떤 레지스트리의 이미지도 허용되며, 그것들에 대해서는 로그인만 건너뛴다. |
| `MANAGED_MCP_NETWORK_CONTAINER` | `agentdure` | — | managed 워크로드가 네트워크 네임스페이스를 공유하는 컨테이너 — 이 앱 자신이다. 모든 컨테이너는 자기만의 `127.0.0.1` 을 가지므로, loopback 주소는 양쪽 끝이 같은 네임스페이스에 있을 때만 의미가 있다. |

`MANAGED_MCP_INSTANCE_ID` 와 `MANAGED_MCP_REGISTRY` 가 설정되지 않으면 managed-MCP 라우트는
기능을 절반만 켜는 대신 `503` 으로 답한다.

**discovery TTL 에 손잡이가 둘인 이유.** 항목의 수명은 숫자 하나로 두 질문에 답한다. 서버의
힌트는 첫 번째에 답한다 — 자기 카탈로그가 얼마나 신선한가 — 그리고 그건 이 앱보다 서버가 더
잘 안다. 그런데 같은 숫자가 두 번째에도 한계를 둔다: 레지스트리 편집 시의 무효화는 프로세스
로컬이라, 그 숫자는 *다른* 인스턴스들에서 그 편집이 보이지 않는 시간이기도 하다. 두 번째
답은 서버가 아니라 배포에 속하고, 상한이 없으면 한 시간을 요청하는 서버 하나가 그것을 함대
전체에 대해 결정해 버린다. 대신 `MCP_DISCOVERY_CACHE_TTL_MS` 를 올리면 힌트가 없는 서버들도
다시 읽히지 않게 되는데, 그건 반대 방향의 거래다 — 그래서 손잡이가 따로 있다. 단일 인스턴스
배포는 `MCP_MAX_SERVER_TTL_MS` 를 마음껏 올려도 되고, 다중 인스턴스 배포는 감수할 수 있는
낡음 정도에 가깝게 유지해야 한다.

실패한 discovery 도 캐시되며, 기간은 `MCP_DISCOVERY_CACHE_TTL_MS` 와 30초 중 작은 쪽이다.
그것이 없으면 죽어 있는 서버는 — 또는 토큰이 폐기된 연결은 — 모든 메시지의 첫 토큰 전에
실패하는 연결 비용을 다시 치른다. 창이 짧은 이유는, 낡은 실패는 복구를 가리는 반면 낡은
성공은 조금 오래된 도구 목록을 내놓을 뿐이기 때문이다.

## 소스 저장소

| 변수 | 기본값 | Runtime | 설명 |
|---|---|---|---|
| `PLUGINS_REPO` | 미설정 | **runtime** | [Agent Plugins 1.0.0](https://agent-plugins.org/) 저장소의 `owner/repo`. `plugin.json` 을 가진 모든 디렉터리가 — 저장소 루트를 포함해 — 하나의 plugin 이다. 다른 루트 안에 중첩된 루트는 거부된다. plugin 당: `skills/<name>/SKILL.md` (Agent Skills 스펙 — frontmatter 의 `name` 이 디렉터리와 일치해야 하고 `description` 은 필수), `mcp.json` (`type: "streamable-http"` 서버만 바인딩된다. `stdio` 와 `sse` 항목은 보고되고 건너뛰며 결코 실행되지 않는다), 그리고 닫힌 mcp.json 스키마에는 자리가 없는 각 서버의 설명(frontmatter)과 운영 노트(본문)를 담는 `org.opspresso.agentdure/mcp/<server>.md` 확장 문서. |
| `PLUGINS_REPO_BRANCH` | `main` | **runtime** | |
| `GITHUB_TOKEN` | 미설정 | **runtime** | plugins 저장소에 대한 contents 읽기 권한이 필요하다. |

**저장소는 자기가 선언한 것을 — 이름으로 — 소유하고, 삭제는 사람이 소유한다.** sync 가 만든
항목, 다른 출처에서 입양한 항목(provenance 는 plugin 단위로 `github:<repo>#<plugin>`), 그리고
sync 가 존재하기 전에 손으로 등록된 항목은 전부 매 sync 마다 provenance 를 포함해 저장소의
버전으로 자동으로 맞춰진다. 저장소가 선언한 이름에 가한 콘솔 편집은 대체된다. 어떤 plugin 도
선언하지 않은 이름을 가진, 손으로 등록된 항목은 손대지 않는다. 이전 sync 가 만들었지만
저장소가 더 이상 들고 있지 않은 이름은 plugin 단위로 고아로 보고될 뿐이고, 사람이 콘솔에서
그것을 골랐을 때 삭제된다 — MCP 항목은 자격증명을 담고 있을 수 있다.

`mcp.json` 에 선언된 헤더는 **가져오지 않으며** — 시크릿은 git 에 있을 것이 아니다 — 버려진
헤더 이름들은 보고된다. 자격증명은 sync 이후 콘솔에서 설정하고, 그것들은 결코 주소를 따라가지
않는다: 저장소가 서버의 URL 을 옮기면 저장된 헤더와 OAuth 블록은 새 호스트로 보내지는 대신
버려지고 보고된다(`credentials-reset`). 클러스터 내부 URL 은 그 호스트가
`MCP_INTERNAL_HOST_SUFFIXES` 에 덮여 있을 때만 이 방식으로 등록 가능하다 — sync 는 타이핑된
URL 과 똑같은 outbound 가드를 마주하며, 거부는 전체 실행을 실패시키는 대신 skip 으로 보고된다.

sync 는 저장소당 한 번에 하나씩만 돈다(두 번째 요청은 409 로 답한다). 자기 리포트를 영속화하며
(`/plugins` 에서 새로고침을 넘어 보인다), schedule CronJob 이
`POST /api/plugins/sync/scan` (`X-Scan-Token`: `SCHEDULE_SCAN_TOKEN`)으로 tick 을 걸 수 있다.
이 경로는 브랜치 head 가 마지막 클린 리포트와 일치하는 동안에는 스냅샷을 통째로 건너뛴다.

## Slack

| 변수 | 기본값 | Runtime | 설명 |
|---|---|---|---|
| `SLACK_LOADING_INDICATOR` | `:hourglass_flowing_sand:` | — | Slack 답변이 아직 쓰이고 있는 동안 뒤에 붙였다가 마지막 편집에서 떼어 내는 표시. **edit-in-place 폴백에서만 그렇다** — 스트리밍되는 답변은 Slack 자신이 아직 도착 중이라고 표시해 준다. 자기 spinner 이모지를 가진 워크스페이스는 여기에 그 이름을 적는다. 기본값이 내장돼 있는 이유는, 워크스페이스가 정의하지 않은 커스텀 이름은 글자 그대로 렌더링되기 때문이다. |

프로젝트별 Slack 설정 — 봇 토큰, signing secret, 추천 프롬프트, 그리고 멘션 없이 봇을 깨우는
**채널 키워드** — 는 환경이 아니라 프로젝트에 산다 (`/projects/{name}/settings`). 어떤 버전의
런이 워크스페이스를 *읽어도* 되는지는 버전 파라미터(`slackWorkspace`)이고 기본은 꺼짐이다.

**생성되는 매니페스트는 릴리즈와 함께 바뀐다.** 이제 `message.channels` 와
`message.groups` 를 구독하고 `channels:read` 를 요청한다. 그 이전에 설치된 앱은 설치 당시의 scope 와 이벤트를
유지하므로, 매니페스트를 다시 적용하고 앱을 재설치하기 전까지 채널 후속 응답과 `SlackChannels`
도구는 작동하지 않는 채로 남는다.

## Telegram

환경에는 아무것도 없다. 프로젝트별 설정 — 봇 토큰과 봇이 켜져 있는지 여부 — 는 프로젝트에
산다 (`/projects/{name}/integrations`). webhook 시크릿은 거기서 발급되고, 봇을 켜면
`PUBLIC_BASE_URL/api/telegram/webhook/{project}` 에 webhook 이 등록되며 끄면 삭제된다 (*Register
webhook* 은 주소가 바뀐 뒤 다시 가리키는 용도다) — 그래서 `PUBLIC_BASE_URL` 은 Telegram 이
도달할 수 있는 주소여야 한다. BotFather 의 *privacy mode* 는 켜 둔 채로 둬도 된다: 어차피 봇은
그룹에서 자기를 지목한 것에만 답한다 ([design/telegram.md](design/telegram.md)).

## Microsoft Teams

환경에는 아무것도 없다. 프로젝트별 설정 — Azure Bot 의 Microsoft App ID, 클라이언트 시크릿,
(단일 테넌트 앱이면) 테넌트 id, 켜져 있는지 여부 — 는 프로젝트에 산다
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
| `TRACE_SAMPLE_RATE` | `0.1` | — | `0`–`1`, top-level predict 런과 이미지 런에 적용된다. agent 런은 항상 trace 된다. 위의 제한들과 달리, 범위를 벗어난 값은 폴백하는 대신 범위 안으로 **clamp** 된다 — `2` 라는 비율은 "가능한 한 많이" 를 뜻한다 — 반면 숫자가 아닌 값은 기본값을 쓴다. 둘 다 로그에 그렇게 남긴다: 조용히 다른 값이 돼 버린 샘플링 비율은 배포가 기록한 적도 없는 trace 로부터 추론하게 만드는 방식이다. |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | 미설정 | — | OTLP HTTP base 엔드포인트 (없으면 `/v1/traces` 를 덧붙인다). 설정되면 플랫폼이 영속화하는 모든 trace 가 DynamoDB 쓰기 이후에 OTEL span 으로도 내보내진다. export 실패는 `[otel]` 로그 라인으로 드러날 뿐, 결코 런으로 드러나지 않는다. 설정하지 않으면 export 자체가 없고 OTEL SDK 는 로드되지도 않는다. |
| `OTEL_EXPORTER_OTLP_HEADERS` | 미설정 | — | 표준 `key=value,key2=value2` 형식이며 모든 OTLP 요청에 실려 간다. 대소문자를 보존한다: 값들이 collector 자격증명이고, 정규화된 bearer 토큰은 다른 토큰, 즉 틀린 토큰이 되기 때문이다. |
| `SETTINGS_CACHE_TTL_MS` | `5000` | — | settings 행의 인메모리 TTL. 모든 runtime 오버라이드의 인스턴스 간 낡음에 한계를 둔다 — [해석 순서](#해석-순서) 를 보라. 하한이 `1` 이라 `0` 은 캐시를 끄는 대신 기본값으로 떨어진다. |
| `TRACE_RETENTION_DAYS` | `30` | — | 행의 `expiresAt` 에 걸리는 DynamoDB TTL. |
| `USAGE_RETENTION_DAYS` | `400` | — | 대시보드의 184일 질의 창보다 한참 길게 유지한다. 하한은 `31` — 한 달 전체 — 인데, 월간 비용 가드가 그 달의 일별 행들을 합산하기 때문이다. 더 짧은 창은 월말로 갈수록 지출을 조용히 적게 세게 된다. |
| `CHAT_RETENTION_DAYS` | `180` | — | chat 의 마지막 활동 시점부터 잰다. |
| `TRIGGER_RUN_RETENTION_DAYS` | `30` | — | 전달 이력은 운영 로그이지 보관할 기록이 아니다. |
| `A2A_TASK_RETENTION_DAYS` | `1` | — | 일시적인 작업 상태로, `message/send` 이후 `tasks/get`/`tasks/cancel` 이 가능할 만큼만 유지한다. |
| `ARTIFACT_RETENTION_DAYS` | `180` | — | 런이 만들어 낸 것의 이름을 담는 행. 기본값은 `CHAT_RETENTION_DAYS` 에 맞췄다. 그것이 이미 생성된 이미지의 실효 수명이기 때문이다. **`CHAT_RETENTION_DAYS` 이상으로 유지하라**: 더 짧으면 대화에서 아직 보이는 그림이 자기 갤러리에서 먼저 사라진다. 이 창과 버킷의 lifecycle 규칙은 서로 독립된 두 설정이다 — [OPERATIONS.md](OPERATIONS.md#행-보존) 를 보라. |
| `AUDIT_RETENTION_DAYS` | `400` | — | 감사 기록. usage 와 함께 여기서 가장 긴 창이다: 감사 행이 답하는 질문은 그 행위로부터 한참 뒤에 던져지고, 그 행은 런당 하나가 아니라 민감한 행위당 하나다. |

보존 값은 일 단위 정수이고 최소 `1` 이다. 그 밖의 값은 여기 다른 모든 숫자 설정과 마찬가지로
**경고와 함께** 기본값으로 떨어진다 — 운영자가 잘못 넣은 그 값이 바로 행이 얼마나 오래
살아남을지를 정하는 값이라, 조용한 폴백은 최악의 종류다. TTL 은 **프로덕션 테이블의
`expiresAt` 속성에 대해 활성화돼 있어야 한다** — [OPERATIONS.md](OPERATIONS.md#행-보존)
를 보라.

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
| agent 런당 턴 수 (버전 `maxTurn` 기본값) | `50` | `src/application/llm/engine.ts` |
| 멤버 tier 제한 — 멤버당 동시 런 수 / 월 USD 상한 (`admin` —/—, `member` —/`20`, `guest` `1`/`2`. "—" 는 env 제한을 물려받거나 상한이 없다는 뜻). `guest` 는 추가로 프로젝트를 만들 수 없고 프로젝트 API 토큰도 쓸 수 없다 | `TIER_LIMITS` | `src/domain/member/tiers.ts` |
| `dispatch_agents` 호출 하나가 돌릴 수 있는 agent 수 | `4` | `src/application/llm/agentAssembly.ts` |
| 턴당 도구 결과 텍스트 | `200,000` 자 | `src/application/llm/toolResultBudget.ts` |
| subagent 로 넘기는 transfer transcript | `8,000` 자 | `src/application/llm/engine.ts` |
| subagent 중첩 깊이 | `5` | `src/application/execution/subagentRunner.ts` |
| 한 런이 읽을 수 있는 주소 수 (`FetchUrl`) | `20` | `src/application/llm/engine.ts` |
| `FetchUrl` 하나가 끌어올 수 있는 바이트 | `5 MB` | `src/application/llm/urlContent.ts` |
| `FetchUrl` 요청 하나, 모델에 도구 에러가 건네지기 전까지 | `15s` | `src/infrastructure/net/httpResource.ts` |
| 가져온 주소 하나에서 유지하는 텍스트 | `90,000` 자 | `src/application/llm/urlContent.ts` |
| 추출 전에 훑어 읽는 HTML 원문 | `500,000` 자 | `src/infrastructure/llm/htmlText.ts` |
| MCP 도구 결과 하나가 나를 수 있는 파일 | `10.5 MB` × 4 | `src/infrastructure/mcp/toolManager.ts` |
| artifact 행에 남기는 프롬프트 발췌 | `500` 자 | `src/application/artifact/storeArtifact.ts` |
| 카탈로그 검색 하나가 런에 더할 수 있는 capability 수 (skill / 외부 agent / MCP 서버) | `5` / `3` / `3` | `src/application/execution/bindings.ts` |
| 각 MCP 인덱스에 요청하는 카탈로그 매치 수. 그 상한을 넘겨 oversampling 한다 — 여러 도구 행이 한 서버로 합쳐지고, 런이 바인딩할 수 없는 후보가 슬롯을 잡아먹어서는 안 되기 때문이다 | MCP 서버 상한의 `4×`(tool 인덱스) / `3×`(server 인덱스) | `src/application/execution/bindings.ts` |
| 런이 카탈로그를 검색할 때 쓰는 것 (시스템 프롬프트 / 가장 최근 사용자 턴) | `2,000` 자 / `3` 턴 | `src/application/execution/bindings.ts` |
| 메모리 recall (`memoryRecall`): 보내는 질의 / 프롬프트에 유지하는 텍스트 / 첫 토큰이 그것을 기다리는 시간 | `2,000` 자 / `4,000` 자 / `10s` | `src/application/execution/memoryRecall.ts` |
| 인코딩된 대화 id (그것을 넘으면 대화가 없고, API 헤더는 400 으로 답한다) | `512` 자 | `src/domain/execution/actor.ts` 의 `MAX_CONVERSATION_ID_LENGTH` |
| 원격 agent 의 `contextId` 를 우리 쪽 대화 하나에 대해 유지하는 기간 | `7` 일, 사용 시 갱신 | `src/infrastructure/db/ttl.ts` |
| 런당 선언되는 MCP 도구 수 | `120` | `src/domain/llm/toolLimits.ts` |
| MCP 도구 결과 하나 | `100,000` 자 | `src/infrastructure/mcp/toolManager.ts` |
| MCP 서버의 HTTP 응답 | `14.5MB` | `src/infrastructure/mcp/session.ts` |
| MCP 서버 하나에서 읽는 `tools/list` 페이지 수 (상한에 닿으면 그 discovery 는 실패한다 — SDK 는 부분 카탈로그를 남기지 않는다) | `64` | `src/infrastructure/mcp/session.ts` |
| MCP OAuth 메타데이터 / 토큰 응답 | 각 `256KB` | `src/infrastructure/mcp/oauthMetadata.ts`, `oauthClient.ts` |
| MCP discovery 캐시 항목 수 | `200` | `src/infrastructure/mcp/discoveryCache.ts` |
| 원격 agent(A2A / 외부)의 응답 | `2MB` | `src/infrastructure/agent/dispatcher.ts`, `agentClient.ts` |
| MCP 도구 호출 하나, 모델에 타임아웃 에러가 건네지기 전까지 (도구가 정당하게 몇 분씩 걸릴 수도 있다) | `120s` | `src/infrastructure/mcp/session.ts` |
| MCP discovery — 모든 런의 첫 토큰이 지나는 크리티컬 패스 위에 있어서, 빠르게 실패하고 그 서버의 도구만 잃는다. **요청당**: 연결과 `tools/list` 가 각각 이 값을 받는다 (그래서 느린 서버 하나에 최대 ~20초). 캐시로 제공된 세션의 첫 도구 호출에서 일어나는 지연 연결도 이 값을 받는다 | `10s` | `src/infrastructure/mcp/session.ts` |
| 런이 끝날 때 MCP 세션을 해제하기 — 단계별로: 레거시 세션이 보내는 `DELETE`, 그다음 close | 각 `5s` | `src/infrastructure/mcp/session.ts` |
| MCP OAuth well-known 문서 / 토큰 엔드포인트와 RFC 7591 등록 (상수 하나) | `10s` / `15s` | `src/infrastructure/mcp/oauthMetadata.ts`, `oauthClient.ts` |
| OpenAI 형태의 원격 agent 로 가는 transfer | `120s` | `src/infrastructure/agent/dispatcher.ts` |
| A2A 원격 agent 로 가는 transfer. `capabilities.streaming` 을 광고하는 카드에서 이 값은 교환 전체가 아니라 **침묵**에 한계를 둔다 — 타이머는 스트리밍되는 이벤트마다 리셋되고 총량은 런 데드라인이 제한한다. 광고하지 않는 카드에서는 블로킹 `message/send` 에 타이머를 리셋할 이벤트가 없으므로 같은 숫자가 요청 전체의 상한이 된다 | `120s` | `src/infrastructure/a2a/client.ts` |
| 레지스트리가 외부 agent 에 보내는 "test message" — OpenAI 형태다. `a2a` 항목의 테스트는 위의 A2A 클라이언트를 지나 그 `120s` idle 상한 아래 놓이고 뒤에 런 데드라인도 없으므로, 스트리밍 카드는 침묵으로만 제한된다 | `60s` | `src/infrastructure/agent/agentClient.ts` |
| Slack Web API 호출 하나 / Slack 파일 전송 하나 | `30s` / `120s` | `src/infrastructure/slack/client.ts` |
| Telegram Bot API 호출 하나 / Telegram 파일 전송 하나 | `30s` / `120s` | `src/infrastructure/telegram/client.ts` |
| Bot Framework(Teams) 호출 하나 / 첨부 전송 하나 | `30s` / `120s` | `src/infrastructure/teams/client.ts` |
| Bot Framework 서명 키 캐시 / 모르는 `kid` 에 대한 재조회 최소 간격 / 토큰 시각 skew / 앱 토큰 만료 여유 | `24h` / `60s` / `5m` / `60s` | `src/infrastructure/teams/client.ts` |
| GitHub API 요청 하나 (plugins sync) | `15s` | `src/infrastructure/github/client.ts` |
| 모델 응답당 동시 MCP 호출 수 | `5` | `src/application/llm/engine.ts` |
| 인터랙티브(Slack, Telegram, Teams) 런 데드라인 | `3` 분 | `src/shared/runDeadline.ts` |
| 턴당 이미지 수 / 각 바이트 | `4` / `5MB` | `src/domain/llm/imageLimits.ts` |
| 턴당 문서 수 / 각 바이트 | `4` / `10MB` | `src/domain/llm/documentLimits.ts` |
| 유지하는 추출 텍스트, 문서당 / 턴당 | `20,000` / `40,000` 자 | `src/domain/llm/documentLimits.ts` |
| 턴을 나르는 요청 본문 (첨부 상한에서 파생) | ~`80MB` | `src/app/api/_lib/body.ts` |
| Skill 첨부 — 파일당 바이트 / skill 당 파일 수 / skill 당 바이트 (어느 하나라도 넘는 파일은 sync 에서 건너뛰고 이유를 보고한다) | `64KB` / `20` / `200KB` | `src/domain/skill/files.ts` |
| 레지스트리 또는 버전 편집의 요청 본문 (skill 파일 상한에서 파생) | `456KB` | `src/app/api/_lib/body.ts` |
| 턴이 넘칠 때 유지하는 transfer transcript 한 줄 | 최소 `500` 자 | `src/application/llm/engine.ts` |
| 컨텍스트 예산 추정 (ASCII / 그 외 / 이미지 part / 여유분) | 토큰당 `3` 자 / 자당 `1.5` 토큰 / `2,500` 토큰 / `2,000` 토큰 | `src/application/llm/contextBudget.ts` |
| 런의 컨텍스트 예산이 잘라 낼 때 유지하는 도구 결과 | 최소 `500` 자 | `src/application/llm/toolResultBudget.ts` |
| 컨텍스트로 리플레이되는 chat 이력 | `200` 메시지 / `200,000` 자 | `src/application/chat/messageMapping.ts` |
| 컨텍스트로 리플레이되는 chat 도구 트래픽 | `3` 턴 / `20,000` 자 | `src/application/chat/messageMapping.ts` |
| 인바운드 webhook / Slack 이벤트 / Telegram update / Teams activity 본문 | 각 `1MB` | `src/app/api/webhook/[project]/route.ts`, `src/app/api/slack/events/_lib/handleEventRequest.ts`, `src/app/api/telegram/webhook/_lib/handleUpdateRequest.ts`, `src/app/api/teams/messages/_lib/handleActivityRequest.ts` |
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
| Teams 메시지 하나 (Teams 의 28KB 아래에서 Markdown 과 첨부에 여유를 둔 값. 더 긴 답변은 다음 메시지로 이어진다) / inline 그림 (Teams 가 문서화한 상한) | `20,000` 자 / `1MB` | `src/application/teams/replyChannel.ts` |
| Teams 답변 편집 주기 / typing 갱신 | `2s` / `3s` | `src/application/teams/replyChannel.ts` |
| Telegram·Teams 대화의 턴을 유지하는 기간 | `7` 일 | `src/infrastructure/db/ttl.ts` |
| usage 요약 질의 범위 | `184` 일 | `src/app/api/usages/summary/validation.ts` |
| schedule 따라잡기 창 (장애가 한 번에 발화시킬 수 있는 양에 한계를 둔다) | `10` 분 | `src/application/trigger/scanSchedules.ts` |
| scan tick 하나가 동시에 굴리는 schedule 발화 수 | `8` | `src/application/trigger/scanSchedules.ts` |
| schedule 복구 스윕 주기 (잃어버린 런 회수) | `5` 분마다 | `src/application/trigger/scanSchedules.ts` |
| 복구 스윕 하나가 훑는 행 수 | `50` | `src/application/trigger/repairLostRuns.ts` |

### 런 전체의 컨텍스트 예산

위의 항목별 제한들은 그 합에 대해서는 아무 말도 하지 않으므로,
`src/application/llm/contextBudget.ts` 가 한계 하나를 더 소유한다: agent 런의 전체 컨텍스트로,
모델의 `contextWindow` 에서 출력 예약분과 프로토콜 여유분을 뺀 값이다. 예약분은 버전의
`maxTokens` 가 설정돼 있으면 그 값이고, 없으면 그 모델의 레지스트리 최대치다 — `max_tokens` 가
wire 에 실리지 않으면 호출을 처리하는 모델이 자기 최대치까지 생성할 수 있기 때문이다. 폴백이
설정돼 있으면 예산은 **두 용량 중 작은 쪽**이고, 각 용량은 그 모델 *자신의* 창에서 자신의
예약분을 뺀 값이다 — 런 중간에 폴백으로 바뀌어도 그때까지 쌓인 것이 담겨야 하기 때문이다.
"각자 자기 창에서" 가 요점이다: 한 모델의 출력 예약을 다른 모델의 창에서 빼면 아무것도
강제되지 않으면서 예산만 사라진다. 근거는 "각 모델의 입력 + 그 모델의 출력이 그 모델의 창에
들어가야 한다" 하나뿐이다 — "출력 상한이 큰 모델은 창도 크다" 는 더 짧은 설명은 이 레지스트리에서
거짓이다(`minimax-m2.5` 는 204,800 창에 196,608 을 생성하고, `nemotron-3-super-120b` 는
1,000,000 창에 16,384 를 생성한다). **입력과 도구 선언만으로 예산이 이미 0 이 되는 런은 예산 없이
돌고 경고를 하나 남긴다** — 막아야 할 넘침이 이미 요청 안에 들어 있어 자를 것이 없고, 그대로 두면
턴 0부터 모든 도구 호출을 거부하기 때문이다. 입력, 도구
정의, 매 턴의 출력, 도구 결과, 전달받은 답변이 모두 이 예산에서 차감된다 — 절단 표시, 래퍼,
생략 문자열까지 포함해서이며, 표시는 잘라 낸 안쪽에 자리를 예약해 두지 결코 그 위에 덧붙이지
않는다. 더 이상 들어가지 않는 것은 모델이 읽을 수 있는 표시와 함께 잘리고 `warning` chunk 로
한 번 보고된다 — 런 도중에 provider `400` 으로 넘쳐 버리는 대신에 그렇게 한다.

토큰은 문자로부터 보수적으로 추정한다 (부류별로: ASCII 는 토큰당 3자, 그 외는 자당 1.5토큰,
이미지 part 는 일괄 2,500토큰) — 정확한 개수를 세려면 각 provider 의 tokenizer 가 필요하다.
레지스트리에 없는 모델은 **예산을 받지 못한다**: 예산을 도출할 윈도가 없기 때문이고, 그런 런은
예산이라는 것이 존재하기 전의 모든 런이 그랬듯 예산 없이 남는다 — `maxTokens` 가 윈도에 용량을
전혀 남기지 않는 버전도 마찬가지다. 0 예산은 런이 채워 보지도 못한 예산을 탓하면서 모든 도구
호출을 거부하게 되기 때문이다. 단발성(`llm`) 런도 예산이 없다 — 한 번의 호출에서는 아무것도
누적되지 않고, 입력은 호출자 자신의 것이다.

# 설치

Agent Studio 는 기업이 **자기 네트워크 안에 설치해 운영하는** 플랫폼이다. 그 정체성과 그것이
아키텍처에 강제하는 것은 [ARCHITECTURE.md](ARCHITECTURE.md#무엇을-위한-시스템인가) 가 소유한다.
이 문서는 그 설치의 전 과정을 다룬다. 무엇이 필요한지, 어떻게 올리는지, 폐쇄망에서는 무엇을 대신
하는지, 그리고 기존 AWS 배포에서 어떻게 옮겨 오는지. 설정값 하나하나의 뜻은
[CONFIGURATION.md](CONFIGURATION.md), 운영은 [OPERATIONS.md](OPERATIONS.md) 가 답한다.

## 필요한 것

| | 필수 | 대안 |
|---|---|---|
| **PostgreSQL 16+ with pgvector** | 모든 행이 여기 있다. 스키마는 앱이 부팅 때 만든다 | 번들(compose · Helm) 또는 조직의 DB. `pgvector` 확장이 만들어질 수 있어야 한다(`pgvector/pgvector` 이미지, RDS·Supabase·Neon 은 기본 지원). `vector` 는 trusted 확장이 아니라 생성에 superuser 가 필요하다. 조직의 DB 라면 DBA 가 `CREATE EXTENSION vector` 를 미리 해 두면 앱 역할은 일반 권한으로 충분하다 |
| **OpenAI 호환 LLM 엔드포인트** | 런이 말을 거는 곳 | vLLM · LM Studio · Ollama · 사내 라우터 · 외부 API. 폐쇄망은 `selfhosted` 채널(모델은 `/models` 콘솔에서 선언) |
| S3 호환 오브젝트 스토어 | 런이 만든 이미지·문서. 없으면 artifact 기능만 꺼진다 | 번들 MinIO · Garage · Ceph RGW · S3. `ARTIFACT_ACCESS_MODE=proxied` 면 앱만 닿으면 된다 |
| 신원 제공자 | 로그인 | 표준 OIDC(Keycloak · Entra ID · Okta · Authentik …), Google, 또는 비밀번호(첫 관리자·비상용) |
| 컨테이너 런타임 | 앱 이미지 `ghcr.io/opspresso/agent-studio`(릴리즈마다 ECR 과 함께 발행; GHCR 패키지가 private 인 동안은 `docker login ghcr.io` 가 필요하다) | Docker Compose(호스트 하나) 또는 Kubernetes(Helm 차트) |

설치형 최소 구성은 **Postgres 하나**다. 나머지는 켜는 만큼 붙는다.

## 호스트 하나에 설치 (Docker Compose)

`deploy/idc/` 가 그 구성이다. Caddy(TLS) + 앱 + Postgres + MinIO + 레지스트리가 이름 붙인 MCP
서버들 + 티커로 이뤄진다. 호스트 한 대(4 vCPU / 8GB 권장, 4GB 는 동작하지만 빌드는 못 한다)에:

```bash
# 호스트에 Docker Engine/Compose 와 jq·python3 를 먼저 놓는다 (ECR·SSM 을 쓰면 AWS CLI 도).
# opspresso 의 호스트는 deploy/idc/README.md 의 한 줄 부트스트랩을 쓴다.

# 저장소의 deploy/idc 를 /opt/compose/apps/agent-studio 로 복사한 뒤
cd /opt/compose/apps/agent-studio
cp .env.secrets.example .env.secrets && chmod 600 .env.secrets
# AES_ENCRYPTION_KEY, BETTER_AUTH_SECRET, LLM_API_KEY, BOOTSTRAP_ADMIN_PASSWORD 또는 OIDC 클라이언트를 채운다
vi .env.secrets
# 도메인·관리자·LLM 주소·로그인 방식을 맞춘다
vi .env.example
vi Caddyfile        # 호스트명; ACME 가 닿지 않으면 조직 인증서를 지정한다

scripts/deploy.sh
```

`deploy.sh` 는 `.env.example` 에서 `.env` 를 생성한다. `.env` 는 직접 고치지 마라. 다음 실행이 덮어쓴다.
첫 실행에는 **`.env.host`** 를 만드는데, 이 호스트의 Postgres·MinIO 자격 증명이고 다시 생성되지 않는다.
잃어버리면 데이터에 접근할 수 없으니 백업에 포함한다(`scripts/backup.sh` 가 같이 복사한다).

확인:

```bash
curl -fsS https://<host>/api/health      # {"status":"ok"}
docker compose ps                         # app healthy, postgres healthy, minio healthy
```

첫 로그인은 `BOOTSTRAP_ADMIN_EMAIL` + `BOOTSTRAP_ADMIN_PASSWORD` 로 한다(`AUTH_PASSWORD=true`,
그 이메일은 `ADMIN_EMAILS` 에도). OIDC 를 붙이면 비밀번호 로그인은 비상용으로 남겨 두거나
`AUTH_PASSWORD` 를 끈다.

백업은 `scripts/backup.sh [DEST]` 로 한다. `pg_dump` + 오브젝트 미러 + `.env.host` 를 담는다. 복원
절차는 스크립트 머리에 있다.

## Kubernetes 에 설치 (Helm)

`deploy/helm/agent-studio` 는 앱 + 티커 CronJob 에 선택적 번들 Postgres(StatefulSet + PVC) 와
MinIO 를 더한 차트다.

```bash
helm upgrade --install agent-studio deploy/helm/agent-studio \
  --namespace agent-studio --create-namespace \
  --set config.PUBLIC_BASE_URL=https://studio.example.com \
  --set config.ADMIN_EMAILS=admin@example.com \
  --set config.LLM_BASE_URL=http://vllm.ml.svc:8000/v1 \
  --set config.BOOTSTRAP_ADMIN_EMAIL=admin@example.com \
  --set secrets.AES_ENCRYPTION_KEY="$(openssl rand -base64 32)" \
  --set secrets.BETTER_AUTH_SECRET="$(openssl rand -base64 32)" \
  --set secrets.SCHEDULE_SCAN_TOKEN="$(openssl rand -hex 32)" \
  --set postgres.password="$(openssl rand -hex 24)" \
  --set minio.rootPassword="$(openssl rand -hex 24)" \
  --set secrets.BOOTSTRAP_ADMIN_PASSWORD='…' \
  --set secrets.LLM_API_KEY='…' \
  --set ingress.enabled=true --set ingress.host=studio.example.com
```

- 조직의 Postgres 를 쓰려면 `postgres.enabled=false` + `secrets.DATABASE_URL`. 기존 S3 호환
  스토어는 `minio.enabled=false` + `config.extra.S3_ENDPOINT` + `secrets.S3_ACCESS_KEY_ID/S3_SECRET_ACCESS_KEY`
  를 쓴다. 오브젝트 스토어의 키는 `AWS_*` 가 아니라 `S3_*` 다. `AWS_*` 는 Bedrock 같은 다른 AWS
  클라이언트의 몫이다.
- 시크릿을 직접 만들어 두었다면 `secrets.existingSecret=<name>` (같은 키 이름으로).
- 번들 Postgres·MinIO 의 비밀번호(`postgres.password`, `minio.rootPassword`)는 **설치자가 한 번 정해 값
  파일에 둔다**. 차트가 생성하지 않는데, GitOps 렌더마다 값이 달라지면 DB 에서 잠기기 때문이다. initdb 가
  볼륨에 써 넣으므로 이후 바꾸지 않는다. 앱은 `ARTIFACT_ACCESS_MODE=proxied` 로 오브젝트를 직접 서빙하므로
  MinIO 는 클러스터 밖으로 나가지 않는다.
- 레플리카는 늘려도 된다. 런 상태는 전부 DB 에 있다. 단 managed MCP(`MANAGED_MCP_RUNTIME=docker`)는
  여기서도 compose 에서도 **그대로는 동작하지 않는다**. 앱 이미지에 `docker` CLI 가 없고, 앱이 호스트
  네트워크·Docker 소켓에 닿지 않기 때문이다. 켜려면 CLI 를 넣은 이미지와 소켓 마운트, 호스트 loopback 에
  닿는 네트워크가 필요하다. 기본은 꺼짐이며, 켠 채로 조건이 빠지면 항목마다 `spawn docker ENOENT` 가 난다.

## 폐쇄망(air-gapped)에서

부팅·로그인·런·콘솔은 아웃바운드 0 으로 동작한다. 밖을 보는 기능은 각각 대체 경로가 있다.

| 기능 | 기본(온라인) | 폐쇄망에서 |
|---|---|---|
| 모델 카탈로그 | `MODELS_CATALOG_URL` 에서 매시간 | `MODELS_CATALOG_URL=none`. 관리자가 `/models` 에서 카탈로그 JSON 을 업로드한다(`PUT /api/models/catalog/document`). 업로드한 문서는 네트워크보다 우선한다. 실제 서빙 모델은 `selfhosted` 채널에 선언한다 |
| 스킬·MCP 레지스트리(agent-plugins) | GitHub API 로 sync | `/plugins` 에서 체크아웃의 `.tar.gz` 를 업로드한다(`POST /api/plugins/sync/upload`). 같은 sync 에 입력만 다르다. GitHub Enterprise 는 `GITHUB_API_URL` |
| 컨테이너 이미지 | ghcr.io / ECR | 사내 레지스트리로 미러하고 `IMAGE_REGISTRY`(compose) 또는 `image.repository`(Helm) 를 가리킨다. 필요한 이미지: `agent-studio`, `pgvector/pgvector:pg17`, `minio/minio`, `minio/mc`, `caddy`, `curlimages/curl`, 쓰는 MCP 서버들 |
| 모델이 읽는 URL(`FetchUrl`) | 공인 주소만 | `URL_FETCH_INTERNAL_HOST_SUFFIXES` 에 사내 도메인 접미사를 선언한다. MCP 서버 주소는 별개 목록 `MCP_INTERNAL_HOST_SUFFIXES` |
| 임베딩(케이퍼빌리티 카탈로그) | Cohere/Bedrock/OpenAI | `EMBEDDING_PROVIDER=openai` 로 사내 OpenAI 호환 임베딩 엔드포인트(vLLM·TEI·Ollama). `CATALOG_MIN_SCORE` 를 다시 잰다. 필요 없으면 `CATALOG_ENABLED` 를 끈다 |
| Slack · Teams · Telegram · Bedrock · A2A 외부 에이전트 | 설정 시 동작 | 본질이 외부 SaaS 다. 설정하지 않으면 메뉴가 숨고 부팅에 영향이 없다 |
| 메모리(mcp-memory) | 이 호스트의 PostgreSQL(`mcp_memory` 데이터베이스) | 저장은 폐쇄망에서 그대로 돈다. 남는 외부 의존은 **임베더**다. 기본은 Bedrock Titan 이고, 사내 OpenAI 호환 엔드포인트를 쓰려면 `EMBEDDING_PROVIDER=openai` 로 바꾼 뒤 **다시 임베딩한다**(pgvector 는 서로 다른 모델의 벡터를 비교하지 않는다). `search_docs` 의 Bedrock Knowledge Base 는 그대로 선택이다 |

이미지 **빌드**는 npm 레지스트리와 Google Fonts(`next/font/google`, 빌드 시 1회)가 필요하다. 빌드는
밖에서 하고 이미지를 들여온다.

## 기존 AWS 배포에서 옮겨 오기

v0.86 이전 배포는 DynamoDB + S3 + S3 Vectors 를 썼다. 순서:

1. 새 호스트에 위 절차로 설치하되 **`AES_ENCRYPTION_KEY` 와 `BETTER_AUTH_SECRET` 은 옛 값 그대로**
   쓴다. 저장된 시크릿이 그 키로 암호화돼 있다.
2. 테이블을 내보낸다(AWS CLI, SDK 불필요):
   ```bash
   aws dynamodb scan --table-name agent-studio --output json --max-items 1000000 > export.json
   ```
3. 새 DB 에 들여온다. `AUTH#` 행은 Better Auth 테이블로, 나머지는 같은 키·같은 문서로 들어간다:
   ```bash
   DATABASE_URL=postgres://… pnpm tsx scripts/import-dynamodb-export.ts export.json
   ```
   개발 머신에서 ssh 터널(`ssh -L 15432:127.0.0.1:5432 <host>`, compose 라면 postgres 포트를 잠시
   127.0.0.1 에 공개)로 실행하면 된다. 멱등이라 다시 돌려도 된다. 1단계의 첫 부팅이 만든
   부트스트랩 관리자가 내보낸 사용자와 같은 이메일이면 그 행은 내보낸 행으로 대체되고
   (스크립트가 한 줄 남긴다), 다음 부팅이 비밀번호를 다시 붙인다. managed MCP 항목의
   `envRefs` 는 옛 배포의 SSM 파라미터 이름이라 버려진다(한 줄씩 남긴다). 호스트의 env 파일
   경로로 다시 넣는다.
   런타임 설정의 `artifactAccessMode` 도 버려진다. 그것은 *옛* 오브젝트 스토어를 두고 한 답이라
   (`public` 은 브라우저를 버킷으로 직접 보낸다) 앱만 닿는 MinIO 위에서는 링크가 죽는다. 새
   배포의 `ARTIFACT_ACCESS_MODE` 가 정하고, 관리자가 `/settings` 에서 다시 고를 수 있다.
4. 오브젝트를 옮긴다: `scripts/migrate-objects.sh s3://<bucket>` (`aws s3 sync` → `mc mirror`).
5. 케이퍼빌리티 카탈로그는 옮기지 않는다. `POST /api/catalog/reindex` 한 번이면 다시 만들어진다.
6. 세션은 그대로 유효하다(같은 `BETTER_AUTH_SECRET`, 같은 session 행). OAuth 콜백 URL 을 새 호스트로
   다시 등록한다.

## 업그레이드

- Compose: `.env.example` 의 태그를 올리고(또는 GitHub 이 닿는 호스트는 `deploy.sh` 가 argocd-env-demo 의
  alpha 핀을 따른다) `scripts/deploy.sh` 를 돌린다. 스키마 마이그레이션은 앱이 부팅 때 advisory lock
  아래에서 적용하므로 인스턴스가 여럿이어도 한 번만 실행된다.
- Helm: `helm upgrade`. 같은 이유로 별도 마이그레이션 잡이 없다.
- 되돌리기는 이미지 태그를 내리는 것이지 스키마를 내리는 것이 아니다. 마이그레이션은 추가만 하므로
  이전 버전도 새 스키마 위에서 돈다.

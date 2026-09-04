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
- S3 호환 object store는 선택이다. 없으면 artifact 영속화만 꺼진다.
- production에서는 `STAGE`, `ADMIN_EMAILS`, 로그인 방식 하나가 추가로 필요하다.

전체 환경변수와 고정 한계는 [CONFIGURATION.md](CONFIGURATION.md), 운영 계약은
[OPERATIONS.md](OPERATIONS.md)를 보라.

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

버전 tag는 release workflow가 `linux/amd64` 이미지를 ECR과 GHCR에 발행한다.

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

## 데이터 이관

v0.86 이전 DynamoDB 배포는 `scripts/import-dynamodb-export.ts`로 PostgreSQL에 이관한다.
`AES_ENCRYPTION_KEY`와 `BETTER_AUTH_SECRET`은 기존 값을 유지해야 저장된 credential과 session을
계속 읽을 수 있다. Object는 배포 저장소가 소유하는 migration 절차로 대상 S3-compatible store에
옮긴다. Capability catalog는 복사하지 않고 `/api/catalog/reindex`로 다시 만든다.

이관기는 새 배포에서 그대로 쓰면 위험한 두 설정을 의도적으로 제거한다. managed MCP 의 옛
`envRefs` 는 SSM parameter 이름이어서 현재 호스트의 env-file 경로로 사용할 수 없고,
`artifactAccessMode` 는 이전 object store 의 도달성에 대한 답이므로 새 환경에서 다시 정해야 한다.
같은 이메일로 새 DB에 먼저 만들어진 사용자가 있으면 export 의 원래 사용자 id 와 참조를 보존하기
위해 그 행을 교체한다. 실행 결과가 제거·교체 건수를 출력하므로 이관 뒤 반드시 확인하라.

## 업그레이드

새 image tag로 교체하면 앱이 부팅 시 advisory lock 아래에서 schema migration을 적용한다. 별도
migration job은 필요하지 않다. Rollback은 image tag를 되돌리는 것이며 schema를 내리지 않는다.
IDC와 EKS의 구체적인 upgrade 및 rollback 명령은 각 배포 저장소가 소유한다.

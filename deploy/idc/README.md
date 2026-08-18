# IDC 배포 (alpha)

단일 물리 호스트 위의 Docker Compose 배포. 앱 하나와 MCP 서버들이 한 네트워크에
들어가고, Caddy 가 TLS 를 끊는다.

**이것은 두 번째 *배포*가 아니라 배포된 시스템의 두 번째 *인스턴스*다.** EKS 파드가 읽는
DynamoDB 테이블, S3 버킷, S3 Vectors 인덱스를 그대로 읽는다. 다른 것은 자격증명을 얻는
방법(pod identity 대신 IAM 사용자 액세스 키)과 바깥을 향하는 주소뿐이다. 무엇이 공유되고
무엇이 공유되지 않는지는 아래 [두 인스턴스](#두-인스턴스)에 있다.

| | |
|---|---|
| 호스트 | `ubuntu@115.68.216.99` — Ubuntu 24.04, 4 vCPU, 3.8GB RAM |
| 주소 | `https://alpha.agentdure.com` |
| 설치 경로 | `/opt/agentdure` (관례일 뿐, compose 는 어디서든 돈다) |

## 사전 준비

### 1. IAM 사용자

pod identity 가 없으므로 액세스 키 한 벌이 그 자리를 대신한다. **`pod-role--agentdure`
역할 자체는 붙일 수 없지만** — 그것은 EKS pod identity 전용이다 — 거기 붙어 있는 관리형
정책은 역할과 무관하게 재사용된다. `terraform-env-demo/demo/8-role/20-main.tf` 가
`policies/*.json` 하나당 `aws_iam_policy` 를 만들기 때문이다.

| 정책 | 출처 | 무엇을 여는가 |
|---|---|---|
| `pod-role--agentdure` | 기존 (terraform) | 앱: DynamoDB `agentdure`, S3 `agentdure-static`, S3 Vectors `capabilities`, Bedrock 임베딩, `bedrock-mantle` 채팅 |
| `pod-role--mcp-memory` | 기존 (terraform) | mcp-memory: S3 Vectors `memories`, S3 `agent-studio-memory`, Titan |
| `pod-role--mcp-cloudwatch` | 기존 (terraform) | mcp-cloudwatch: CloudWatch·Logs 읽기 (`ap-northeast-2` 한정) |
| `agentdure-idc-ecr-pull` | **신규** — `iam/ecr-pull.json` | 프라이빗 이미지 4종 pull |
| `agentdure-idc-ssm-read` | **신규, 선택** — `iam/ssm-read.json` | 호스트에서 `fetch-env.sh` 를 돌릴 때만 |

```bash
export AWS_PROFILE=opspresso AWS_REGION=ap-northeast-2
ACCOUNT=396608815058

aws iam create-user --user-name agentdure

for p in pod-role--agentdure pod-role--mcp-memory pod-role--mcp-cloudwatch; do
  aws iam attach-user-policy --user-name agentdure \
    --policy-arn "arn:aws:iam::$ACCOUNT:policy/$p"
done

aws iam create-policy --policy-name agentdure-idc-ecr-pull \
  --policy-document file://deploy/idc/iam/ecr-pull.json
aws iam attach-user-policy --user-name agentdure \
  --policy-arn "arn:aws:iam::$ACCOUNT:policy/agentdure-idc-ecr-pull"

aws iam create-access-key --user-name agentdure   # → .env.aws
```

세 관리형 정책은 terraform 이 소유한다. `policies/agentdure.json` 을 고치면 **EKS 역할과
이 사용자 양쪽에** 반영된다 — 단일 소스라는 장점이자, 여기만 넓히려고 그 파일을 고치면
안 되는 이유다.

`agentdure-idc-ssm-read` 는 편의 항목이다. 붙이지 않으면 `fetch-env.sh` 를 SSO 자격증명이
있는 로컬에서 돌리고 결과 두 파일을 호스트로 복사한다. 붙이면 호스트가 스스로 시크릿을
갱신할 수 있는 대신, 유출된 액세스 키가 SSM 의 그 경로까지 열게 된다.

### 2. DNS 와 Google OAuth

- Route53 `agentdure.com` 에 `alpha` A 레코드 → `115.68.216.99`
- Google OAuth 클라이언트의 승인된 리디렉션 URI 에
  `https://alpha.agentdure.com/api/auth/callback/google` 추가.
  **클러스터가 쓰는 클라이언트와 같은 것을 쓴다** — 클라이언트 id/secret 이 SSM 에서 오고,
  그것이 곧 테이블의 사용자 행과 짝이 되기 때문이다.

### 3. 호스트

RAM 3.8GB 에 앱과 MCP 서버들이 함께 올라간다. **스왑을 먼저 잡아라.**

```bash
sudo fallocate -l 4G /swapfile && sudo chmod 600 /swapfile
sudo mkswap /swapfile && sudo swapon /swapfile
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
```

## 설치

```bash
# 호스트에서
sudo mkdir -p /opt/agentdure && sudo chown ubuntu:ubuntu /opt/agentdure
# deploy/idc/ 의 내용을 /opt/agentdure 로 복사한 뒤
cd /opt/agentdure
cp .env.example .env
cp .env.aws.example .env.aws      # 액세스 키를 채운다
cp .env.mcp.example .env.mcp      # eks 프로파일을 쓸 때만 채우면 된다

scripts/fetch-env.sh              # .env.secrets, .env.mcp.secrets 생성
scripts/ecr-login.sh
docker compose up -d
```

`docker compose ps` 로 여섯 서비스(caddy, app, mcp-memory, mcp-document, mcp-youtube,
mcp-brave-search, mcp-cloudwatch)가 뜬 것을 확인하고, 첫 인증서가 발급될 때까지 잠깐
기다린 뒤 `https://alpha.agentdure.com` 을 연다.

검증할 것 두 가지:

```bash
curl -s https://alpha.agentdure.com/api/health          # 200
docker compose exec app wget -qO- \
  http://mcp-document.agent-mcps.svc.cluster.local/health   # MCP 도달성
```

두 번째가 이 배포의 핵심 트릭이다. MCP 컨테이너는 **클러스터 DNS 이름을 네트워크 alias 로**
달고 **80 을 리슨한다**. 그래서 `agent-plugins` 의 `mcp.json`(`http://mcp-<name>.agent-mcps.
svc.cluster.local/mcp`)이 여기서도 그대로 해석된다 — 레지스트리 행은 두 인스턴스가 공유하는
같은 행이므로, 그것을 고치는 선택지는 애초에 없다. 앱이 그 사설 주소에 닿는 것은
`MCP_INTERNAL_HOST_SUFFIXES` 가 SSRF 가드에 그 suffix 를 선언하기 때문이고, mcp-grafana 와
mcp-cloudwatch 가 받아 주는 것은 그 이름이 이미 각자의 Host 화이트리스트에 **포트 없이**
들어 있기 때문이다.

## 두 인스턴스

| | IDC 와 EKS 가 공유하는가 |
|---|---|
| DynamoDB `agentdure` — 프로젝트·버전·chat·usage·트레이스·레지스트리·세션 | **예.** 한쪽에서 만든 프로젝트가 다른 쪽에 그대로 보인다 |
| S3 `agentdure-static`, S3 Vectors `capabilities`, mcp-memory 의 두 버킷 | **예** |
| `/settings` 런타임 오버라이드 (admin 목록, LLM 채널, A2A 키…) | **예.** 한쪽의 편집이 `SETTINGS_CACHE_TTL_MS`(5초) 뒤 다른 쪽에도 적용된다 |
| 런 동시성 슬롯, 트리거 claim, plugins sync 리스 | **예.** 테이블 행이라 두 인스턴스 합산으로 정확하고, 중복 발화가 생기지 않는다 |
| `PUBLIC_BASE_URL` | 아니오 — 여기는 `alpha.agentdure.com` |
| Slack·Telegram·Teams 이벤트 | 실질적으로 아니오. 등록된 webhook URL 하나가 받는다(지금은 클러스터) |
| MCP OAuth connection | 주의. `client_id` 가 `PUBLIC_BASE_URL` 기반 문서 URL 이라, 여기서 새로 연결하면 project 의 저장된 connection 을 덮어쓴다 |
| 티커 3종 | 아니오. 클러스터의 CronJob 이 돌고 있으므로 `ticker` 프로파일은 꺼 둔다 |
| 메트릭 카운터 | 아니오 — 프로세스 단위다 |

**`AES_ENCRYPTION_KEY` 는 반드시 클러스터와 같은 값이어야 한다.** 공유 테이블의 암호화된
자격증명을 푸는 키다. 다른 값이면 부팅은 성공하고, 저장된 모든 시크릿에서 실패한다.

## 운영

**업데이트** — 이 호스트는 릴리스 자동화 밖에 있다. 태그 push 는 `repository_dispatch` 로
`argocd-env-demo` 의 alpha phase 이미지 태그를 올리고, 그것은 클러스터로 간다.

```bash
scripts/ecr-login.sh              # 12시간이면 만료된다
# .env 의 AGENTDURE_TAG 를 새 버전으로 바꾼 뒤
docker compose up -d app
```

호스트에서 이미지를 빌드하지 마라. RAM 3.8GB 에서 `next build` 는 OOM 으로 끝난다.

**드레이닝** — `stop_grace_period: 660s` 는 `MAX_RUN_DURATION_MS`(10분)에 맞춘 값이다.
앱은 `SIGTERM` 을 드레이닝으로 바꿀 뿐 `process.exit` 를 부르지 않으므로, 이 유예가 진행 중인
SSE 스트림이 빠져나갈 시간 전부다. 짧게 줄이면 끝났을 스트림이 잘린다.

**티커** — 클러스터가 세 엔드포인트를 모두 틱하고 있고, 이 호스트도 같은 테이블을 본다.
이 호스트가 티커를 맡게 되면 `docker compose --profile ticker up -d`. 중복 틱은 안전하지만
공짜가 아니다 — 카탈로그 재색인은 레지스트리 전체를 다시 임베딩한다.

**로그** — `docker compose logs -f app`. 컨테이너당 10MB × 3 으로 회전한다.

## 아직 못 하는 것

`eks` 프로파일의 세 서버(mcp-argocd, mcp-grafana, mcp-kubernetes)는 클러스터 *안에서*
자기 대상에 닿던 것들이다. 여기서는 각각 바깥에서 해석되는 주소와 그에 맞는 자격증명이
필요하다:

- **mcp-argocd / mcp-grafana** — `ARGOCD_BASE_URL`, `GRAFANA_URL` 에 넣을 공개 주소가 정해져야
  한다. 토큰과 계정은 SSM 에 이미 있다.
- **mcp-kubernetes** — in-cluster 서비스 계정이 없으므로 kubeconfig 를 마운트해야 하고, 그
  자격증명은 EKS access entry 에 따로 등록되어야 한다. 차트가 RBAC 로 주던 읽기 권한을 그
  주체에 다시 부여하는 일이다.

셋 다 채워지기 전에는 `docker compose --profile eks up -d` 를 쓰지 마라. 컨테이너는 뜨고
도구 호출만 실패한다.

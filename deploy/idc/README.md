# alpha 인스턴스 — IDC 호스트

단일 물리 호스트 위의 Docker Compose 배포. 앱 하나와 MCP 서버들이 한 네트워크에 들어가고,
Caddy 가 TLS 를 끊는다.

**이것은 alpha 환경이다.** 클러스터(prod)와 코드는 같고 데이터는 다르다 — 이 호스트는
`agent-studio` 로 시작하는 테이블과 버킷을 읽는다. 두 환경이 무엇을 나누고 무엇을 나누지
않는지는 [docs/OPERATIONS.md](../../docs/OPERATIONS.md#두-환경--alpha-와-prod) 에 있다.

| | |
|---|---|
| 호스트 | `ubuntu@115.68.216.99` — Ubuntu 24.04, 4 vCPU, 3.8GB RAM |
| 주소 | `https://agentdure.com` (`alpha.agentdure.com` 은 기존 webhook 호환 alias) |
| 설치 경로 | `/opt/agentdure` (관례일 뿐, compose 는 어디서든 돈다) |

## 사전 준비

### 1. 액세스 키

pod identity 가 없으므로 액세스 키 한 벌이 그 자리를 대신한다. **IAM 사용자 `agentdure` 와
그 정책들은 terraform 이 만든다** — `terraform-env-demo/demo/9-agentdure`.
`agentdure.com` A 레코드는 이 호스트의 공인 IP를 가리켜야 한다. 사람이 하는 것은 키 발급
하나뿐이다:

```bash
AWS_PROFILE=opspresso aws iam create-access-key --user-name agentdure   # → .env.aws
```

키를 terraform 이 만들지 않는 이유는 비밀키가 state 에 평문으로 남기 때문이다. 회전도 같은
명령으로 사람이 한다.

그 사용자에 붙어 있는 것은 앱·mcp-memory·mcp-cloudwatch 의 `pod-role--*` 정책 셋과, 이 호스트
자신의 것 둘 — ECR pull 과 SSM 읽기다. **`pod-role--*` 를 넓히려면 그 `policies/*.json` 을
고쳐야 하고, 그러면 클러스터의 역할도 같이 넓어진다** — 단일 소스의 값이자 대가다.

SSM 읽기(`agentdure-idc-ssm-read`)는 호스트가 스스로 시크릿을 갱신하게 해 준다. 대가는
분명하다 — **이 액세스 키가 유출되면 배포 시크릿 전부가 함께 열린다.** 경로를
`/k8s/common/agentdure/*` 와 `/k8s/common/mcp-*` 로 좁혀 둔 것이 그 폭을 줄이는 수단이다.

### 2. Google OAuth

Google OAuth 클라이언트의 승인된 리디렉션 URI 에
`https://agentdure.com/api/auth/callback/google` 을 추가한다. **클러스터와 같은
클라이언트를 쓴다** — client id/secret 이 SSM 에서 오기 때문이다.

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
cp .env.aws.example .env.aws      # 액세스 키를 채운다 — 사람이 만드는 파일은 이것 하나다

scripts/deploy.sh                 # .env·.env.mcp 생성 + 이미지 pull + 기동
```

`.env` 와 `.env.mcp` 는 손으로 만들지 않는다. `deploy.sh` 가 세 곳에서 모아 매번 통째로
다시 쓴다 — 설정은 저장소의 `.env.example`/`.env.mcp.example`, 이미지 버전은
`argocd-env-demo` 의 차트별 `versions-alpha.json`(클러스터 alpha 가 도는 버전 그대로),
시크릿은 SSM. 그러니 설정을 바꾸려면 example 을 고쳐 커밋하고 다시 돌린다; `.env` 에 직접
쓴 값은 다음 실행에서 사라진다. 스크립트가 호스트에 기대는 것은 `docker compose`, `aws`,
`curl`, `python3`(Ubuntu 기본) 넷이고, `.env.aws` 의 키로 SSM 을 읽고 ECR 에 로그인한다.

`docker compose ps` 로 여섯 서비스(caddy, app, mcp-memory, mcp-document, mcp-youtube,
mcp-brave-search, mcp-cloudwatch)가 뜬 것을 확인하고, 첫 인증서가 발급될 때까지 잠깐 기다린 뒤
`https://agentdure.com` 을 연다.

검증할 것 두 가지:

```bash
curl -s https://agentdure.com/api/health          # 200
docker compose exec app wget -qO- \
  http://mcp-document.agent-mcps.svc.cluster.local/health   # MCP 도달성
```

두 번째가 이 배포의 핵심 트릭이다. MCP 컨테이너는 **클러스터 DNS 이름을 네트워크 alias 로**
달고 **80 을 리슨한다**. 그래서 `agent-plugins` 의 `mcp.json`(`http://mcp-<name>.agent-mcps.
svc.cluster.local/mcp`)이 여기서도 그대로 해석된다 — 레지스트리는 두 환경이 공유하는 SSOT
하나이므로, 그것을 고치는 선택지는 애초에 없다. 앱이 그 사설 주소에 닿는 것은
`MCP_INTERNAL_HOST_SUFFIXES` 가 SSRF 가드에 그 suffix 를 선언하기 때문이고, mcp-grafana 와
mcp-cloudwatch 가 받아 주는 것은 그 이름이 이미 각자의 Host 화이트리스트에 **포트 없이**
들어 있기 때문이다.

## 운영

**업데이트** — 이 호스트는 릴리스 자동화 밖에 있다. 태그 push 는 `repository_dispatch` 로
`argocd-env-demo` 의 이미지 태그를 올리고, 그것은 클러스터로 간다. 여기서 그 자리를 대신하는
것이 `deploy.sh` 이고, 그것이 업데이트 절차 전부다:

```bash
scripts/deploy.sh                 # 설정(example) + 버전(argocd-env-demo) + 시크릿(SSM) → compose up
```

이미지 아홉 개 전부 — 우리가 만드는 넷(`agentdure`, `mcp-memory`, `mcp-document`,
`mcp-youtube`)과 남의 레지스트리에서 오는 다섯 — `argocd-env-demo/charts/<chart>/versions-alpha.json`
의 최신 항목을 따른다. 버전을 고르는 곳은 클러스터 하나뿐이고, 이 호스트는 그것을 읽을 뿐이다.
GitHub 을 못 읽은 차트는 지금 `.env` 에 있는 버전을 유지한다(그것도 없으면 example 의 값).
바뀐 것이 없는 실행은 아무것도 재생성하지 않으므로 타이머에 걸어 두어도 된다 — ECR 로그인도
이 스크립트 안에 있으니 따로 cron 을 둘 필요가 없다:

```
*/10 * * * * /opt/agentdure/scripts/deploy.sh >> /var/log/agentdure-deploy.log 2>&1
```

호스트에서 이미지를 빌드하지 마라. RAM 3.8GB 에서 `next build` 는 OOM 으로 끝난다.

**드레이닝** — `stop_grace_period: 660s` 는 `MAX_RUN_DURATION_MS`(10분)에 맞춘 값이다. 앱은
`SIGTERM` 을 드레이닝으로 바꿀 뿐 `process.exit` 를 부르지 않으므로, 이 유예가 진행 중인 SSE
스트림이 빠져나갈 시간 전부다. 짧게 줄이면 끝났을 스트림이 잘린다.

**티커** — `ticker` 프로파일이 **켜져 있다**. compose 파일의 기본값은 꺼짐이지만
`.env.example` 의 `COMPOSE_PROFILES=ticker` 가 켠다: 클러스터가 사라진 지금 alpha 를 틱하는
것은 이것뿐이고, 켜지 않으면 schedule 이 발화하지 않고 카탈로그가 재색인되지 않는다. 사람이
`/plugins` 를 누를 때만 재색인이 도는 상태에서는 그 한 번이 무거워 헬스체크까지 흔들었다.

**로그** — `docker compose logs -f app`. 컨테이너당 10MB × 3 으로 회전한다.

## 아직 못 하는 것

`eks` 프로파일의 세 서버(mcp-argocd, mcp-grafana, mcp-kubernetes)는 클러스터 *안에서* 자기
대상에 닿던 것들이다. 여기서는 각각 바깥에서 해석되는 주소와 그에 맞는 자격증명이 필요하다:

- **mcp-argocd / mcp-grafana** — `ARGOCD_BASE_URL`, `GRAFANA_URL` 에 넣을 공개 주소가 정해져야
  한다. 토큰과 계정은 SSM 에 이미 있다.
- **mcp-kubernetes** — in-cluster 서비스 계정이 없으므로 kubeconfig 를 마운트해야 하고, 그
  자격증명은 EKS access entry 에 따로 등록되어야 한다. 차트가 RBAC 로 주던 읽기 권한을 그
  주체에 다시 부여하는 일이다.

셋 다 채워지기 전에는 `COMPOSE_PROFILES` 에 `eks` 를 넣지 마라. 컨테이너는 뜨고 도구
호출만 실패한다.

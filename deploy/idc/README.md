# 호스트 하나에 설치 — IDC

단일 물리 호스트 위의 Docker Compose 배포. 앱, PostgreSQL(pgvector), MinIO, MCP 서버들이 한
네트워크에 들어가고, Caddy 가 TLS 를 끊는다. **설치형 배포의 기본 모양**이고, 설치 전 과정은
[docs/INSTALL.md](../../docs/INSTALL.md) 가 답한다. 이 문서는 이 디렉터리의 파일들과 opspresso 의
alpha 호스트에만 해당하는 사실을 담는다.

**alpha 호스트** (opspresso 의 실서비스):

| | |
|---|---|
| 호스트 | `ubuntu@115.68.216.99` — Ubuntu 24.04, 4 vCPU, 3.8GB RAM |
| 주소 | `https://studio.opspresso.com` |
| 설치 경로 | `/opt/agent-studio` (관례일 뿐, compose 는 어디서든 돈다) |
| 데이터 | 이 호스트의 `postgres-data`·`minio-data` 볼륨. 다른 어디에도 없다 — `scripts/backup.sh` |

## 파일

| 파일 | 누가 만드나 | 역할 |
|---|---|---|
| `compose.yaml`, `Caddyfile`, `scripts/` | 저장소 | 구성. 바꾸려면 저장소에서 고치고 복사한다 |
| `.env.example`, `.env.mcp.example` | 저장소 | 설정의 원본. `deploy.sh` 가 여기서 `.env`/`.env.mcp` 를 생성한다 |
| `.env.secrets` | 사람 (chmod 600) | 앱·MCP 서버의 시크릿. `.env.secrets.example` 이 목록 |
| `.env.aws` | 사람, 선택 | AWS 액세스 키 — ECR pull, `aws` 프로파일의 서버(memory·cloudwatch), Bedrock, 그리고 `.env.secrets` 가 없을 때 SSM 을 시크릿 소스로 |
| `.env.host` | `deploy.sh` 가 첫 실행에 | 이 호스트의 Postgres·MinIO 자격 증명. **다시 생성되지 않는다** — 백업에 포함 |
| `.env`, `.env.mcp` | `deploy.sh` 가 매번 | 생성물. 손대지 않는다 |

## 사전 준비

### 호스트

`scripts/setup-host.sh` 가 Ubuntu 24.04 호스트에 Docker Engine/Compose, AWS CLI, 배포 도구, 4GB 스왑과
`/opt/agent-studio` 를 준비한다. 멱등이라 중간에 끊겼으면 그대로 재실행한다.

```bash
# 로컬 저장소에서
scp -r deploy/idc ubuntu@<host>:/tmp/agent-studio-idc

# 호스트에서
/tmp/agent-studio-idc/scripts/setup-host.sh
sudo cp -a /tmp/agent-studio-idc/. /opt/agent-studio/
sudo chown -R ubuntu:ubuntu /opt/agent-studio
```

방화벽은 SSH 를 유지한 채 Caddy 가 받을 TCP 80/443 만 허용한다. ACME 가 닿지 않는 망이면
`Caddyfile` 에 조직 인증서를 지정한다(`tls /path/cert.pem /path/key.pem`).

### 시크릿

```bash
cd /opt/agent-studio
cp .env.secrets.example .env.secrets && chmod 600 .env.secrets
```

`AES_ENCRYPTION_KEY`(`openssl rand -base64 32`, **한 번 정하면 바꾸지 않는다**), `BETTER_AUTH_SECRET`,
`LLM_API_KEY`, 그리고 로그인 방식 하나 — `BOOTSTRAP_ADMIN_PASSWORD`(비밀번호) 또는
`OIDC_CLIENT_ID/SECRET`(사내 IdP). 나머지는 쓰는 것만 채운다.

alpha 호스트는 `.env.aws` 를 두고 `.env.secrets` 를 두지 않는다 — 그러면 `deploy.sh` 가 같은 이름들을
SSM(`/k8s/common/agent-studio/*`)에서 읽는다. 그 IAM 사용자 `agent-studio` 와 정책은
`terraform-env-demo/demo/9-agent-studio` 가 만들고, 키 발급만 사람이 한다
(`aws iam create-access-key --user-name agent-studio`). 대가는 분명하다: **이 액세스 키가 유출되면
SSM 의 배포 시크릿 전부가 함께 열린다.**

### 설정

`.env.example` 에서 도메인(`BETTER_AUTH_URL`, `PUBLIC_BASE_URL`, `Caddyfile`), `ADMIN_EMAILS`,
`BOOTSTRAP_ADMIN_EMAIL`, LLM 주소, 로그인 방식, `COMPOSE_PROFILES` 를 맞춘다. OIDC 를 쓰면 IdP 에
리디렉션 URI `https://<host>/api/auth/callback/oidc` 를, Google 이면
`https://<host>/api/auth/callback/google` 을 등록한다.

## 설치와 업데이트

```bash
scripts/deploy.sh
```

한 스크립트가 전부다: `.env.example` 에서 `.env` 생성(GitHub 이 닿으면 이미지 태그는 argocd-env-demo 의
alpha 핀을 따른다; `FOLLOW_VERSIONS=false` 면 example 의 핀), 시크릿 덧붙이기, 첫 실행이면 `.env.host`
생성, ECR 이면 로그인, pull, `compose up -d`. 바뀐 것이 없는 실행은 아무것도 재생성하지 않으므로 타이머에
걸어도 된다:

```
*/10 * * * * /opt/agent-studio/scripts/deploy.sh >> /var/log/agent-studio-deploy.log 2>&1
```

확인:

```bash
docker compose ps                                             # app·postgres·minio healthy
curl -fsS https://<host>/api/health                           # {"status":"ok"}
docker compose exec app wget -qO- \
  http://mcp-document.agent-mcps.svc.cluster.local/health     # MCP 도달성
```

마지막이 이 배포의 트릭이다. MCP 컨테이너는 **클러스터 DNS 이름을 네트워크 alias 로** 달고 **80 을
리슨한다**. 그래서 `agent-plugins` 의 `mcp.json`(`http://mcp-<name>.agent-mcps.svc.cluster.local/mcp`)이
여기서도 그대로 해석된다. 앱이 그 사설 주소에 닿는 것은 `MCP_INTERNAL_HOST_SUFFIXES` 가 SSRF 가드에
그 suffix 를 선언하기 때문이다.

호스트에서 이미지를 빌드하지 마라 — RAM 3.8GB 에서 `next build` 는 OOM 으로 끝난다.

## 데이터

- **백업** — `scripts/backup.sh [DEST]`: `pg_dump` + 오브젝트 미러 + `.env.host`. 최신 7개 보관.
  복원 절차는 스크립트 머리에. cron 에 하루 한 번.
- **DynamoDB 에서 이관** — `docs/INSTALL.md` 의 절차. 테이블은 `aws dynamodb scan` 으로 내보내
  `scripts/import-dynamodb-export.ts` 로, 오브젝트는 `scripts/migrate-objects.sh s3://<bucket>` 으로.
- **보존** — 만료 행은 티커가 쓸어 낸다(`COMPOSE_PROFILES` 에 `ticker`). 끄면 schedule 도, 정리도 멈춘다.

## 프로파일

| 프로파일 | 서비스 | 조건 |
|---|---|---|
| `ticker` | 스케줄·플러그인 sync·카탈로그 재색인·보존 스위프 | 항상 켠다 |
| `aws` | mcp-memory(S3 Vectors·Bedrock KB), mcp-cloudwatch | `.env.aws` 와 그 IAM 권한. mcp-memory 는 아직 AWS 없이는 못 돈다 |
| `eks` | mcp-argocd, mcp-grafana, mcp-kubernetes | `.env.mcp.example` 의 주소와 kubeconfig. 채워지기 전에는 넣지 마라 — 컨테이너는 뜨고 도구 호출만 실패한다 |

## Grafana Cloud (alpha)

### Alloy 설치와 메트릭 수집

`scripts/setup-grafana.sh` 는 Grafana 공식 apt 저장소에서 Alloy 를 설치하고
`grafana/config.alloy` 를 `/etc/alloy/config.alloy` 에 적용한다. 기존 설정이 다르면 같은 경로 옆에
UTC 시각이 붙은 백업을 먼저 남긴다. 다음 세 대상을 Grafana Cloud Prometheus 로 보낸다.

| job | 대상 | 주기 |
|---|---|---:|
| `integrations/node_exporter` | 호스트 CPU, 메모리, swap, 디스크, 네트워크 | 15초 |
| `agent-studio` | `https://studio.opspresso.com/api/metrics` | 30초 |
| `integrations/cadvisor` | `agent-studio` Compose service별 CPU, 메모리, network, disk I/O, OOM | 30초 |

cAdvisor는 Alloy process 안에서 실행하고 Compose project·service 두 label만 허용한다. container
ID·image·name은 remote write 전에 제거해 컨테이너 재생성마다 시계열이 늘지 않게 한다. Docker
상태를 읽기 위해 설치 스크립트가 `alloy` 사용자를 `docker` 그룹에 추가한다. 이 그룹은 host에서
root에 준하는 권한이므로 Alloy 설정과 service 계정을 관리자만 변경할 수 있게 유지하라.

Grafana Cloud의 Alloy 온보딩에서 발급한 access policy token을 준비하고 호스트에서 실행하라.
스크립트가 터미널에서 값을 숨겨 입력받고 `/etc/alloy/agent-studio.env`에 root 전용 `0600`으로
저장한다. 토큰을 명령행 인수, Alloy 설정 또는 저장소에 넣지 마라.

```bash
cd /opt/agent-studio
scripts/setup-grafana.sh

systemctl status alloy --no-pager
curl -fsS http://127.0.0.1:12345/-/ready
```

기본 collector ID는 이 호스트의 Grafana Fleet ID인 `byforce-318260`이고, 다른 호스트에는
`GCLOUD_FM_COLLECTOR_ID`를 명시하라.

### 대시보드

`grafana/dashboards/agent-studio-idc.json` — UID `agent-studio-idc`는 바꾸지 마라. 업로드에는 Grafana
Service Account token이 필요하다(`--dry-run`은 인증 없이 payload만 검사).

```bash
deploy/idc/scripts/upload-grafana-dashboard.sh --dry-run | jq . >/dev/null
read -rsp 'Grafana Service Account token: ' GRAFANA_SERVICE_ACCOUNT_TOKEN; echo
export GRAFANA_SERVICE_ACCOUNT_TOKEN
deploy/idc/scripts/upload-grafana-dashboard.sh
unset GRAFANA_SERVICE_ACCOUNT_TOKEN
```

## 운영 메모

- **드레이닝** — `stop_grace_period: 660s` 는 `MAX_RUN_DURATION_MS`(10분)에 맞춘 값이다. 앱은
  `SIGTERM` 을 드레이닝으로 바꿀 뿐 `process.exit` 를 부르지 않으므로, 이 유예가 진행 중인 SSE 스트림이
  빠져나갈 시간 전부다.
- **로그** — `docker compose logs -f app`. 컨테이너당 10MB × 3 으로 회전한다.
- **Postgres 에 직접** — `docker compose exec postgres psql -U agent_studio agent_studio`.

# 호스트 하나에 설치 — IDC

단일 물리 호스트 위의 Docker Compose 배포. 앱, PostgreSQL(pgvector), MinIO, MCP 서버들이 한
네트워크에 들어가고, Caddy 가 TLS 를 끊는다. **설치형 배포의 기본 모양**이고, 설치 전 과정은
[docs/INSTALL.md](../../docs/INSTALL.md) 가 답한다. 이 문서는 이 디렉터리의 파일들과 opspresso 의
alpha 호스트에만 해당하는 사실을 담는다.

**alpha 호스트** (opspresso 의 실서비스):

| | |
|---|---|
| 호스트 | `ubuntu@115.68.228.117` — Ubuntu 24.04, 4 vCPU, 7.8GB RAM (2026-08-23 `115.68.216.99` 에서 이전) |
| 주소 | `https://studio.opspresso.com` |
| 설치 경로 | `/opt/compose/apps/agent-studio` (관례일 뿐, compose 는 어디서든 돈다) |
| 데이터 | 이 호스트의 `postgres18-data`·`minio-data` 볼륨. 다른 어디에도 없다 — `scripts/backup.sh` |
| Grafana | Alloy collector `byforce-318755` — `setup-grafana.sh` 의 기본값이 아니므로 `GCLOUD_FM_COLLECTOR_ID` 를 준다 |

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

호스트 준비는 이 저장소가 하지 않는다 — [nalbam/dotfiles](https://github.com/nalbam/dotfiles) 의
`linux/init.sh` 가 Ubuntu 24.04 에 Docker Engine/Compose, AWS CLI, `jq`·`python3`, 4GB 스왑,
`/opt/compose/{apps,data,backup}` 을 놓고 `ubuntu` 계정에 root 의 SSH 키와 `docker` 그룹을 넘긴다.
멱등이라 중간에 끊겼으면 그대로 재실행한다.

```bash
# 호스트에서, root 로 한 번
curl -fsSL nalbam.github.io/dotfiles/linux/init.sh | bash
```

이후 작업은 전부 `ubuntu` 계정으로 한다.

```bash
# 로컬 저장소에서
scp -r deploy/idc ubuntu@<host>:/tmp/agent-studio-idc

# 호스트에서, ubuntu 로
mkdir -p /opt/compose/apps/agent-studio
cp -a /tmp/agent-studio-idc/. /opt/compose/apps/agent-studio/
```

방화벽은 SSH 를 유지한 채 Caddy 가 받을 TCP 80/443 만 허용한다. ACME 가 닿지 않는 망이면
`Caddyfile` 에 조직 인증서를 지정한다(`tls /path/cert.pem /path/key.pem`).

### 시크릿

```bash
cd /opt/compose/apps/agent-studio
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
`BOOTSTRAP_ADMIN_EMAIL`, LLM 주소, 로그인 방식, `IMAGE_REGISTRY`, `COMPOSE_PROFILES` 를 맞춘다.
AWS 를 쓰지 않으면 `IMAGE_REGISTRY=ghcr.io/opspresso`, `COMPOSE_PROFILES=ticker` 로 둔다.
OIDC 를 쓰면 IdP 에 리디렉션 URI `https://<host>/api/auth/callback/oidc` 를, Google 이면
`https://<host>/api/auth/callback/google` 을 등록한다.

## 설치와 업데이트

```bash
scripts/deploy.sh
```

한 스크립트가 전부다: `.env.example` 에서 `.env` 생성(GitHub 이 닿으면 이미지 태그는 argocd-env-demo 의
alpha 핀을 따른다; `FOLLOW_VERSIONS=false` 면 example 의 핀), 시크릿 덧붙이기, 첫 실행이면 `.env.host`
생성, ECR 이면 로그인, pull, mcp-memory 의 `mcp_memory` 데이터베이스 확인(없으면 생성), `compose up -d`.
바뀐 것이 없는 실행은 아무것도 재생성하지 않으므로 타이머에 걸어도 된다:

```
*/10 * * * * /opt/compose/apps/agent-studio/scripts/deploy.sh >> /var/log/agent-studio-deploy.log 2>&1
```

`ubuntu` 의 crontab 이므로 로그 파일은 미리 그 계정 소유로 만들어 둔다 —
`sudo install -m 0644 -o ubuntu -g ubuntu /dev/null /var/log/agent-studio-deploy.log`.

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

호스트에서 이미지를 빌드하지 마라 — 빌드는 릴리즈 파이프라인 몫이다. 옛 3.8GB 호스트에서 `next build`
는 OOM 으로 끝났고, RAM 이 늘어난 지금도 서비스가 도는 호스트에서 할 일은 아니다.

## 데이터

- **백업** — `scripts/backup.sh [DEST]`: 두 데이터베이스(`agent_studio` 와 mcp-memory 의 `mcp_memory`)
  의 `pg_dump` + 오브젝트 미러 + `.env.host`. 최신 7개 보관. 복원 절차는 스크립트 머리에.
  cron 에 하루 한 번, DEST 는 `/opt/compose/backup`.
- **DynamoDB 에서 이관** — `docs/INSTALL.md` 의 절차. 테이블은 `aws dynamodb scan` 으로 내보내
  `scripts/import-dynamodb-export.ts` 로, 오브젝트는 `scripts/migrate-objects.sh s3://<bucket>` 으로.
- **보존** — 만료 행은 티커가 쓸어 낸다(`COMPOSE_PROFILES` 에 `ticker`). 끄면 schedule 도, 정리도 멈춘다.

### PostgreSQL major upgrade

Bundled PostgreSQL은 18과 `postgres18-data:/var/lib/postgresql` volume 계약을 사용한다. PostgreSQL 17의 `postgres-data` volume은 image tag만 바꿔 재사용할 수 없다. Major version을 올릴 때는 새 volume에 PostgreSQL 18을 초기화하고 PostgreSQL 18의 `pg_dump`로 기존 server를 읽어 논리 restore하라.

1. `agent_studio`와 `mcp_memory`를 모두 backup하고 `.env.host`를 보존한다.
2. App, ticker, mcp-memory처럼 database에 쓰는 service를 중지한다.
3. 기존 `postgres-data`는 그대로 둔 채 새 `postgres18-data`를 초기화한다.
4. 두 database를 restore하고 `vector` extension, table 수, 핵심 row 수를 확인한다.
5. App과 mcp-memory health를 확인한 뒤 writer를 다시 연다.

검증이 끝날 때까지 PostgreSQL 17 container와 `postgres-data` volume을 삭제하지 마라. Rollback은 writer를 다시 중지하고 Compose를 이전 image와 volume으로 돌린 뒤 기존 volume을 시작하는 것이다.

## 호스트 이전

옛 호스트를 끄고 새 호스트로 옮기는 순서. 2026-08-23 `115.68.216.99` → `115.68.228.117` 이 이
순서였고, 서비스가 멈춘 구간은 **4번부터 8번까지** — 데이터가 작아(테이블 21MB, 오브젝트 134MB)
몇 분이면 끝난다. 시크릿이 SSM 에 있고 `AES_ENCRYPTION_KEY`·`BETTER_AUTH_SECRET` 이 그대로이므로
로그인한 사람은 다시 로그인하지 않는다 — `session` 행까지 옮겨 가기 때문이다.

1. **새 호스트 준비** — [사전 준비](#사전-준비)의 `init.sh` 와 `deploy/idc` 복사. 이어서 `.env.aws`
   와 **`.env.host` 를 옛 호스트에서 그대로 가져온다**. `.env.host` 를 새로 민팅하면 복원해 넣을
   데이터와 자격 증명이 어긋난다.

   ```bash
   for f in .env.aws .env.host; do
     ssh ubuntu@<old> "cat /opt/compose/apps/agent-studio/$f" |
       ssh ubuntu@<new> "umask 077; cat > /opt/compose/apps/agent-studio/$f"
   done
   ```

2. **데이터 계층만 먼저** — 새 호스트에서 `ONLY="postgres minio minio-init" scripts/deploy.sh`.
   `.env` 가 만들어지고 볼륨과 버킷이 생긴다.

3. **오브젝트를 미리 한 번** — 부피가 큰 쪽을 서비스가 살아 있는 동안 옮겨 두면 전환 창이 짧아진다.
   옛 호스트에서 `backup.sh` 와 같은 방식으로 디렉터리에 내린 뒤 tar 로 보내고, 새 호스트에서
   `mc mirror` 로 넣는다. 두 번째 실행은 바뀐 것만 옮기므로 4번 뒤에 한 번 더 돌린다.

4. **쓰는 쪽을 멈춘다** — 옛 호스트에서 `docker compose stop app ticker mcp-memory`.
   **여기부터 서비스 중단이다.** 티커가 살아 있으면 옛 데이터베이스가 계속 앞서 나간다.

5. **데이터베이스** — 두 개다. 하나만 옮기면 기억이 사라진 채로 정상으로 보인다.

   ```bash
   for db in agent_studio mcp_memory; do
     ssh ubuntu@<old> "cd /opt/compose/apps/agent-studio &&
       docker compose exec -T postgres pg_dump -U agent_studio --clean --if-exists $db | gzip" |
     gunzip | ssh ubuntu@<new> "cd /opt/compose/apps/agent-studio &&
       docker compose exec -T postgres psql -U agent_studio -v ON_ERROR_STOP=1 -q $db"
   done
   ```

   그리고 3번의 오브젝트 미러를 한 번 더 — 마지막 복사 이후 생긴 것이 빠진다.

6. **인증서** — Caddy 의 볼륨을 통째로 옮기면 DNS 를 돌린 직후 ACME 를 기다리지 않아도 된다.

   ```bash
   ssh ubuntu@<old> 'docker run --rm -v agent-studio_caddy-data:/data alpine tar cf - -C /data .' |
     ssh ubuntu@<new> 'docker volume create agent-studio_caddy-data >/dev/null &&
       docker run --rm -i -v agent-studio_caddy-data:/data alpine tar xf - -C /data'
   ```

7. **전체 기동과 확인** — 새 호스트에서 `scripts/deploy.sh`. DNS 를 바꾸기 *전에* 새 주소로 직접
   확인한다.

   ```bash
   curl -fsS --resolve studio.opspresso.com:443:<new-ip> https://studio.opspresso.com/api/health
   ```

   행 수를 양쪽에서 세어 맞춰 보고(`items`, `catalog_vectors`, `user`, `session`, `memories`,
   `objects`), 옮겨 온 **런타임 설정 행이 `.env` 를 이긴다**는 것을 기억하라 — `SETTINGS#app|META`
   의 `artifactAccessMode` 나 `a2aApiKey` 는 새 호스트의 `.env` 값이 아니라 그 행이 답이다.

8. **DNS** — Route 53 에서 `studio.opspresso.com` A 레코드를 새 IP 로 UPSERT 한다. TTL 을 함께
   낮춰 두면(60초) 되돌릴 일이 생겼을 때 빠르다.

9. **메시징 표면** — 웹훅 주소는 도메인이라 DNS 를 따라가지만, **Telegram 은 그 도메인의 IP 를
   캐시한다** — `getWebhookInfo` 의 `ip_address` 가 옛 호스트로 남고, 다음 메시지 배달이 실패하고
   나서야 다시 찾는다. 켜져 있는 봇마다 콘솔의 *Register webhook* 을 누르거나(같은 URL·같은
   시크릿으로 `setWebhook` 을 다시 부른다) 그에 해당하는 호출을 한 번 해 주고, `ip_address` 가
   새 호스트인지 확인한다. Slack·Teams 는 요청마다 도메인을 다시 찾으므로 할 일이 없다.

10. **뒷정리** — 옛 호스트에서 `docker compose stop` 과 `sudo systemctl disable --now alloy`
    (그러지 않으면 두 collector 가 같은 `/api/metrics` 를 긁는다). **볼륨은 지우지 마라** — 되돌릴
    곳이다. 새 호스트에서는 `scripts/setup-grafana.sh` 로 Alloy 를 올리고, `backup.sh` 를 cron 에
    건다.

## 프로파일

| 프로파일 | 서비스 | 조건 |
|---|---|---|
| `ticker` | 스케줄·플러그인 sync·카탈로그 재색인·보존 스위프 | 항상 켠다 |
| `aws` | mcp-memory(PostgreSQL 저장·Bedrock 임베딩/KB), mcp-cloudwatch | `.env.aws` 와 그 IAM 권한. mcp-memory 는 아직 AWS 없이는 못 돈다 |
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
cd /opt/compose/apps/agent-studio
scripts/setup-grafana.sh

systemctl status alloy --no-pager
curl -fsS http://127.0.0.1:12345/-/ready
```

스크립트의 기본 collector ID는 `byforce-318260`(옛 호스트의 Grafana Fleet ID)이므로 **지금의 alpha
호스트를 포함해** 다른 호스트에서는 `GCLOUD_FM_COLLECTOR_ID`를 명시하라 — 이 호스트는
`byforce-318755`다. 호스트가 Grafana Cloud 온보딩으로 이미 Alloy 를 갖고 있으면 토큰은 그 안에 있다:
`sudo cat /etc/systemd/system/alloy.service.d/env.conf`(설치 스크립트가 실행되면 이 파일을
`/etc/alloy/agent-studio.env`로 옮기고 원본은 `.migrated-<시각>`으로 남긴다).

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

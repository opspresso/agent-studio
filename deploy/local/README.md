# deploy/local — MCP 서버 로컬 배포

레지스트리의 MCP 서버들을 docker compose 로 로컬에 띄운다. **앱은 컨테이너가 아니라 호스트의 `pnpm dev`** — 코드를 고치고 `http://localhost:3000` 에서 바로 테스트하면서, MCP dispatch 는 실제 배포와 같은 경로로 동작한다.

agent-plugins 레지스트리가 등록하는 MCP URL 은 `http://mcp-<name>.agent-mcps.svc.cluster.local/mcp`(포트 없음 = 80)이다. `deploy/idc/` 와 같은 트릭으로 각 서비스가 그 클러스터 DNS 이름을 network alias 로 달고 80 포트로 리슨하며, 여기에 하나를 더한다: **OrbStack 커스텀 도메인 라벨**(`dev.orbstack.domains`) 로 호스트의 `pnpm dev` 프로세스도 같은 이름을 컨테이너로 직접 해석한다 — 포트 공개도 `/etc/hosts` 도 필요 없다.

> OrbStack 전용 부분은 라벨 하나뿐이다. 일반 Docker Desktop 에서는 호스트가 이 이름들을 해석하지 못하므로, `/etc/hosts` 에 `127.0.0.1 mcp-<name>.agent-mcps.svc.cluster.local …` 를 추가하고 127.0.0.1:80 에서 Host 헤더로 라우팅하는 프록시(caddy 등)를 두는 방식으로 대신한다.

## 사전 조건

- 로컬 개발 셋업 (`docs/DEVELOPMENT.md`): dev DynamoDB(:8083), `.env.local`, `pnpm dev`.
- `.env.local` 에 한 줄 추가 — 이것이 없으면 SSRF 가드가 MCP URL 을 전부 거부하고, plugins sync 는 모든 서버를 `invalid-url` 로 스킵한다:

  ```
  MCP_INTERNAL_HOST_SUFFIXES=agent-mcps.svc.cluster.local
  ```

- MCP 이미지를 받을 AWS 자격 증명 (private ECR). `AWS_PROFILE` 이면 충분하다.

## 실행

```bash
cd deploy/local
scripts/deploy.sh    # 첫 실행: .env 생성 후 종료 — 검토하고 다시 실행
scripts/deploy.sh    # 태그 갱신 + ECR 로그인 + 기동
pnpm dev             # 레포 루트에서 — http://localhost:3000
```

## 검증

```bash
# 호스트에서 컨테이너 직결 (OrbStack 도메인)
curl -s -o /dev/null -w '%{http_code}\n' \
  -X POST http://mcp-document.agent-mcps.svc.cluster.local/mcp \
  -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"probe","version":"0"}}}'
# → 200
```

콘솔에서: `/plugins` 의 **Sync** 를 실행하면 클러스터 DNS 서버들이 레지스트리에 생성된다 (`ticker` 프로필을 켰다면 1분 내 자동). 그다음 `/tools` 의 `mcp-document`·`mcp-youtube` 에 **Test** — 성공하면 suffix 를 경유한 dispatch 까지 동작하는 것이다.

## 프로필

기본은 자격 증명이 필요 없는 `mcp-document` + `mcp-youtube` 만 뜬다. `.env` 의 `COMPOSE_PROFILES` 에 추가한다:

| 프로필 | 서비스 | 필요한 것 | 주의 |
|---|---|---|---|
| `aws` | mcp-memory, mcp-cloudwatch | `cp .env.aws.example .env.aws` 후 액세스 키 | mcp-memory 는 **알파와 같은** 메모리 버킷(`agent-studio-vector`/`agent-studio-memory`)을 읽고 쓴다 — 로컬 S3 Vectors 는 없다 |
| `brave` | mcp-brave-search | `.env` 의 `BRAVE_API_KEY` | |
| `ticker` | 스케줄·플러그인 sync·카탈로그 리인덱스 | `.env` 의 `SCHEDULE_SCAN_TOKEN` (`.env.local` 과 같은 값) | `../idc/scripts/tick.sh` 를 그대로 마운트하고 호스트의 `pnpm dev`(:3000)를 두드린다 — 컨테이너에는 이 토큰 하나만 들어간다 |

managed MCP(`MANAGED_MCP_INSTANCE_ID=local`)는 별개의 경로다: 앱이 직접 docker CLI 로 컨테이너를 띄우고 루프백으로 등록한다 (`docs/CONFIGURATION.md`). 이 compose 는 *레지스트리(agent-plugins)의* 서버들을 실제 배포와 같은 이름으로 띄우는 쪽이다 — 두 방식은 공존할 수 있다.

## 정리

```bash
cd deploy/local && docker compose --profile '*' down
```

`--profile '*'` 는 지금 꺼져 있는 프로필의 컨테이너(예: `aws` 를 켰다가 끈 뒤 남은 mcp-memory)까지 내린다. 이 프로젝트(`agent-studio-local`)의 컨테이너만 내려간다. 레포 루트의 `localdev` 프로젝트(공유 DynamoDB)와는 무관하며, 그쪽은 [루트 compose.yaml 의 경고](../../compose.yaml)대로 `down -v` 를 절대 쓰지 않는다.

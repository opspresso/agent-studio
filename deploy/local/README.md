# deploy/local — 로컬 docker compose 배포

`deploy/idc/` 의 로컬 축소판. MCP 서버들을 docker compose 로 띄우고, 워킹 트리에서 빌드한 앱을 `http://localhost:3000` 으로 접속해 **배포 형태 그대로** 테스트한다. 코드 반복 작업에는 여전히 `pnpm dev` 를 쓴다 — 이 구성은 MCP 통합·컨테이너 동작을 확인할 때 쓴다.

핵심은 IDC 와 같은 두 가지 트릭이다. agent-plugins 레지스트리가 등록하는 MCP URL 은 `http://mcp-<name>.agent-mcps.svc.cluster.local/mcp`(포트 없음 = 80)이므로, 각 MCP 서비스는 그 클러스터 DNS 이름을 **network alias** 로 달고 **80 포트로 리슨**한다. 앱은 `.env` 의 `MCP_INTERNAL_HOST_SUFFIXES` 선언 덕분에 SSRF 가드를 지나 그 주소에 도달한다.

## 사전 조건

- 레포 루트의 `.env.local` — 앱의 base 설정 (`docs/DEVELOPMENT.md` 의 로컬 셋업).
- 공유 dev DynamoDB 와 테이블:

  ```bash
  docker compose up -d dynamodb     # 레포 루트, :8083
  pnpm init-local-table
  ```

  앱 컨테이너는 `host.docker.internal:8083` 으로 이 인스턴스를 읽는다 — `pnpm dev` 와 **같은 테이블, 같은 dev-session 쿠키**.
- MCP 이미지를 받을 AWS 자격 증명 (private ECR). `AWS_PROFILE` 이면 충분하다.

## 실행

```bash
cd deploy/local
scripts/deploy.sh    # 첫 실행: .env 생성 후 종료 — 검토하고 다시 실행
scripts/deploy.sh    # 태그 갱신 + ECR 로그인 + 빌드 + 기동
```

`.env` 는 컨테이너 관점의 오버라이드만 담는다. `.env.local` 의 `LLM_BASE_URL` 이 루프백(mock-llm `:8002`, LM Studio `:1234`)이면 `.env` 에서 `host.docker.internal` 로 재선언해야 한다 — 컨테이너의 `127.0.0.1` 은 컨테이너 자신이다.

로그인은 `pnpm dev` 와 동일하다: Google OAuth 를 설정했으면 그대로, 아니면 dev-session 쿠키를 쓴다.

```bash
pnpm tsx --env-file=.env.local scripts/dev-session.ts
```

## 검증

```bash
curl -s http://localhost:3000/api/health          # {"status":"ok"}
docker compose exec app wget -qO- http://mcp-document.agent-mcps.svc.cluster.local/mcp \
  --header 'Accept: application/json' || true      # alias 해석 확인 (405/406 이어도 도달은 성공)
```

콘솔에서: `/tools` 의 `mcp-document`·`mcp-youtube` 에 **Test** — 성공하면 suffix 를 경유한 dispatch 까지 동작하는 것이다. 레지스트리에 MCP 행이 없다면 아직 plugins sync 가 돈 적이 없는 것: `ticker` 프로필을 켜거나 `/plugins` 콘솔에서 sync 를 실행한다.

## 프로필

기본은 자격 증명이 필요 없는 `mcp-document` + `mcp-youtube` 만 뜬다. `.env` 의 `COMPOSE_PROFILES` 에 추가한다:

| 프로필 | 서비스 | 필요한 것 | 주의 |
|---|---|---|---|
| `aws` | mcp-memory, mcp-cloudwatch | `cp .env.aws.example .env.aws` 후 액세스 키 | mcp-memory 는 **알파와 같은** 메모리 버킷(`agent-studio-vector`/`agent-studio-memory`)을 읽고 쓴다 — 로컬 S3 Vectors 는 없다 |
| `brave` | mcp-brave-search | `.env` 의 `BRAVE_API_KEY` | |
| `ticker` | 스케줄·플러그인 sync·카탈로그 리인덱스 | `.env.local` 의 `SCHEDULE_SCAN_TOKEN` | `../idc/scripts/tick.sh` 를 그대로 마운트한다 |

managed MCP(`MANAGED_MCP_*`)는 이 구성에서 의도적으로 꺼져 있다: 앱 이미지에 docker CLI 가 없고, 컨테이너의 루프백은 호스트의 루프백이 아니다. managed 경로를 시험하려면 `pnpm dev` + `MANAGED_MCP_INSTANCE_ID=local` 을 쓴다 (`docs/CONFIGURATION.md`).

## 정리

```bash
cd deploy/local && docker compose down
```

이 프로젝트(`agent-studio-local`)의 컨테이너만 내려간다. 레포 루트의 `localdev` 프로젝트(공유 DynamoDB)와는 무관하며, 그쪽은 [루트 compose.yaml 의 경고](../../compose.yaml)대로 `down -v` 를 절대 쓰지 않는다.

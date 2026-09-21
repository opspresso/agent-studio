# deploy/local — MCP 서버 로컬 배포

`../agent-plugins/plugins/*/mcp.json`의 내부 MCP를 Docker Compose로 실행한다.
앱은 호스트의 `pnpm dev`로 실행한다. 각 MCP는 80 포트와
`mcp-<name>.agent-mcps.svc.cluster.local` network alias·OrbStack 도메인을 사용한다.
호스트 포트와 `/etc/hosts` 변경은 필요 없다. 일반 Docker Desktop에서는 같은 이름을
호스트에서 해석할 DNS와 loopback의 Host 기반 프록시를 별도로 구성해야 한다.

## 서비스

| 프로필 | 컨테이너 | 필요한 설정 |
|---|---|---|
| `aws` | mcp-cloudwatch | `.env.aws`의 AWS 자격증명 |
| `argocd` | mcp-argocd | `ARGOCD_BASE_URL`, `ARGOCD_API_TOKEN` |
| `grafana` | mcp-grafana | `GRAFANA_URL`, `GRAFANA_SERVICE_ACCOUNT_TOKEN` |
| `kubernetes` | mcp-kubernetes | `KUBECONFIG_PATH` |
| `ticker` | ticker | 앱과 같은 `SCHEDULE_SCAN_TOKEN` |

기본 활성 프로필은 없다. 사용할 서비스의 입력을 채운 뒤 `COMPOSE_PROFILES`에 나열한다.
이미지는 공개 registry의 고정 태그를 사용하며 ECR 로그인이 필요 없다.
배포 스크립트는 Compose가 해석한 최종 환경변수와 마운트를 검증한다. `.env`의 따옴표·변수 참조와
셸 환경변수 우선순위를 그대로 따르며, 자격증명 값은 로그에 출력하지 않는다.
GitHub·Notion·AWS Knowledge는 plugin에 선언된 외부 MCP로 연결하므로 로컬 컨테이너를 만들지 않는다.

문서 처리는 Studio 내장 기능이다. 장기 메모리는 Agent Memory 연동으로 구성한다.
이 Compose에는 mcp-document·mcp-memory·mcp-youtube가 없다. 기존 `mcp_memory`
DB와 볼륨은 제거하지 않으며, 이전 MCP 바인딩과 메모리 데이터 이전은 별도 작업이다.

## 설정과 실행

```bash
cp deploy/local/.env.example deploy/local/.env
# .env의 필요한 주소·자격증명·COMPOSE_PROFILES 설정
# aws 사용 시 .env.aws.example을 .env.aws로 복사해 설정

deploy/local/scripts/deploy.sh
pnpm dev
```

이미 `.env`가 있으면 덮어쓰지 말고 새 설정만 추가한다. 앱의 `.env.local`에는
`MCP_INTERNAL_HOST_SUFFIXES=agent-mcps.svc.cluster.local`을 포함해야 한다.
주소는 컨테이너에서 접근 가능해야 하며 호스트 서비스는 `host.docker.internal`을 사용한다.

Argo CD·Grafana·Kubernetes의 로컬 도구는 읽기 전용으로 제공한다. Kubernetes는 선택한 context만
포함한 전용 kubeconfig를 읽기 전용으로 마운트한다. 인증서 경로와 exec 플러그인을 호스트에
의존하는 kubeconfig는 그대로 동작하지 않으므로 컨테이너에서 사용할 수 있게 준비한다.
API 권한은 연결 대상의 token·RBAC가 결정한다. Grafana도 의도한 범위의 서비스 계정을 사용한다. 인증 설정은
[upstream 안내](https://github.com/grafana/mcp-grafana/blob/v1.1.0/README.md)를 따른다.
어떤 MCP에도 앱의 전체 `.env.local`을 전달하지 않는다.

## 검증

```bash
docker compose -f deploy/local/compose.yaml ps
curl -s -X POST http://mcp-cloudwatch.agent-mcps.svc.cluster.local/mcp \
  -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"probe","version":"0"}}}'
```

콘솔 `/plugins`에서 Sync한 뒤 `/tools`에서 해당 서버의 Test를 실행한다.
호스트에서 이름 해석이 실패하면 OrbStack Settings → Network의
“Allow access to container domains & IPs”와 로컬 DNS 동작을 확인한다.
[OrbStack 도메인 안내](https://docs.orbstack.dev/docker/domains#compatibility)를 따른다.
컨테이너 내부 응답과 호스트의 도메인 접근은 각각 검증해야 한다.
MCP initialize·도구 목록 성공은 하류 API 접근 성공을 보장하지 않는다.
연결 대상이 준비되면 허용된 읽기 도구로 실제 접근을 확인한다.

## 종료

```bash
docker compose -f deploy/local/compose.yaml --profile '*' down
```

이 명령은 `agent-studio-mcp-local`만 종료한다. 루트의 PostgreSQL·MinIO와 Agent Memory는
별도 Compose 프로젝트다. 데이터 볼륨을 삭제하는 `down -v`는 사용하지 않는다.

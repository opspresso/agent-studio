# Agent 저장 형식 릴리즈

이 릴리즈는 API의 `/api/projects`·`projectName`을 `/api/agents`·`agentName`으로,
PostgreSQL item 주소를 `PROJECT#`·`TYPE#PROJECT` 등에서 `AGENT#`·`TYPE#AGENT` 등으로 바꾼다.
Agent 범위의 AES-GCM 문맥도 바뀐다. 기존 DB에 Agent 행이 있으면 migration 9가 부팅을
거절한다. 이미지 tag만 갱신해서는 업그레이드되지 않는다.

## 환경별 경계

| 환경 | 데이터 처리 | 배포 게이트 |
|---|---|---|
| k3s `alpha` | `agent_studio` DB만 초기화한다. 같은 PostgreSQL 인스턴스의 `agent_memory` DB·PVC는 보존한다 | tag의 `alpha` dispatch 전에 초기화 완료 |
| EKS `prod` | 쓰기를 멈춘 원본의 custom-format dump를 별도 DB에 복원하고 아래 변환·검증을 완료한다. 원본 DB와 객체 bucket은 보존한다 | 사용자의 EKS 승인 후 작업을 시작하고, **DB 전환 검증 뒤** GitHub `prod` Environment를 승인한다 |

`prod` Environment 승인은 GitOps `phase: prod` dispatch를 즉시 시작한다. GitOps는 EKS
Application을 자동 동기화하므로, 승인과 DB 작업 사이에 별도의 안전한 대기 지점이 없다.
앱·오디오/Workspace worker·scan/reindex CronJob의 쓰기를 GitOps 유지보수 설정으로 멈추고
진행 중인 런과 승인·Workspace 작업을 정리한 뒤 백업한다. Argo CD의 자동 복구가 수동
`kubectl scale`을 되돌릴 수 있으므로 scale 명령만으로 쓰기 중단을 증명하지 않는다.
유지보수 설정은 배포 저장소의 `env/k3s-demo.yaml` 또는 `env/eks-demo.yaml`에 있는
`agent_studio_maintenance`다. 대상 환경에서만 `true`로 바꾸고 생성 values를 빌드·검증해
GitOps에 반영한다. 작업이 끝나면 같은 값을 `false`로 돌린다.

## EKS: 백업과 복원 검증

다음 명령의 대상은 `--context eks-demo`, namespace `agent-studio`, DB `agent_studio`다.
실행 전 현재 Pod·Secret·DB 이름과 사용자를 다시 확인한다. 암호화 키와 Secret 값은 출력하거나
로컬 파일에 기록하지 않는다. 백업 파일은 `umask 077`로 만들고 승인된 비공개 백업 저장소에
암호화해 보관한다. 앱의 `agent-studio-static` 객체 bucket은 그대로 사용한다.

```bash
umask 077
kubectl --context eks-demo -n agent-studio exec -i postgres-0 -- \
  psql -U agent_studio -d agent_studio -At -f - \
  < scripts/agent-data-manifest.sql > source.manifest
kubectl --context eks-demo -n agent-studio exec postgres-0 -- \
  pg_dump -U agent_studio -d agent_studio -Fc --no-owner --no-privileges > agent_studio.dump
shasum -a 256 agent_studio.dump > agent_studio.dump.sha256
kubectl --context eks-demo -n agent-studio exec -i postgres-0 -- \
  pg_restore --list < agent_studio.dump > agent_studio.dump.list
```

`source.manifest`는 `items`, SDK Session, Better Auth 네 테이블, `catalog_vectors`,
`schema_migrations`의 행 수와 정렬 독립적인 내용 digest를 기록한다. 백업 파일의 SHA-256과
목록을 확인한 뒤, **존재하지 않는** `agent_studio_next` DB를 만들고 복원한다.

```bash
kubectl --context eks-demo -n agent-studio exec postgres-0 -- \
  createdb -U agent_studio -T template0 agent_studio_next
kubectl --context eks-demo -n agent-studio exec -i postgres-0 -- \
  pg_restore -U agent_studio -d agent_studio_next --exit-on-error --no-owner --no-privileges \
  < agent_studio.dump
kubectl --context eks-demo -n agent-studio exec -i postgres-0 -- \
  psql -U agent_studio -d agent_studio_next -At -f - \
  < scripts/agent-data-manifest.sql > restored.manifest
diff -u source.manifest restored.manifest
```

`diff`가 비어 있어야 변환을 시작한다. 실패하면 원본 DB는 건드리지 않고 복원 DB를 조사한다.
변환 CLI는 release 이미지의 `build/migrate-agent-data.cjs`다. 원본 `DATABASE_URL`·
`AES_ENCRYPTION_KEY`를 제공하는 기존 `agent-studio` ConfigMap/Secret을 일회성 Job에
참조시키고, `--target-database=agent_studio_next`를 넘긴다. CLI는 URL의 **DB 이름만**
바꾸고 원본 DB에 접속하지 않는다. `source.manifest`의 행 수 일곱 개를
`--expected-items`, `--expected-runtime-sessions`, `--expected-users`,
`--expected-auth-sessions`, `--expected-accounts`, `--expected-verifications`,
`--expected-vectors`에 전달한다. 먼저 `--apply` 없이 전체 변환을 실행해 rollback되는
dry run을 검증하고, 같은 수치로 `--apply`를 실행한다. 일치하지 않는 복원본, 기존
Agent 형식 행, 복호화 불가 비밀, 변환하지 못한 Agent 범위 암호문, 진행 중인 SDK 승인이
있으면 변환을 거절한다. 변환·migration 9는 한 PostgreSQL transaction에서 commit된다.

완료 후 `agent_studio_next`의 `schema_migrations` 9, `PROJECT#` 및 최상위
`projectName` 0건, 모든 테이블의 행 수, Agent 목록·Chat/Workspace 이력·Usage/Audit,
대표 Artifact의 S3 읽기, Agent API 토큰·MCP 연결 비밀의 복호화, 새 경로의 실제 추론을
확인한다. 변환 후 `items`와 컬럼을 바꾼 `runtime_sessions`, 버전 9를 기록한
`schema_migrations`의 digest는 달라지는 것이 정상이다. 다른 테이블의 digest는
그대로여야 한다.

검증된 복원본으로 DB를 전환할 때는 원본 DB를 다른 이름으로 보존하고 연결이 없는 상태에서
새 DB를 `agent_studio`로 지정한다. 이전 앱이 새 DB에 다시 쓰지 못하도록 GitOps 유지보수
상태를 확인한 다음 GitHub `prod` Environment를 승인한다. 새 이미지와 worker가 같은
version으로 기동하고 Argo CD가 `Synced`·`Healthy`, `/api/metrics`의 build version이
일치하는지 확인한다. 롤백은 이전 앱·DB와 원래 객체 bucket을 함께 사용한다. 새 DB에서
생성한 데이터는 이전 DB에 자동 병합되지 않는다.

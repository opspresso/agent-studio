# 마일스톤

Agent Studio는 프로젝트·버전 관리, LLM/에이전트 실행, Skills/MCP/외부 에이전트,
Slack/A2A 연동, 사용량 집계와 트레이스를 갖추고 있다. 이 문서는 구현 이력이 아니라
프로덕션 운영에 남은 작업만 우선순위대로 관리한다.

작업은 두 종류다. **기반**(M1~M3)은 새 기능이 얹힐 구조를 정리하고, **기능**(M4~M7)은
운영에 필요한 동작을 추가한다. 기반 작업을 앞에 두는 이유는 M4~M7이 모두 새 실행
진입점·새 조립 지점·새 아웃바운드 호출을 추가하기 때문이다. 지금 경계 규칙을 강제하는
수단이 없어, 기능을 먼저 얹으면 정리 비용이 그만큼 커진다.

**규약**

- 각 마일스톤은 **완료 조건**을 자동으로 확인할 수 있어야 한다. 확인 방법이 정해지지
  않은 작업은 마일스톤에 넣지 않는다.
- **선행**이 있는 마일스톤은 선행이 끝나기 전에 착수하지 않는다.
- 완료된 마일스톤은 이 문서에서 제거한다. 이력은 git log와 CHANGELOG가 source다.
- 기반 작업(M1~M3)은 전부 동작 보존이다. 기존 테스트를 수정해서 통과시키면 완료가 아니다.

---

## M1 — 레이어 경계 강제와 데이터 보호 포트

**이유**: `app → application → domain ← infrastructure` 의존 규칙이 문서에만 있고
기계적 강제 수단이 없다(ESLint 없음, 아키텍처 테스트 없음). domain 순수성은 지켜지고
있으나 application이 infrastructure를 직접 import 하는 곳이 28건 / 14개 파일이다.
특히 `secretEncryption`(7곳)·`timingSafe`(1곳)와 `ssrfGuard`(4곳)는 암호화·아웃바운드
정책이라는 정책 관여 협력자인데 포트 없이 하드와이어링돼 있어, 이들을 쓰는 모든
application 테스트가 `AES_ENCRYPTION_KEY` 환경변수와 `vi.mock`에 묶여 있다.
라우트도 같은 규칙을 벗어난다 — app이 infrastructure를 직접 import 하는 곳이 14건이고,
그중 조립 지점(`api/chats/_deps.ts`, `api/slack/events/_lib/`) 7건을 뺀 7건이 위반이다.

**선행**: 없음. 다른 모든 마일스톤의 선행이다.

**범위**

- `tests/architecture.test.ts` 추가. 새 의존성 없이 `node:fs` + 정규식으로 구현한다.
  - domain → application/infrastructure/lib/app 금지 (허용 목록 비어 있음)
  - domain → next/react/@aws-sdk/better-auth 금지 (허용 목록 비어 있음)
  - application → infrastructure/app 금지 (현행 위반을 허용 목록으로 동결)
  - infrastructure → application/app 금지 (허용 목록 비어 있음)
  - app → infrastructure 금지 (현행 위반 7건을 허용 목록으로 동결). 조립 지점
    `api/chats/_deps.ts`와 `api/slack/events/_lib/`는 허용 목록이 아니라 **규칙의
    예외**로 둔다 — 영구 예외와 임시 동결을 한 목록에 섞으면 목록이 비었는지로
    완료를 판정할 수 없다.
  - 허용 목록은 `"파일 -> import"` 정렬 배열이며 `toEqual`로 정확 비교한다.
    개수 비교나 부분 매칭은 한 건이 사라지고 다른 건이 생기는 교체를 놓친다.
  - `import type`도 위반으로 집계하되 항목에 `(type)`을 붙여 구분한다.
- `SecretCipher` 포트를 domain에 정의하고 application 8곳(`secretEncryption` 7,
  `timingSafe` 1)을 주입으로 전환한다. 필요한 메서드는 실제 사용 표면을 조사해
  결정하고, 추측으로 넓히지 않는다.
  - `timingSafe`를 별도 포트로 만들지 않는 이유: `apiTokenUseCases.ts:126`의
    `timingSafeEqualString(decryptSecret(stored.token), candidate)`는 두 호출이 한
    연산("복호화 후 상수시간 비교")이다. 포트가 이 연산을 통째로 흡수하면 평문 토큰이
    application 레이어에 잠시도 존재하지 않는다 — 두 포트로 쪼개면 그 이점이 사라진다.
  - `infrastructure/slack/verify.ts:30`의 `timingSafeEqualString`은 infrastructure
    내부 사용이라 위반이 아니다. 건드리지 않는다.
  - `app/api/a2a/[name]/route.ts:37`의 사용은 app 허용 목록 소관이므로 M3에서 처리한다.
- `UrlPolicy` 포트를 domain에 정의하고 application 4곳을 주입으로 전환한다.
  차단 시 `ValidationError`를 throw 하는 계약으로 정리해 `SsrfError`가 application에
  노출되지 않게 한다.
- 구체 구현 배선은 `lib/container.ts`에서만 한다. 기본 인자(default parameter)로
  구체 구현을 넣지 않는다 — 결합이 남는다.

**완료 조건**: `pnpm test`가 통과하고, `src/domain`에 임의의 상위 레이어 import를
넣으면 테스트가 실패한다.
`grep -rn "infrastructure/crypto\|ssrfGuard" src/application/ | grep -v "/index.ts:"`가
무결과다 — use case는 포트만 알고, 구현을 아는 것은 슬라이스의 조립 지점뿐이다.
application 허용 목록이 28건에서 21건으로 줄고, 목록에서 제거한 12건이
다시 들어오면 테스트가 실패한다. 12건을 걷어내면서 5건이 새로 생기는데
(`{agent,mcp,settings}/index.ts`가 주입할 포트 구현을 import한다) 이는 M2가 싱글톤을
`lib/container.ts`로 옮길 때 index 항목 11건과 함께 사라진다.
app 허용 목록은 7건으로 동결된 채이며(M3에서 비운다)
조립 지점 2곳은 목록에 없다. 마스킹 3단계 길이 티어, `enc:v1:` 접두사,
"마스킹된 값은 저장된 시크릿을 보존", "대응 저장값 없는 마스킹 값은 드롭",
"등록 시점과 dispatch 시점 양쪽 SSRF 검증", "차단된 MCP 서버는 skip하되 run은 계속"
동작이 그대로이며, `tests/registrySecrets.test.ts`·`tests/encryption.test.ts`·
`tests/projectUseCases.test.ts`·`tests/apiToken.test.ts`·`tests/projectSlack.test.ts`가
수정 없이 통과한다. `vi.mock("@/infrastructure/net/ssrfGuard")` 5건은 fake 주입으로
대체돼 사라진다.

---

## M2 — 컴포지션 루트 단일화

**이유**: 조립 지점이 네 갈래다 — `lib/container.ts`,
`application/{agent,mcp,skill,settings}/index.ts`, `app/api/chats/_deps.ts`,
`app/api/slack/events/_lib/handleEventRequest.ts`. 그중 넷은 application 레이어 안에서
DynamoDB repository 싱글톤을 생성하므로 `@/application/mcp`를 import 하면 AWS SDK가
전이 로딩되고, `application/skill/index.ts`가 재수출한 `skillRepository`는
`api/skills/sync/route.ts`까지 도달한다. 또한 `src/lib/`에는 infrastructure보다 위인
모듈(`container.ts`)과 아래인 모듈(`date.ts`, `slug.ts`)이 섞여 있어 lib→infra 3건,
infra→lib 12건의 양방향 의존이 성립한다. M5·M6이 새 실행 진입점을 추가할 때 따를
관례가 하나여야 한다.

**선행**: M1

**범위**

- `application/{agent,mcp,skill,settings}/index.ts`를 팩토리·타입 재수출만 남긴다.
  싱글톤 4개는 `lib/container.ts`로 옮기고 `skillRepository` 재수출을 제거한다.
- 라우트 11곳의 import를 `@/application/{slice}` → `@/lib/container`로 교체한다.
  `api/skills/sync/route.ts`는 repository를 직접 다루지 않고 container가 조립한 함수를 쓴다.
- `src/shared/` 신설 — 아무것도 import 하지 않는 leaf. `date`, `slug`, `withTimeout`,
  `runDeadline`, `lifecycle`, `generatedSecret`, `public-url` 이동.
- `lib/auth-adapter.ts`(347줄, DynamoDB 어댑터)를 `infrastructure/db/authAdapter.ts`로,
  `lib/sse.ts`·`lib/httpBody.ts`를 `app/api/_lib/`로 옮긴다.
- `lib/runtime-settings.ts`를 repository·cipher 주입 형태로 전환한다. 이 모듈을 그대로
  application으로 옮기면 이를 쓰는 infrastructure 4곳(`channel`, `imageChannel`,
  `probes`, `skillsRepoClient`)이 역방향 위반이 되므로, 해당 4곳이 container에서 설정을
  주입받는 형태로 함께 바꾼다. 프로세스 로컬 TTL 캐시(`DEFAULT_TTL_MS = 5_000`,
  `SETTINGS_CACHE_TTL_MS`로 재정의)와 `invalidateSettingsCache()` 동작은 유지한다.
- `settingsUseCases`의 `process.env` 직접 참조 5곳을 주입으로 전환한다.
- 중복 정리: `parseList` 3벌(`runtime-settings`, `settingsUseCases`, `config` 인라인 2곳)을
  `src/shared/`의 1벌로, 401 응답 생성 2벌(`lib/session.ts`, `_lib/executionAuth.ts`)을
  `app/api/_lib/http.ts`로 통합한다. 상수시간 비교도 2벌이다 —
  `infrastructure/crypto/timingSafe.ts`와 `lib/generatedSecret.ts:47`의 인라인 구현이
  같은 로직이고, `apiTokenUseCases`는 두 경로를 모두 쓴다(암호화 토큰은 전자,
  레거시 해시는 후자). `generatedSecret`이 `src/shared/`로 옮겨오는 이 시점에 1벌로
  합친다. M1이 만든 `SecretCipher` 구현도 그 1벌을 쓴다.
- `lib/`에는 `config.ts`와 `container/`만 남는다.
- 아키텍처 테스트에 규칙 2개 추가: `src/shared`는 어떤 `@/` import도 금지,
  infrastructure → `@/lib/container` 금지.

**완료 조건**: `grep -rn "@/infrastructure" src/application/*/index.ts`와
`grep -rn "from \"@/" src/shared/`가 모두 무결과다. application 허용 목록이 21건에서
10건으로 줄고(slice `index.ts` 11건 — repository 4, 포트 구현 5, 타입 재수출 2),
새 규칙 2개의 허용 목록은 비어 있다.
`pnpm build`가 통과해 라우트 핸들러
시그니처가 검증되며, 라우트의 응답 형태와 상태 코드가 그대로다(`api/skills/sync`의
502/503/500 분기 포함). `tests/runtimeSettings.test.ts`·`tests/settingsUseCases.test.ts`·
`tests/authAdapter.test.ts`·`tests/session.test.ts`가 수정 없이 통과한다.

---

## M3 — 아웃바운드 디스패치 포트화와 실행 파사드 정리

**이유**: 실행 함수가 `executeVersion`·`executeVersionStream`·`executeAgent`·
`executeProjectStream`·`generateImage` 다섯 개이고 호출처가 일곱 곳이라, 실행 경로에
정책을 하나 추가하려면 일곱 곳을 고쳐야 한다. M4(비용 가드)가 정확히 그 작업이다.
동시에 `runProject.ts`는 1340줄에 책임이 여덟 가지이며, 그중 `runRemoteSubagent`는
raw `fetch`로 A2A와 OpenAI 형태 HTTP를 직접 호출하는 순수 프로토콜 코드다. 이것이
application에 남은 infrastructure 의존의 대부분을 만든다.
라우트 쪽에도 같은 성격의 잔여물이 있다 — A2A 노출 판정이 라우트 4곳에 복제돼 있고,
`McpTool` 타입은 정의가 3벌로 갈려 이미 서로 어긋났다.

**선행**: M2

**범위**

- `RemoteAgentDispatcher` 포트를 domain에 정의하고 구현을 `infrastructure/agent/`로
  옮긴다. `a2a/client`, `agentClient`, `publicFetch` 의존이 여기로 흡수된다.
- `McpToolProvider` 포트를 정의해 `mcpClient`·`toolManager` 의존을 흡수한다.
- 타입 전용 위반 2건(`syncSkills`의 `SkillsRepoSnapshot`,
  `handleSlackEvent`의 `SlackMessage`)의 타입 정의를 domain으로 올린다.
- `McpTool` 정의 3벌을 domain 1벌로 통합한다. 이미 drift 했다 —
  `infrastructure/mcp/session.ts`는 `description?` + `inputSchema?`,
  `infrastructure/mcp/mcpClient.ts`는 `description` 필수에 `inputSchema` 없음,
  `app/tools/api.ts`는 클라이언트가 손으로 재정의한 3벌째다. 넓은 쪽(`session.ts`)을
  `domain/mcp/types.ts`로 올리고 나머지를 import로 교체한다. 좁히면 `session.ts`의
  `inputSchema` 사용처가 깨진다. `ListToolsResult`·`SendMessageResult`도 같은 기준으로
  판단해 domain 개념이면 올리고 어댑터 전용 표현이면 infrastructure에 남긴다.
- A2A 노출 판정을 use case로 추출한다. "published version 확인 → agent card 생성"이
  라우트 4곳(`api/a2a/route.ts`, `api/a2a/[name]/route.ts`,
  `api/a2a/[name]/.well-known/agent-card.json/route.ts`,
  `api/projects/[name]/a2a/route.ts`)에 복제돼 있고, 이들이 `resolveRunnableVersion`을
  우회해 `versionRepository.get(project.name, project.publishedVersion)`을 직접 호출한다.
  published-only 정책의 소유자는 `resolveRunnableVersion`이므로 use case가 그것을 쓴다.
  인증 없는 Agent Card 서빙(A2A 규약)은 그대로 둔다.
  `api/projects/[name]/slack/test/route.ts`의 `slackClient` 직접 호출도 함께 정리한다.
- `runProject.ts` 분해 — 외부 공개 표면(`executeVersion`/`executeVersionStream`/
  `executeAgent`/`executeProjectStream`/`ExecutionDeps`)은 불변:
  - `execution/deps.ts` — 타입
  - `execution/runProject.ts` — 진입점만
  - `execution/traceLifecycle.ts` — recorder 생성·샘플링·종료
  - `execution/imageTool.ts` — 이미지 툴과 이미지 서브에이전트
  - `execution/subagentRunner.ts` — 로컬/원격 라우팅과 가드
  - `execution/mcpTools.ts` — MCP 도구 해석과 세션 정리
- `buildImageGenerator`와 `runImageSubagent`에 중복된 usage 기록 블록
  (`textInputTokens + imageInputTokens` / `imageOutputTokens` / `calculateImageCost`)을
  한 함수로 통합한다.
- 실행 진입점을 수렴한다. 라우트·chat·Slack·A2A가 각자 다른 실행 함수를 고르지 않고
  단일 파사드에 프로젝트·버전·메시지를 넘기면 `projectType`과 stream 여부에 따라
  파사드가 분기하도록 한다. 이미지 생성 경로도 이 파사드 안으로 들어온다.
- `ConditionalCheckFailedException` → `AppError` 매핑 중복(registry 3, projectUseCases 2,
  versionUseCases 1, projectSlack 1)을 공용 헬퍼 하나로 통합하되, 각 호출부의 에러 메시지
  문자열과 HTTP 상태는 그대로 둔다.

**완료 조건**: application·app 허용 목록이 모두 비고, `tests/architecture.test.ts`에서 두
허용 목록 배열 자체를 제거해도 테스트가 통과한다(조립 지점 예외는 규칙에 남는다).
`grep -rn "interface McpTool" src/`가 domain 1건이고,
`grep -rn "versionRepository\.\|projectRepository\." src/app`이 무결과다. published version이
없는 프로젝트가 A2A 엔드포인트 4곳에서 동일하게 거부되는 것을 테스트 1개로 잠근다.
`wc -l src/application/execution/runProject.ts`가
250 이하다. 실행 정책을 추가할 지점이 파사드 한 곳이며, 이를 `git grep`으로 확인할 수 있다.
`git diff --stat tests/`가 비어 있는 상태로 `tests/runProject.test.ts`·`tests/mcpBindings.test.ts`·
`tests/imageGeneration.test.ts`·`tests/a2a.test.ts`·`tests/trace.test.ts`·
`tests/piiFiltering.test.ts`·`tests/usageAggregator.test.ts`가 통과한다.
`MAX_SUBAGENT_DEPTH=5`와 ancestry 순환 검사, 가드 위반을 tool error로 yield 하는 처리,
finally에서의 MCP 세션 정리, run 종료 시 usage 1회 flush, cancelled/error/정상 종료
3분기 판정, 서브에이전트 chunk 재-author 규칙이 모두 그대로다.

---

## M4 — 비용 임계값 알림 및 차단

**이유**: 프로젝트별·모델별 일간 비용은 집계되지만 이를 사용하는 보호 장치가 없다.
폭주하는 루프나 대량 호출자가 턴 제한 안에서 계속 비용을 발생시킬 수 있다.

**선행**: M3. 실행 진입점이 수렴되기 전에는 같은 가드를 일곱 곳에 중복 배치해야 하고,
한 곳을 빠뜨리면 우회 경로가 남는다.

**범위**

- 프로젝트별 `alertThresholdUsd`와 `blockThresholdUsd` 설정(선택 사항).
- 일간(UTC) 비용이 알림 임계값을 넘으면 조건부 쓰기로 하루 한 번 Slack 알림 전송.
- 차단 임계값을 넘으면 그날 남은 시간 동안 추가 실행 거부.
- 실행 파사드 진입 시 사전 검사하고 사용량 flush 후 사후 검사.
- 보호 장치 조회·쓰기 실패는 실행을 막지 않는 fail-open 처리.

**완료 조건**: 차단 임계값을 초과한 프로젝트는 UTC 기준 해당 날짜의 남은 시간 동안
모든 실행 진입점(predict, chat/completions, agent, chat, Slack, A2A, 이미지 생성)에서
거부되고, 알림은 하루에 정확히 한 번 발생한다. 임계값 초과·중복 제거·fail-open 동작을
테스트로 검증한다. 가드가 파사드 한 곳에만 있어, 진입점을 새로 추가해도 자동으로 적용된다.

---

## M5 — Webhook 트리거

**이유**: 현재 실행은 사용자 요청, Slack, A2A 호출에 의존한다. 외부 시스템이 이벤트로
published project를 실행할 수 있어야 운영 워크플로에 연결된다. Webhook은 기존 요청·응답
경계 안에서 처리되므로 새 인프라 없이 도입할 수 있다.

**선행**: M3

**범위**

- 프로젝트별 webhook 트리거 생성·활성화·비활성화.
- 프로젝트별 인증 URL과 secret. secret은 암호화 저장하고 조회 시 masking
  (M1의 `SecretCipher` 사용).
- 항상 published version만 실행. published version이 없으면 실행하지 않는다.
- 고정 입력과 trigger payload를 project variables 또는 agent message로 전달.
- `Idempotency-Key` 기반 중복 실행 방지.
- 동시 실행 시 중첩 허용 여부를 명시적으로 설정.
- 실행 상태, 시작·종료 시각, 결과·오류, `traceId`를 이력으로 저장.
- 콘솔에서 트리거 설정과 최근 실행 결과를 확인.

**완료 조건**: webhook 호출이 published version을 실행하고, 비활성 트리거와 published
version이 없는 프로젝트는 실행하지 않는다. 같은 `Idempotency-Key`가 재전달돼도 실행
이력이 중복 생성되지 않는다. 성공·실패·중복 제거·인증 실패·동시 실행 정책을 테스트로
검증하고, 콘솔에서 설정과 최근 실행 결과를 확인할 수 있다.

---

## M6 — 스케줄 트리거

**이유**: 정기 작업으로 published project를 실행할 수 있어야 한다. Webhook과 달리
단일 Next.js process 내부 timer로는 만족스럽게 구현할 수 없어 durable scheduler/worker
경계가 필요하며, 이 인프라 결정이 M5와 규모를 다르게 만든다.

**선행**: M5. 트리거 저장 구조, 실행 이력, 중복 제거 규약을 M5가 확정한다.

**범위**

- 실행 환경에 맞는 durable scheduler/worker 경계를 선택하고 그 결정을
  `docs/ARCHITECTURE.md`에 기록한다. **이 선택이 끝나기 전에는 구현에 착수하지 않는다.**
- 프로젝트별 schedule 트리거: cron expression과 timezone.
- 동일 schedule 시각의 중복 실행 방지(조건부 쓰기 기반).
- 실행 이력·중첩 정책은 M5의 구조를 재사용한다.

**완료 조건**: schedule이 published version을 지정 시각에 실행하고, 비활성 트리거는
실행하지 않는다. 여러 Agent Studio 인스턴스가 동시에 동작해도 동일 schedule 시각에
실행이 정확히 한 번 일어난다. 중복 제거·실패·재시작 후 복구를 테스트로 검증한다.

---

## M7 — Managed local MCP

**이유**: 현재 Tools에는 이미 실행 중인 public streamable-HTTP MCP server만 등록할 수
있다. 운영자가 승인한 MCP server를 Agent Studio가 배포하고 수명 주기를 관리하면 별도
MCP 인프라를 수동으로 운영하지 않아도 된다.

**선행**: M6. workload provisioner는 M6이 도입하는 durable worker 경계 위에서 동작한다.
이 마일스톤을 먼저 하려면 그 경계를 여기서 함께 정해야 하며, 그 경우 규모가 두 배가 된다.

**범위**

- 이 마일스톤은 런타임 어댑터를 **하나만** 구현한다. 배포 환경에서 실제로 쓰는 것을
  선택하고, 나머지는 어댑터 계약만 정의한 채 남긴다. 세 런타임을 동시에 구현하지 않는다.
- MCP 유형을 `remote`와 `managed`로 구분하고 기존 원격 등록 동작은 유지.
- managed MCP에는 승인된 artifact(image 또는 task definition), 실행 설정, resource limit,
  health check, secret reference를 저장한다. 임의 command·image 실행은 허용하지 않는다.
- 명시적 runtime 설정을 우선하고, 설정이 `auto`일 때만 실행 환경을 탐지한다.
- desired/observed 상태와 workload identity를 영속화하고, 조건부 쓰기·lease 기반
  reconciler로 여러 인스턴스의 중복 생성·삭제를 방지한다.
- 생성·시작·중지·재시작·삭제와 health/status 조회를 지원하고, 실패 원인과 최근 상태
  변경 시각을 콘솔에 표시한다.
- managed endpoint는 provisioner가 반환한 workload identity로만 신뢰한다. 일반 remote
  MCP의 SSRF 검증(M1의 `UrlPolicy`)을 우회하거나 임의 private URL 등록을 허용하지 않는다.
- 최소 권한 IAM/RBAC와 network policy를 적용하고, application container에 host Docker
  socket을 직접 노출하지 않는다.

**완료 조건**: 구현한 어댑터의 계약 테스트와 실제 runtime 통합 테스트에서 managed MCP를
생성해 `tools/list`와 `tools/call`을 수행하고 삭제할 수 있다. 두 Agent Studio 인스턴스가
동시에 reconcile해도 workload가 하나만 생성되며, 재시작 후 기존 workload를 재발견한다.
권한 부족·이미지 pull 실패·health check 실패·중복 요청·삭제 재시도를 검증하고,
remote MCP 동작과 SSRF 보호가 그대로 유지된다.

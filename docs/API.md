# API 레퍼런스

이 앱의 HTTP 계약: 안내 대상 라우트, 각각이 어떻게 인증하는지, 그리고 자명하지 않은
것들의 요청 / 응답 형태와 에러 케이스.

어떤 표면이 *왜* 이런 모습인지에 대한 설계 근거는
[ARCHITECTURE.md](ARCHITECTURE.md) 에 있고, 인가(authorization) 모델은
[SECURITY.md](SECURITY.md) 에 정리돼 있다.

빠른 찾기: [라우트 색인](#라우트-색인) · [Agent 설정](#agent-현재-설정) ·
[실행](#실행) · [Chat](#chats) · [Workspace](#workspaces) · [MCP OAuth](#mcp-oauth) ·
[Trigger](#triggers) · [Artifacts](#artifacts) · [Models](#models) ·
[오디오](#오디오-작업과-원본-파일).

`json` 블록은 JSON 예제다. 형태를 요약한 일반 코드 블록의 `?`는 선택 필드,
`…`는 생략한 내용을 뜻하며 그대로 전송하는 JSON이 아니다.

## 규약

- **Content type**: 따로 언급하지 않는 한 요청과 응답은 JSON 이다. 스트리밍 응답은
  `text/event-stream` 이다.
- **Auth**: 애플리케이션 라우트는 Better Auth 세션 쿠키를 요구한다 (Keycloak · 표준 OIDC · Google · 비밀번호
  중 배포가 켠 수단으로 로그인한다. 로컬 개발에서는 `scripts/dev-session.ts` 가 하나 출력해 준다). 세션이 없거나 유효하지 않으면 →
  `401 { "error": "Unauthorized" }`. 로그인 플로우 자체는 `/api/auth/*` 아래에 있다
  (Better Auth catch-all). 실행 엔드포인트 셋(`predict`, `chat/completions`,
  `agent`)은 세션 쿠키 대신 `Authorization: Bearer <token>` 으로 오는 **Agent별 API 토큰**도
  받는다. 토큰은 Agent 소유자를 대신해 동작하며 해당 Agent 범위로 한정된다
  (참고: [Agent API 토큰](#agent-api-토큰)). 기계 표면은 게이트가 다르다:
  `/api/slack/events/*` 는 Slack signing secret,
  `/api/telegram/webhook/*` 는 Telegram 이 되돌려 주는 secret token, `/api/teams/messages/*` 는 Bot
  Framework 가 서명한 토큰, `/api/webhook/{agent}` 는
  그 webhook 자신의 secret, `/api/triggers/scan` 은 배포의 `SCHEDULE_SCAN_TOKEN` 이다. `/api/health`, `/api/ready`, `/api/metrics` 는 열려 있다.
- **Origin**: 세션 쿠키로 인증하는 `POST`/`PUT`/`PATCH`/`DELETE` 는 `Origin` 이 요청 origin 또는
  `PUBLIC_BASE_URL` 의 origin 과 정확히 일치해야 한다. 헤더가 없거나 `null` 이거나 다르면
  `403 { "error": "Cross-origin mutation refused" }` 이다. Bearer token 과 서명된 기계 표면은
  각자의 자격 증명으로 보호되므로 이 검사를 적용하지 않는다.
- **Authorization**: agent 는 공개 범위를 갖는 공유 카탈로그다. `public`(기본값) 은
  로그인한 누구나 읽고 실행하고, `private` 은 소유자·초대 멤버·admin 만이다
  ([SECURITY.md](SECURITY.md#인가-모델), 그 외에는 `403 { "error": "Agent \"…\" is private" }`).
  변경(수정/삭제, Agent 설정 저장, Slack·Telegram 설정)은 공개 범위와 무관하게
  소유자와 effective admin(저장된 `admin` tier 또는 설정된 admin) 만 할 수 있고, 그 외에는
  `403 { "error": "You do not have permission to modify agent \"…\"" }` 이다.
  다른 사용자의 런타임 데이터나 마스킹된 secret 을 드러내는 agent 하위 리소스. 트레이스,
  Slack·Telegram 설정, API 토큰, trigger, 호출자별 사용량, MCP 연결. 은
  *읽기*도 소유자와 admin 으로 제한된다. Chat 은 소유자에게만 비공개다 (소유자가 아닌 읽기·변경은
  모두 404 를 돌려준다 — 403 은 chatId 의 존재를 알려 주는 답이다). MCP/skill/plugin 레지스트리와 모델 카탈로그(`/api/models/catalog`)는
  **`member` tier 이상**에게 읽기가 공유된다. 모든 가입자가 시작하는 tier 인 `guest` 는
  `403 { "error": "This resource is not available to your account" }` 을 받는다 (`withMemberAuth`).
  변경은 저장된 `admin` tier 이거나 `ADMIN_EMAILS` 목록에 속해야 한다. 목록이 설정되지 않았으면
  로그인한 사용자 누구나 허용하며, 그렇지 않으면
  `403 { "error": "Only admins can modify this resource" }` 이다.
  agent 생성도 마찬가지로 tier 능력이다: 그 능력이 없는 tier 는
  `403 { "error": "Your tier does not allow creating agents" }` 을 받는다.
- **Errors**: `{ "error": string }` 이고, 스키마 검증 실패에는 `issues` 배열이 추가로 붙는다.
  상태 코드: `400` (잘못된 입력), `401` (세션 없음), `403` (소유자/admin 아님),
  `404` (없음), `409` (이름 충돌), `413` (페이로드 과대), `429` (지금은 거절.
  아래 참조), `500` (처리되지 않음), `502` (이 앱이 호출한 상류가 실패), `503` (이 배포가
  설정하지 않은 기능 또는 일시적인 권한 저장소 장애), `504` (실행 deadline).
- **Retry-After**: `429` 는 항상 이 헤더를 초 단위로 실어 보낸다. 그 거절은 언제 더 이상
  참이 아니게 되는지를 안다. 일일 비용 차단은 00:00 UTC 까지 지속된다. 그래서 호출자가
  짐작해서 같은 벽에 다시 부딪히게 두지 않고 알려 준다.
- **List responses**: 리소스 컬렉션(`agents`, `skills`, `mcps`)은 벌거벗은
  배열을 돌려준다. `chats`, `models`, `usages/summary`, `triggers`, `connections` 는 각자의
  것을 객체로 감싼다 (`{ chats }`, `{ models }`, `{ items }`, `{ triggers }`, `{ connections }`).
- **Names** 는 일반적으로 slug (`^[a-z0-9-]+$`) 이며 생성·변경 입력은 `parseName` 또는 같은
  스키마가 검증해 `400` 으로 답한다. path parameter 의 조회는 리소스별 계약을 따른다: agent
  GET/PUT 은 찾지 못한 이름을 `404` 로 답하고 DELETE 는 잘못된 형식을 `400` 으로 거절한다.
  Plugin 이름은 별도의 Agent Plugins 규칙을 따른다.
- **SSE framing**: 일반 스트림은 `data: {json}\n\n`이며 정상 종료에는 `data: [DONE]\n\n`을 쓴다.
  예외로 끝난 스트림은 오류 프레임으로
  종료될 수 있으므로 `[DONE]`이나 정상 completion을 가정하지 않는다.
- **스트림 시작**: 첫 generator read를 최대 25초 기다려 초기 거절을 HTTP 상태로 응답할 수 있게 한다.
  이후 오류는 이미 보낸 상태를 바꾸지 못하고 프레임으로 전달한다. Chat은 즉시 head를 보내므로
  런의 admission 실패도 주로 스트림 오류다. [SSE 계약](ARCHITECTURE.md#sse-응답은-답하기-전에-첫-chunk-를-당겨온다)을 따른다.
- **Completion 종료**: 정상 완료한 `chat/completions`는 `finish_reason: "stop"`,
  턴·출력 한도로 끝나면 `"length"`를 보낸다. 오류·취소를 length로 바꾸지 않는다.

## 라우트 색인

`session` = Better Auth 세션 쿠키. `member` = 세션 + `member` tier 이상
(`withMemberAuth`. `guest` 는 403 을 받는다). `admin` = 세션 + 저장된 `admin` tier 이거나 유효
admin 목록에 속함(목록이 비면 모든 세션 사용자). `owner` = 그 agent 의 소유자, 저장된
`admin` tier, 또는 설정된 admin.

### Agents (`/api/agents`)

| 라우트 | 메서드 | 권한 |
|---|---|---|
| `/api/agents` | `GET` `POST` | session / session + Agent를 만들 수 있는 tier |
| `/api/agents/{name}` | `GET` `PUT` `DELETE` | session / owner |
| `/api/agents/{name}/clone` | `POST` | session + Agent를 만들 수 있는 tier |
| `/api/agents/{name}/configuration` | `GET` `PUT` | session / owner |
| `/api/agents/{name}/preview` | `POST` | member |
| `/api/agents/{name}/predict` | `POST` | session 또는 Agent 토큰 |
| `/api/agents/{name}/chat/completions` | `POST` | session 또는 Agent 토큰 |
| `/api/agents/{name}/agent` | `POST` | session 또는 Agent 토큰 |
| `/api/agents/{name}/token` | `GET` `POST` `DELETE` | owner |
| `/api/agents/{name}/token/reveal` | `POST` | owner |
| `/api/agents/{name}/artifacts` | `GET` | owner |
| `/api/agents/{name}/traces` | `GET` | owner |
| `/api/agents/{name}/traces/{traceId}` | `GET` | owner |
| `/api/agents/{name}/usage/actors` | `GET` | owner |
| `/api/agents/{name}/triggers` | `GET` `POST` | owner |
| `/api/agents/{name}/triggers/{trigger}` | `PUT` `DELETE` | owner |
| `/api/agents/{name}/triggers/{trigger}/reveal` | `POST` | owner |
| `/api/agents/{name}/triggers/{trigger}/runs` | `GET` | owner |
| `/api/agents/{name}/slack` | `GET` `PUT` `DELETE` | owner |
| `/api/agents/{name}/slack/test` | `POST` | owner |
| `/api/agents/{name}/slack/channels` | `GET` | owner |
| `/api/agents/{name}/telegram` | `GET` `PUT` `DELETE` | owner |
| `/api/agents/{name}/telegram/chats` | `GET` | owner |
| `/api/agents/{name}/telegram/test` | `POST` | owner |
| `/api/agents/{name}/telegram/webhook` | `POST` | owner |
| `/api/agents/{name}/teams` | `GET` `PUT` `DELETE` | owner |
| `/api/agents/{name}/teams/test` | `POST` | owner |
| `/api/agents/{name}/mcp-connections` | `GET` | owner |
| `/api/agents/{name}/mcp-connections/{server}` | `PUT` `DELETE` | owner |
| `/api/agents/{name}/mcp-connections/{server}/authorize` | `POST` | owner |
| `/api/agents/{name}/mcp-connections/{server}/tools` | `POST` | owner |

### 레지스트리

| 라우트 | 메서드 | 권한 |
|---|---|---|
| `/api/skills`, `/api/mcps` | `GET` `POST` | member / admin |
| `/api/skills/{name}`, `/api/mcps/{name}` | `GET` `PUT` `DELETE` | member / admin |
| `/api/plugins` | `GET` | member |
| `/api/plugins/{name}` | `GET` | member |
| `/api/plugins/sync` | `GET` `POST` | member / admin |
| `/api/plugins/sync/upload` | `POST` | admin |
| `/api/mcps/{name}/tools` | `POST` | member |
| `/api/mcps/{name}/auth` | `GET` `POST` `PUT` `DELETE` | admin |
| `/api/mcps/managed` | `POST` | admin |
| `/api/mcps/managed/{name}` | `GET` `PUT` `DELETE` | admin |
| `/api/mcps/managed/{name}/restart` | `POST` | admin |
| `/api/mcps/oauth/callback` | `GET` | session |
| `/api/mcps/oauth/client-metadata/{agent}` | `GET` | **공개** |

### Chat·사용량·플랫폼

| 라우트 | 메서드 | 권한 |
|---|---|---|
| `/api/chats` | `GET` `POST` | session |
| `/api/chats/{chatId}` | `GET` `DELETE` | 그 chat 의 소유자 |
| `/api/chats/{chatId}/messages` | `POST` | 그 chat 의 소유자 |
| `/api/chats/{chatId}/approval` | `GET` `POST` `DELETE` | 그 chat 의 소유자 |
| `/api/chats/{chatId}/runs/{runId}` | `GET` `DELETE` | 그 chat 의 소유자 |
| `/api/chats/{chatId}/runs/{runId}/stream` | `GET` | 그 chat 의 소유자 |
| `/api/artifacts` | `GET` | session |
| `/api/artifacts/{artifactId}` | `DELETE` | 생성자, agent 소유자, 또는 admin. 비공개 파일은 파일 소유자(member)의 현재 agent 소유 권한 필요 |
| `/api/artifacts/{artifactId}/view` | `GET` | 생성자, agent 소유자, 또는 admin. 비공개 파일은 파일 소유자(member)의 현재 agent 소유 권한 필요 |
| `/api/artifacts/{artifactId}/download` | `GET` | 비공개 파일 소유자(member), 현재 agent 소유 권한 필요 |
| `/api/usages/summary` | `GET` | session |
| `/api/models` | `GET` | session |
| `/api/models/favorites` | `GET` `PUT` `PATCH` | session |
| `/api/models/catalog` | `GET` | member |
| `/api/models/discover` | `GET` | admin |
| `/api/models/registry` | `GET` `POST` `DELETE` | member / admin |
| `/api/models/status` | `GET` | admin |
| `/api/models/default` | `GET` `PUT` | admin |
| `/api/models/test` | `POST` | admin |
| `/api/models/selection` | `PUT` | admin |
| `/api/models/decision` | `GET` `PUT` | admin |
| `/api/agent-recommendations` | `POST` | Chat: session / Workspace: member |
| `/api/models/workspace` | `GET` `PUT` | member / admin |
| `/api/me` | `GET` | session |
| `/api/me/profile` | `GET` | session |
| `/api/me/usage` | `GET` | session |
| `/api/members` | `GET` | admin |
| `/api/members/{id}/tier` | `PUT` | admin |
| `/api/settings` | `GET` `PUT` | admin |
| `/api/audit` | `GET` | admin |

### 비인증 / 기계 표면

| 라우트 | 메서드 | 게이트 |
|---|---|---|
| `/api/auth/{...all}` | `GET` `POST` | Better Auth 로그인 플로우 자신 |
| `/api/slack/events/{agent}` | `POST` | Slack signing secret |
| `/api/telegram/webhook/{agent}` | `POST` | `X-Telegram-Bot-Api-Secret-Token` |
| `/api/teams/messages/{agent}` | `POST` | Bot Framework bearer 토큰 |
| `/api/webhook/{agent}` | `POST` | `X-Trigger-Secret` 또는 GitHub `X-Hub-Signature-256` |
| `/api/workspaces/github/webhook` | `POST` | Workspace 전용 GitHub HMAC signature와 delivery ID |
| `/api/objects/{...key}` | `GET` | 주소의 서명 토큰 (`exp`, `sig`). 세션 없음 |
| `/api/triggers/scan` | `POST` | `X-Scan-Token` |
| `/api/catalog/reindex` | `POST` | `X-Scan-Token` |
| `/api/plugins/sync/scan` | `POST` | `X-Scan-Token` |
| `/api/health` | `GET` | 열림 |
| `/api/ready` | `GET` | 열림 |
| `/api/metrics` | `GET` | 열림 |

Workspace 경로는 [Workspaces 표](#workspaces), Agent별 오디오·원본 파일 경로는
[오디오 표](#오디오-작업과-원본-파일)에 모았다.

## Agent와 Skill·MCP CRUD

Skill과 MCP 레지스트리는 이름 기반 CRUD를 제공한다. 예 (skills):

```
GET    /api/skills            → 200 [ { name, description, source?, files, updatedAt }, … ]
GET    /api/skills/{name}     → 200 {…}                 | 404
POST   /api/skills            → 201 {…}                 | 409 (name exists) | 400
PUT    /api/skills/{name}     → 200 {…}                 | 404 | 400
DELETE /api/skills/{name}     → 204                     | 404
```

- 이름은 slug (`^[a-z0-9-]+$`) 다.
- `mcps` 는 `headers` 를 AES 로 암호화해 저장하고 마스킹해서 돌려준다 (길이 보존.
  9자 이상은 양끝 4자씩 드러낸다). 업데이트 때 마스킹된 값이나 빈 값은
  저장된 secret 을 보존한다. 이들의 `url` 은 SSRF 가드를 받는다.
  private/loopback/link-local/metadata 대상(또는 http(s) 가 아닌 scheme)은 `400` 으로 거절된다.
- `mcps` 는 선택적인 `content` (markdown 운영자 노트) 도 받는다. `description` 은 agent 런의
  서버 표에서 모델이 보는 한 줄 요약이고, `content` 는 콘솔 전용이라 모델에 절대 닿지 않는다.
- **managed** MCP 항목은 그것을 소유하지 않은 공유 레지스트리 라우트에서 거절된다:
  `DELETE /api/mcps/{name}` 은 `400` 이고 (`/api/mcps/managed/{name}` 을 통해 지워야 컨테이너가
  행과 함께 멈춘다), `url` 을 옮기는 `PUT` 도 `400` 이다. 그 주소는 프로비저너가 준다.
- `GET /api/skills` 는 요약을 돌려준다. `{ name, description, source?, files: count,
  updatedAt }`. 목록 페이지가 렌더링하는 것은 문서가 아니라 카드이기 때문이다. 전체 엔티티
  (markdown `content`, 첨부 `files[]` 자체) 는
  `GET /api/skills/{name}` 에서 온다. `source?` 는 repo 에서 sync 된 항목의 출처다. 예:
  `github:opspresso/agent-plugins#devops`. 그것을 선언한 repo 와 plugin.
- **`source` 를 가진 항목은 repo 소유이고, 콘솔은 그것을 두고 저장소와 경쟁하기를 거부한다
  (`403`)**: skill 은 `PUT`/`DELETE` 전부, MCP 항목은 `url`·`description`·`content` 와 그
  `DELETE` 다. headers 만 바꾸는 `PUT` 은 여전히 통과하는데, 인증 정보는 콘솔 소유이고 git 에
  들어가지 않기 때문이다 (OAuth 도 마찬가지). sync 된 managed 항목은 워크로드 필드
  (`image`, 포트, env) 를 계속 수정할 수 있다. repo 소유 항목의 삭제는 plugins sync 의 orphan
  선택을 거쳐 일어난다.
- `agents` 변경은 소유자 게이트를 받는다 (403). `POST /api/agents` 본문:

```json
{ "name": "my-bot", "displayName": "My Bot", "description": "",
  "departmentCode": "OPT-optional" }
```

생성 시 배포가 제공하는 첫 번째 호환 텍스트 모델로 초기 Agent 설정을 같은 Agent 행에
저장한다. 호환 모델이 없으면 미설정 Agent로 생성한다. 일반 Agent 응답은 시크릿을 포함한 설정 원문을 싣지 않고
`configured`로 설정 유무를 알린다. Agent 탭에 필요한 `audioToolsEnabled`와
`workspaceToolsEnabled`는 현재 설정에서 계산한 불리언이며 설정 원문은 노출하지 않는다.

#### 공개 범위와 복제

`PUT /api/agents/{name}` 은 공개 범위도 싣는다: `visibility: "public" | "private"` 와, private
일 때 의미를 갖는 초대 목록 `memberEmails: string[]` (통째로 대체, 저장 시 trim·소문자·중복
제거·소유자 제외로 정규화). 필드가 없는 기존 행은 public 이다. private agent 는 세션
기반의 모든 읽기·실행 표면에서 소유자·초대 멤버·admin 외에 403 으로 거절되고, 목록
(`GET /api/agents`) 에서는 보이지 않는다. 누가 게이트를 받고 누가 받지 않는지(API token,
bot, Slack 의 이메일 판정)는 [SECURITY.md](SECURITY.md#인가-모델) 가 정본이다.

`memberEmails` 는 초대받은 사람들의 주소이므로 모든 독자에게 노출하지 않는다. 단일 agent
GET 은 소유자나 effective configured admin 에게만 이 필드를 포함하고, 초대 멤버와 일반 독자에게는
필드 자체를 제거한다. agent 목록에서도 항상 제거한다. PUT 응답은 쓰기 권한을 지난 호출자에게
정규화된 목록을 돌려준다.

```
POST /api/agents/{name}/clone    { "name": "my-copy", "displayName": "My Copy" }
  → 201 { "agent": { … }, "warning": "…"? }
```

접근 가능한 agent 를 호출자 소유의 새 agent 로 복제한다. tier 게이트는 생성과 같다.
설명·부서 코드·공개 범위와 현재 Agent 설정을 복사한다. private 원본은 private으로 시작하며
초대 목록은 복사하지 않는다. MCP 헤더 오버라이드·endpoint fingerprint·bot 연동·비용 한도·
API token도 복사하지 않는다. 설정을 복사할 수 없으면 Agent는 미설정 상태로 만들어지고
`warning`이 이유를 알린다. 복제본의 설정도 저장되는 즉시 다음 실행에 적용된다.

#### 비용 한도

`PUT /api/agents/{name}` 은 그 agent 의 지출 가드도 함께 싣는다:

```json
{ "costLimits": { "alertThresholdUsd": 20, "blockThresholdUsd": 50,
                  "monthlyAlertThresholdUsd": 300, "monthlyBlockThresholdUsd": 500,
                  "alertDestinations": [
                    { "kind": "slack", "channelId": "C0123456789" },
                    { "kind": "telegram", "chatId": -1001234567890, "threadId": 7 },
                    { "kind": "teams", "conversationId": "19:conversation-id" }
                  ] } }
```

통째로 보낸다. 이 객체가 저장된 것을 대체하고, `null` 은 가드를 지우며, 필드를 생략하면
그대로 둔다. 부분 병합이면 "block 임계값은 없애고 alert 는 유지"를 표현할 수 없게 된다. 모든
임계값은 선택이고 서로 독립이다. 각 창(window) 안에서 alert 는 block 을 넘을 수 없다 (넘으면
alert 는 혼자서는 절대 발화하지 못하는데, block 이 거기 도달할 지출을 멈추기 때문이다).

지출은 agent 의 UTC-일 사용량 행에 있는 모든 모델의 `costUsd` 합이다. 일간 창은 한 행,
월간은 그 달의 행들을 합산한다. block 임계값에 도달하면 모든 실행 진입점이
`429 { "error": "Agent \"…\" has reached its daily cost limit …" }` (또는 `monthly`) 로
답하고, `Retry-After` 에는 창이 넘어갈 때까지의 초가 담긴다. 일간은 00:00 UTC, 월간은 다음 달
1일이다. 임계값을 넘으면 `alertDestinations` 에 선택한 Slack·Telegram·Teams 연동으로 창당
한 번 알린다. 플랫폼마다 목적지는 하나만 선택할 수 있고, 각 전송은 독립적으로 시도한다.
목적지나 연동이 없어도 임계값은 여전히 차단한다. 가드가 무엇을 한계 지우고 무엇은 그러지
못하는지는 [OPERATIONS.md](OPERATIONS.md#비용-가드-fail-open) 를 보라.

### Agent 현재 설정

```text
GET /api/agents/{name}/configuration
  → { configuration: AgentConfiguration | null, updatedAt }
PUT /api/agents/{name}/configuration
  { expectedUpdatedAt, systemPrompt, model, fallbackModel?, parameters,
    mcpList, skillList, subagentList, maxTurn? }
  → { configuration: AgentConfiguration, updatedAt }
```

읽기는 Agent 접근 권한을, 쓰기는 소유자 또는 effective configured admin 권한을 요구한다.
PUT은 현재 설정 전체를 대체한다. GET의 `updatedAt`을 `expectedUpdatedAt`으로 보내야 하며,
Agent 메타데이터나 설정의 동시 수정이 먼저 저장되면 409를 반환한다. 저장 결과의 `updatedAt`을
다음 수정에 사용한다. 저장한 설정은 다음 실행부터 적용한다.

`model`은 필수이며 Agent 도구 호출을 지원하는 텍스트 모델을 사용한다. `parameters`는
`temperature?`, `presencePenalty?`, `maxTokens?`, `reasoningEffort?`, `piiFiltering`,
`structuredOutput?`, `jsonSchema?`, `imageGeneration?`, `imageModel?`, `callerContext?`,
`urlFetch?`, `slackWorkspace?`, `audioProcessing?`, `workspaceTools?`, `dynamicCapabilities?`,
`memoryRecall?`, `reasoningTrace?`, `policy?`를 갖는다. 카탈로그에 있는 모델의 능력과
설정이 충돌하면 400이다. 카탈로그에 없는 사용자 모델은 경고 대상으로 둔다.
`imageModel`은 이미지 생성 능력이 있는 카탈로그 모델이어야 한다.

`mcpList[{name, headers?, tools?, sourceOutputs?}]`, `skillList[]`,
`subagentList[{name, type: "local"|"remote"}]`는 전체 목록을 저장한다.
새 참조는 존재·접근 권한을 검사하며, 이미 연결한 항목이 사라져도 다른 설정을 수정할 수 있다.
동일한 MCP·Skill·Agent 이름의 중복은 거절한다. 선택 필드 `fallbackModel`·`maxTurn`은 생략해
해제하며 `null`을 받지 않는다. 응답의 MCP 헤더는 마스킹하고 내부 endpoint fingerprint는 숨긴다.

새 실행은 저장한 설정을 사용한다. 시작한 실행과 제출한 Audio 작업은 당시 설정을 보존한다.
승인 대기 중 설정·연결이 바뀌면 재개를 거절한다. `policy`의 입력 크기·차단·승인 규칙은
[Chat 승인과 재개](#chat-승인과-재개)를 따른다.

실행 옵션은 다음 경계를 가진다.

| 옵션 | HTTP 계약에 영향을 주는 점 |
|---|---|
| `callerContext` | 세션 사용자·메신저의 확인된 표시 문맥을 모델에 전달한다. token·자동화가 사람을 대신해 이름을 만들지는 않는다 |
| `dynamicCapabilities` | 요청별 capability를 추가 검색한다. 명시적 binding은 유지하고 미구성·검색 실패는 warning, 발견 결과는 별도 `discovered`다 |
| `memoryRecall` | 명시적 MCP binding의 허용된 recall을 실행 전에 호출한다. 대상 부재·실패는 warning이다 |
| `audioProcessing` / `workspaceTools` | 해당 builtin의 사용을 요청한다. 배포 준비와 실행 주체의 권한 검사를 별도로 통과해야 한다 |
| `reasoningTrace` | 화면에 reasoning을 내보내고 Chat에 보관한다. provider 이력과는 별개다 |

preview의 선택적 `message`는 최대 8,000자이며 recall과 capability 검색의 질의다.
Agent preview의 사용자 턴으로 삽입되지는 않는다.
요청이 없으면 recall을 생략하고 시스템 프롬프트로 검색하며 빠진 문맥을 알린다.
자세한 준비 순서는 [Capabilities](design/capabilities.md),
PII 필터 이전의 전송 범위는 [SECURITY](SECURITY.md#pii-필터링-그리고-그것이-멈추는-곳)를 따른다.

#### MCP 바인딩과 Agent 헤더 오버라이드

각 `mcpList` 항목은 Agent를 레지스트리의 MCP 서버에 바인딩한다. URL 은 언제나
레지스트리의 것이고 헤더만 재정의할 수 있다. 그래서 같은 서버를 두 번 등록하지 않고도 서로 다른
agent 에서 서로 다른 인증 정보로 호출할 수 있다. `tools` 는 그 서버의 도구 중 런이 제공할
것을 좁힌다 (없거나 비어 있으면 = 전부).

```json
{ "mcpList": [
  { "name": "shared-mcp",
    "tools": ["search", "fetch"],
    "headers": { "Authorization": "Bearer agent-token", "X-Tenant": "acme", "X-Shared": null } }
] }
```

- 문자열 값은 레지스트리 기본값을 대체하거나 새 헤더를 더한다. `null` 은 이 Agent에 한해
  레지스트리 기본값을 제거한다. HTTP 헤더 이름이 그렇듯 매칭은 대소문자를 가리지 않는다.
- `X-Tenant-Id`, `X-User-Email`, `X-Conversation-Id` 는 **예약돼 있다**. 세 header 의 모든
  표기가 병합 후에 버려진다. 첫째 자리에는 호출하는 agent 의 이름이 찍힌다. 둘째 자리에는
  actor 가 `user` 또는 `agent-token` 일 때 그 actor 의 email 이 찍힌다. Slack 처럼 actor id 와
  별도로 사용자 email 을 해석한 표면은 그 주소를 찍고, 주소를 알 수 없으면 header 자체가 없다.
  셋째 자리에는 런이 대화를 가질 때 그 런의 대화 키가 찍힌다. 따라서
  레지스트리나 바인딩은 다른 agent, 사용자, 대화를 사칭할 수 없다.
  [SECURITY.md](SECURITY.md#mcp-서버가-호출자에-대해-듣는-것) 를 보라.
- 새 바인딩에서 `headers`를 생략하면 레지스트리 헤더를 쓴다. 기존 바인딩을 수정할 때 생략하면
  저장된 오버라이드를 보존한다. `{}`를 명시하면 오버라이드를 지우고 레지스트리 헤더를 쓴다.
  도구 조회는 마스킹된 값을 현재 Agent의 같은 서버 바인딩에 연결하며, 저장한 credential을 사용한다. 다만 이 probe는 런의 tenant header를 보내지 않으므로
  tenant별 도구 목록을 제공하는 서버에서는 결과가 다를 수 있다.
- `mcpList` 항목은 `{ "name": "shared-mcp" }` 형태의 객체다. 서버 이름 문자열만
  보내면 설정 검증에서 거절한다.
- 오버라이드 값은 저장 시 AES 로 암호화되고 마스킹돼 돌아온다 (레지스트리 헤더와 같은 규칙).
  업데이트 때 마스킹된 값이나 빈 값은 저장된 secret 을 보존하고, 저장된 짝이 없는 헤더 아래의
  마스킹된 값은 버려진다. `null` 표식은 그대로 돌아온다. 제거는 secret 이 아니다.
- 문자열 오버라이드는 저장 당시 registry URL 의 내부 fingerprint 에 묶인다. 같은 이름의 서버가
  다른 URL 로 옮겨지면 옛 값은 전송하지 않고 warning 을 내며, 현재 endpoint 용 값을 다시
  입력해야 한다. fingerprint 는 API 응답과 입력에 노출하지 않는다.
- 오버라이드 편집은 다른 모든 Agent 설정 쓰기와 마찬가지로 소유자와 admin 으로 제한된다.

도구 준비·최종 선언 상한은 [CONFIGURATION](CONFIGURATION.md#코드에-고정된-제한)을 따른다.
제외한 도구는 warning으로 알린다. 파일 응답용 `sourceOutputs`는 [오디오 계약](#오디오-작업과-원본-파일)에 있다.

### 프롬프트 미리보기

```
POST /api/agents/{name}/preview
  { …an unsaved Agent configuration…,
    "message": "request to preview"? }
→ 200 { messages: [ { role, content } ], … }
```

에디터 안의 초안이 **보냈을** 것을 조립한다. 시스템 프롬프트, skill 표, 연결된 MCP 서버 표,
도구 선언을 포함한다. 답변 모델은 호출하지 않는다. `message`가 있으면 설정에 따라 read-only memory
recall과 capability discovery를 실제로 수행하므로 MCP와 embedding·rerank 서비스에는 요청할 수 있다.

소유자 게이트가 아니라 member 게이트다 (`withMemberAuth`): 조립된 텍스트는 해석된 skill 과
MCP 서버의 이름을 담는다. `guest` 가 거절당하는 바로 그 레지스트리다. 그래서 세션만이 아니라
그 단 뒤에 놓인다. 초안의 MCP 바인딩은 등록된 서버에 선택한 헤더를 붙일 수 있지만, 그것은 이
게이트가 따로 챙길 수 있는 권한이 아니다. 어떤 member 든 자기 agent 에서 같은 레지스트리
서버를 같은 헤더로 바인딩한다. 마스킹된 헤더는 같은 서버 이름에 대한 이 agent 의 저장된
바인딩에 대해서만 해석되므로, 소유자가 아닌 사람의 미리보기는 그가 이미 시작할 수 있는 런이
보내지 않을 것을 아무것도 보내지 않는다. Memory도 그 agent의 런이 같은 사용자 identity로
회상할 내용이다. URL은 언제나 레지스트리에서 오므로 SSRF 표면은 런의 것이다.

## 앱 설정

```
GET /api/settings → 200 { fields: { <key>: { value, source, secret } },
                          serviceLogos: string[],
                          llmProviders: { source, items: [ { name, baseUrl, apiKey, keepModelPrefix, auth } ] },
                          updatedAt? }
PUT /api/settings → 200 {…same shape…} | 400
```

- 두 동사 모두 admin 전용이다. GET 의 `fields` 키는 `serviceName`, `serviceLogo`,
  `catalogMinScore`, `maxConcurrentRunsPerActor`, `s3PublicBaseUrl`, `slackLoadingIndicator`,
  `adminEmails`, `allowedEmailDomains`,
  `embeddingModel`, `rerankerModel`, `rerankerMinScore`, `pluginsRepo`,
  `pluginsRepoBranch`, `githubToken`, `publicBaseUrl`, `artifactAccessMode`,
  `unknownModelPolicy`다. Embedding/Rerank 선택 세 필드와 `catalogMinScore`는 이 API에서 읽기 전용이며
  `PUT /api/models/selection` 으로 변경한다. PUT 이 받는 `artifactAccessMode`
  (`authenticated` | `proxied` | `public` | `""`)와 `unknownModelPolicy`
  (`allow` | `refuse` | `""`)는 enum 으로 검증된다.
  `pluginsRepo` 는 자기만의 형태를 가진 나머지 하나의 키다. `owner/repo`, 또는 비우면
  지운다. `serviceLogo`는 이 배포에 필요한 파일이 모두 있는 브랜드 폴더만 허용한다.
  `maxConcurrentRunsPerActor`는 0–1000의 정수다.
  `s3PublicBaseUrl`은 자격증명·query·fragment 없는 HTTP(S) URL이고,
  `slackLoadingIndicator`는 최대 80자의 한 줄이다. 빈 값은 각 env 폴백을 복원한다.
  나머지는 길이가 제한된 문자열이다.

- PUT의 `llmProviders`는 최대 50개의 전체 교체 목록이다. 각 항목은
  `{ name, kind?, baseUrl, apiKey, auth?, keepModelPrefix? }`다. `name`은 고유한 소문자 식별자,
  `kind`는 지원 프로바이더 종류다. 빈 배열은 모든 연결을 비활성화한다.
  마스크나 빈 키는 같은 endpoint·종류·인증 방식의 기존 키를 유지한다. Self-hosted 연결은
  키를 생략할 수 있다. 등록된 모델이 남은 프로바이더를 삭제하는 요청은 거절한다.
- 모델 등록과 사용 설정은 아래 [Models API](#models)를 사용한다. 일반 설정 API는
  `registeredModels`·`defaultModel`·검색 모델 선택을 직접 변경하는 요청을 거절한다.
- `source` 는 `override` (DB) | `env` | `default` | `unset` 이다. secret 값은 언제나 마스킹된다
  (길이 보존. 9자 이상은 양끝 4자씩 드러낸다). PUT 의 마스킹된 값은 저장된
  secret 을 유지하고, 빈 문자열은 오버라이드를 제거한다 (env 폴백). 호출자를 제외하는 목록으로
  `adminEmails` 를 설정하는 것은 `400` 으로 거절된다. 비어 있지는 않은데 파싱하면 항목이 하나도
  없는 `adminEmails`·`allowedEmailDomains` 값(`","`)도 마찬가지다: 오버라이드 제거는 빈 문자열이
  하는 일이고, 저것을 같은 것으로 읽으면 배포가 게이트 없이 남는다.

## 감사 기록

```
GET /api/audit?from=2026-08-01&to=2026-08-03&limit=50&cursor=<opaque>
  → 200 { events: [ { eventId, actorEmail, action, target, detail?, createdAt } ], nextCursor: string | null }
```

- admin 전용이다: 행들이 사람의 이름을 담는다. `from` 의 기본값은 오늘, `to` 의 기본값은
  `from` 이며 둘 다 UTC 일(`YYYY-MM-DD`)이다. 범위는 최대 **31일**이다. 행은 하루에 파티션
  하나로 저장되고 같은 방식으로 읽히므로, 폭이 곧 쿼리 수다. 잘못된 형식의 날짜, 달력에 없는
  날짜(`2026-02-31`, `2026-13-01`), 뒤집힌 범위, 또는 그보다 넓은 범위는 `400` 이다. 폭은
  범위를 열거해서가 아니라 날짜에서 바로 거절하므로, 터무니없는 폭도 다른 거절과 같은 비용이다.
- 결과는 최신순으로 한 번에 최대 50건이다. `limit`의 기본값과 상한은 50이다.
  `nextCursor`가 있으면 같은 날짜 범위와 함께 다음 요청의 `cursor`로 전달한다.
  cursor가 잘못됐거나 요청 범위 밖이면 `400`이다. 날짜가 바뀌면 cursor 없이 첫 페이지부터 읽는다.
  `action` 은 `secret.reveal` | `secret.rotate` | `secret.revoke` |
  `agent.admin-override` | `settings.update` | `agent.delete` | `catalog.install` |
  `catalog.remove` | `registry.delete` |
  `registry.adopt` (plugins sync 가 다른 출처가 만든 항목을 넘겨받는 것) |
  `artifact.delete` (다른 사람의 artifact) | `member.set-tier` 중 하나다. `target` 은
  `kind:name` 이다.
- **구조상 읽기 전용이다.** 여기에도 다른 어디에도 쓰기 동사는 없다. 행은 행위 자체가 덧붙이고
  TTL(`AUDIT_RETENTION_DAYS`)로 만료된다. `detail` 은 인증 정보를 절대 싣지 않는다: 설정 쓰기는
  어떤 키가 움직였는지를 기록하고 그 값은 절대 기록하지 않는다.

## 뷰어

```
GET /api/me → 200 { email, isAdmin, isConfiguredAdmin, tier }
```

`tier` 는 그 멤버의 tier 이고, 그래서 콘솔은 tier 범위의 행동(agent 생성)을 라우트가 강제하는
것과 같은 `tierMay*` 술어로 게이트한다. 두 플래그를 다 보내는 이유는 서로 다른 질문에 답하고
콘솔이 둘 다 필요로 하기 때문이다:
`isAdmin` (공유 레지스트리와 앱 설정을 변경해도 되는가, 저장된 `admin` tier 이거나 빈
`ADMIN_EMAILS` 는 허용) 과 `isConfiguredAdmin` (남이 소유한 agent 를 써도 되는가, 저장된
`admin` tier 이거나 목록에 있으면 허용. 빈 목록만으로는 아무도 추가하지 않음) 이다. 둘 다 브라우저에서
유도할 수 없고, 하나를 다른 하나에서 추론한 것이 한때 로그인한 모든
사용자에게 저장 시 403 이 나는 편집 폼을 내주었던 원인이다.
[SECURITY.md](SECURITY.md#isadminemail-vs-isconfiguredadmin) 를 보라.

```
GET /api/me/profile
  → 200 { member: { id, name, email, image, tier, joinedAt, lastLoginAt },
          monthToDateUsd }

GET /api/me/usage?from=2026-08-01&to=2026-08-13
  → 200 { items: [ { email, agentName, date, calls, inputTokens, outputTokens, cachedTokens, costUsd } ] }
```

로그인한 사용자 자신의 행과 지출이다. 언제나 세션 사용자이므로 둘 다 이메일을 받지 않고 둘 다
추가 게이트가 필요 없다. `monthToDateUsd` 는 tier 상한이 한계 짓는 값(UTC 월 1일 이후의 지출)이며,
서버 측에서 계산된다. 그래서 페이지의 선택기가 어떤 범위로 맞춰져 있든 가드가 동의하지 않을 총액을
보고할 수 없다.

`/api/me/usage` 는 프로필의 차트와 표 뒤에 있는 범위 읽기다: UTC 일마다 *agent 별* 한 행,
지표는 모델별 맵, 그리고 사용량 요약이 쓰는 것과 같은 범위 검증(`from`/`to` 필수, 최대 184일)이다.
행에 agent 가 있으므로 프로필은 한 사람 자신의 지출을 agent·모델·프로바이더별로 묶을 수 있다.
개요와 agent 의 사용량 탭이 갖는 것과 같은 컨트롤이다. 여기 세는 지출은 그 멤버 자신의 콘솔
런(`user:` actor)이다. agent 토큰 런은 이 예산이 아니라 자기 agent 에 지출한다. tier 가
무엇을 상한 짓는지는 `src/domain/member/tiers.ts` 의 `TIER_LIMITS` 이고, 클라이언트가 그것을
직접 import 한다.

## 멤버

```
GET /api/members
  → 200 { members: [ { id, name, email, image, tier, joinedAt, lastLoginAt,
                       tierLocked } ] }

PUT /api/members/{id}/tier
  { tier: "admin" | "member" | "guest" }
  → 200 { id, name, email, image, tier, joinedAt, lastLoginAt }
  → 400 unknown tier · 403 ADMIN_EMAILS tier is locked · 404 no such member
```

admin 전용이다. 멤버는 이 워크스페이스에 로그인한 적이 있는 Better Auth 사용자이고,
`joinedAt` 최신순으로 정렬된다. `lastLoginAt` 은 새 세션이 만들어질 때 갱신된다. 로그인 추적이
도입되기 전에 만들어진 사용자는 다음 로그인에 성공할 때까지 `null` 이다.

`tier` 는 모든 가입에 대해 `guest` 가 기본값이다 (tier 가 존재하기 전에 쓰인 행도 `guest` 로
읽힌다). `ADMIN_EMAILS` 에 있는 주소는 로그인 시점이나 다음 멤버/프로필 읽기에서 저장 tier
`admin` 으로 승격된다. 목록에 남아 있는 동안 `tierLocked` 는 true 이고 업데이트 라우트는 변경을
거절한다. 주소를 목록에서 빼도 자동으로 강등되는 일은 없다. 평범한 tier 변경은 이전 → 이후를
기록하는 `member.set-tier` 감사 행을 쓴다. tier 가 무엇을 허용하고 상한 짓는지는
`src/domain/member/tiers.ts` 의 `TIER_LIMITS` 이고, tier `admin` 이 `ADMIN_EMAILS` 와 어떻게
합쳐지는지는 [SECURITY.md](SECURITY.md#isadminemail-vs-isconfiguredadmin) 에 있다.

## Chats

Chat 은 소유자에게만 비공개이고, agent 에 대해서만 실행된다.

```
GET    /api/chats?kind=chat|workspace&limit= → { chats, hasMore }
POST   /api/chats                            { agentName, firstMessage, images?, documents? } → SSE
GET    /api/chats/{chatId}?sinceSeq=         → { chat, messages, activeRun?, pendingApproval? }
DELETE /api/chats/{chatId}                   → 204
POST   /api/chats/{chatId}/messages          { content, images?, documents? } → SSE
GET    /api/chats/{chatId}/runs/{runId}/stream → SSE
GET    /api/chats/{chatId}/runs/{runId}      → { active }
DELETE /api/chats/{chatId}/runs/{runId}      → { cancelled }
```

두 목록 읽기 모두 범위를 좁힐 수 있고, 사이드바와 스레드가 실제로 그렇게 읽는다. `limit` 은
최신 순으로 몇 개인지이며 기본값과 상한은 `CHAT_PAGE` / `MAX_CHAT_PAGE`
(`src/domain/chat/repository.ts`) 가 정한다. `hasMore` 가 참이면 더 큰 `limit` 으로 다시
묻고, 상한에 닿으면 거짓이 되어 멈춘다(커서가 아닌 이유는 [design/chat.md](design/chat.md#사이드바와-스레드가-읽는-범위)).
`kind` 는 선택 사항이다. `chat`은 `workspaceId`가 없는 Chat, `workspace`는 그 필드가 있는 Chat을
조회하며 종류 필터는 `limit` 전에 적용된다. 사이드바는 탭별로 `limit`과 `hasMore`를 관리한다.
`sinceSeq` 는 그 시퀀스 *다음* 부터의 메시지만 돌려준다. 런이 끝났을 때 스레드가 묻는 것이고,
없으면 전체 기록을 읽고 그 안의 이미지·파일 주소를 매번 다시 서명한다. `sinceSeq=0` 은 "없음"이
아니라 유효한 경계다(첫 메시지의 시퀀스가 0 이다).

생성·메시지 전송 스트림은 `{ chat?, runId, userSeq, elapsedMs }` head로 시작하며
새 Chat은 `chat.chatId`를 포함한다. replay head는 `{ runId }`, 승인 재개는
`{ runId, elapsedMs }`다. 실행의 전송 구간은 `{ "ended": true }`로 닫힌다. 끝난 런과 끊긴 연결을 구별해 주는 것은 그
마지막 프레임뿐이다. 그냥 멈춘 본문은 둘이 똑같아 보인다. head 프레임은 런이 무언가를 내놓기
전에 나가므로 응답은 즉시 `200 text/event-stream` 으로 확정된다: 모델의 첫 토큰이 1분 뒤에
나오더라도 클라이언트는 언제나 `chatId`/`runId` 를 알게 되고, 런 자신이 일으킨 거절(일일 비용
가드, 동시성 가드)은 `429` 가 아니라 그 스트림의 `{error}` 프레임으로 도착한다. 그 밖에는
스트림은 표준 SSE framing 을 쓰고 사용자·어시스턴트·도구·이미지 표시 데이터를 저장한다.
현재 Agent 설정이 없는 agent는 `400` 으로 거절된다.

**런은 자신을 시작한 연결보다 오래 산다.** 끊는 것은 읽는 사람이 떠났다는 뜻이지 멈추라는 뜻이
아니다: 어느 쪽이든 런은 끝까지 가고 저장된다. `GET /api/chats/{chatId}` 는 런이 진행 중인
동안 `activeRun: { runId }` 를 알려 주고,
`GET /api/chats/{chatId}/runs/{runId}/stream` 은 그 런의 남아 있는 bounded 로그를 재생한 뒤
실시간으로 따라간다. 언제나 처음부터이므로 유지할 커서가 없다. 다만 읽는 사람이 붙어 있는
동안 런은 아무것도 기록하지 않으므로, 같은 런의 *두 번째* 관람자는 첫 번째가 연결을 끊을 때까지
아무 내용도 보지 못한다. 스트림은 멈춘 것처럼 보이는 대신 그렇다고 말해 준다.

`GET /api/chats/{chatId}/runs/{runId}` 는 `{ active }` 로 답한다. 그 런이 아직 그 chat 을
쥐고 있는지다. 스트림이 `{ "ended": true }` 프레임 없이 끝난 뒤 읽는 사람이 묻는 것이 이것이다:
다시 연결할지, 아니면 대화에서 답을 가져올지. `GET /api/chats/{chatId}` 도 `activeRun` 으로 같은
질문에 답하지만 스레드 전체를 실어 보내며 그 안의 모든 이미지에 서명까지 한다. 이미 나쁘다고
알려진 연결에서 id 하나를 비교하려고 보내기엔 너무 많다.

`DELETE /api/chats/{chatId}/runs/{runId}` 는 런을 일찍 끝내는 유일한 방법이다. 요청을 기록하고
`{ cancelled: true }` 로 답한다. `{ cancelled: false }` 는 런이 이미 끝나 있었다는 뜻이고, 그것은
에러가 아니다. 두 런 라우트 모두 UUID 가 아닌 `runId` 는 `400` 으로 거절한다. 중단된 런은 끝난
런처럼 마무리된다. 스트리밍된 것은 저장되고, 스트림은 `{ "ended": true }` 로 닫히며, 읽는
사람은 `error` 가 아니라 `warning` 프레임을 받는다.

`images` 는 사용자의 첨부를 인라인 바이트로 담은 것이다. `[ { b64, mimeType } ]`, 턴당 최대
4개, 각각 5MB, `image/png|jpeg|gif|webp`. `b64`는 padding을 붙이거나 생략한 canonical base64여야 한다.
마지막 문자에서 사용하지 않는 비트는 0이어야 한다.
모델에는 content part 로 닿고, (오브젝트 스토리지가
설정돼 있으면) 사용자 메시지에 **object key** 로 저장된다. 읽기는 그 응답을 위해 서명된 URL 로
답하며, 그 뒤로도 계속 동작하는 URL 은 절대 아니다. 주소를 만들 수 없는 이미지는 깨진 채로
돌아오는 대신 메시지에서 빠진다.

`documents` 는 보는 것이 아니라 읽는 파일이다. `[ { b64, mimeType, name } ]`, 턴당 최대 4개,
각각 10MB이며 `b64`는 이미지와 같은 형식으로 검증한다: PDF 와 텍스트, Markdown, CSV/TSV, JSON, YAML, XML,
HTML, DOCX, XLSX, PPTX, HWP/HWPX, ODT/ODS/ODP, RTF 이다. Office 형식은 내장 문서 엔진이 읽으며 MCP 등록이나 Agent binding을 요구하지 않는다.
파싱이 실패하면 추출 실패 warning을 돌려준다. 저장된 원본의 참조는 유지한다. `name` 은 필수이고,
`mimeType` 이 `application/octet-stream` 일 때. 업로드는 흔히 이렇게 도착한다. 판단을 떠맡는다.
읽을 수 없는 타입은 `400` 으로 거절된다. 서버는 **텍스트**를 추출하고. PDF 의 텍스트 레이어,
텍스트 파일의 내용. 턴은 그것을 싣는다. Chat은 오브젝트 저장소가 구성돼 있으면 원본도 artifact로
보관하며, 사용자 메시지에 `documents: [ { name, text, note?, file? } ]`을 저장한다.
`file`은 artifact ID와 오브젝트 키를 가진 참조이고, 조회 시 키 대신 서명된 다운로드 URL을 제공한다.
원본 바이트는 메시지 행이나 모델 문맥에 넣지 않는다. 저장 실패·미구성은 warning으로 알린다. 후속 질문이
여전히 그 문서를 갖고 있게 해 주는 것이 이것이다. 문서당 최대 20,000자, 한 턴 통틀어 40,000자를
보관한다. 빠진 것은 `warning` 으로 보고되고, 아예 읽을 수 없었던 문서(텍스트 레이어가 없는 스캔,
암호로 보호된 PDF)도 마찬가지다.

한 턴에는 텍스트나 두 종류 중 하나의 첨부가 최소 하나는 있어야 한다 (전부 비면 → `400`). 턴을
싣는 모든 라우트(chat 라우트 둘, `predict`, `agent`, `chat/completions`)는 요청 본문을
정당한 턴이 가질 수 있는 최대치(모든 첨부가 각자의 한도에 산문이 들어갈 여유를 더한 것)로
제한하고 그것을 넘으면 `413` 으로 답한다. 본문이 메모리에 올라온 뒤가 아니라 선언된 길이로 미리
검사한다. 레지스트리와 Agent 설정 편집은 skill 의 전체 파일 묶음 무게에 맞춰 훨씬 더 빡빡하게
제한된다.

chat 읽기(`GET /api/chats/{chatId}`)는 각 문서의 `name`, `note`와 다운로드용 `file?`을 돌려주고 `text`는 비운다:
추출문은 수신 시 모델 입력에 포함되고 이후 SDK Session이 그 입력을 재생한다.
화면용 문서 행에서 모델 이력을 다시 만들지 않는다.

### Chat 승인과 재개

Agent의 `parameters.policy`에는 `maxInputChars`(1–1,000,000), `blockedTools`,
`approvalTools`를 지정할 수 있다. 도구 이름은 Prompt preview의 공개 이름이며 각 목록은
최대 128개다. Handoff 이름은 `approvalTools`에 넣을 수 없고, 승인할 위임은
`delegate_<name>`을 사용한다. 승인 정책은 영속 Chat 실행에서 지원한다.

`GET /api/chats/{chatId}/approval`은 `{ pending: null }` 또는 다음 형태로 응답한다.
`GET /api/chats/{chatId}`의 `pendingApproval`도 같은 pending 값을 가진다.

```json
{
  "pending": {
    "revision": 2,
    "status": "pending",
    "approvals": [{ "id": "<64자리 hex id>", "agent": "assistant", "tool": "SaveFile", "arguments": "{...}" }]
  }
}
```

`POST /api/chats/{chatId}/approval`은 다음 결정을 받고 실행을 SSE로 재개한다.
한 번에 일부 승인만 결정할 수도 있다. 새 사용자 메시지는 추가하지 않으며 head에는
`runId`와 `elapsedMs`가 있고 `userSeq`는 없다. 재개된 실행도 연결과 분리되어 끝까지 진행한다.

```json
{ "revision": 2, "decisions": [{ "id": "<승인 항목 id>", "approve": true }] }
```

`approve: false`는 도구 실행을 거절하고 SDK가 그 결과로 답을 이어가게 한다.
승인 전에 도구는 실행되지 않는다. 다른 소유자는 `404`, 부정확하거나 중복된 항목은 `400`,
이미 소비된 revision이나 대기하지 않는 실행은 `409`다. 실행 시작 이후의 오류는 SSE의
`error` 프레임으로 전달될 수 있다. Agent 접근 권한과 현재 설정·바인딩도 다시 확인한다.

`DELETE /api/chats/{chatId}/approval`에 `{ "revision": 2 }`를 보내면 미완료 실행을
폐기하고 `204`로 응답한다. 실행 잠금이 살아 있으면 `409`다. 화면 기록은 유지하고 미완료
실행은 다음 모델 문맥에서 제외한다. 승인 뒤 프로세스가 중단된 경우 `status: "running"`으로
남으며 자동 재실행하지 않는다. 도구 결과를 확인한 뒤 폐기하고 새 턴을 시작한다.
승인 대기 중 새 메시지는 `409`다. 모든 변경 요청은 session의 동일 출처 검사를 적용한다.

## Workspaces

Workspace 사용자 API는 `withMemberAuth`로 보호한다. 조회·실행·승인은 Chat 소유자만 가능하며
현재 Agent 접근 권한도 확인한다. 다른 소유자의 Workspace는 404로 응답한다.

| 경로 | 메서드 | 계약 |
|---|---|---|
| `/api/workspaces/options` | GET | `{enabled, gitEnabled, agents}`. 각 Agent에 Runtime·`defaultRuntime`·`mode`·`repositories`·`repositoryOwners`·workflow 선택지 |
| `/api/workspaces/branches?agent={name}&repository={owner/repo}` | GET | 명시한 저장소의 브랜치 최대 100개와 `hasMore`. `agent`와 `repository`가 필요 |
| `/api/workspaces` | POST | `{agentName, runtime, repository?, baseBranch?, input}`으로 Chat·Workspace·첫 Run을 만들고 `{workspace, run}`과 202 반환 |
| `/api/workspaces/{id}` | GET | `{workspace, session, runs, approvals}`. 실행·승인은 최근 50개, `tail=1`이면 각각 1개 |
| `/api/workspaces/{id}` | DELETE | 체크포인트 저장과 Sandbox 정리를 요청하고 204 반환 |
| `/api/workspaces/{id}/runs` | POST | `input`으로 후속 Run을 접수하고 `{run}`과 202 반환 |
| `/api/workspaces/{id}/runs` | DELETE | 현재 Run의 취소를 요청하고 204 반환 |
| `/api/workspaces/{id}/events?run={runId}&after={seq}` | GET | 최대 200개의 `{events, nextSeq, hasMore}`. `after=0`도 유효한 cursor |
| `/api/workspaces/{id}/actions` | POST | Git·배포 요청의 현재 tree/HEAD를 검토하고 `{approval}` 반환. 효과는 아직 실행하지 않음 |
| `/api/workspaces/{id}/actions/{actionId}` | POST | `{approve: boolean}`으로 명시적 승인·거절. 같은 승인은 한 번만 소비 |
| `/api/agents/{name}/workspace-policy` | GET / PUT | GET은 접근 가능한 member의 설정 조회, PUT은 Agent 소유자·관리자 변경. 아래 계약을 따른다 |

Workspace 설정 GET은 `{agentName, enabled, backendReady, canManage, revision, rules, runtimes, updatedAt?}`를
반환한다. PUT은 `{revision, rules}`이며 `rules`는 `{mode, repositories, repositoryOwners, defaultRuntime,
idleTtlSeconds, checks, deploymentWorkflows}`다. 기본 저장소와 배포 기본값 복원 필드는 없다.
기본 모드는 `new`, 기본 Runtime은 `command`이며 모델이 필요한 Runtime은 Models에서 먼저 선택한다.
첫 저장의 revision은 `null`, 이후는 마지막 읽은 값을 사용한다. 동시 편집·삭제 경합은 409다.
각 저장소·소유자 목록은 100개까지며 URL·wildcard·Sandbox 인프라 설정·알 수 없는 필드는 400이다.
`GET /api/models/workspace`는 member에게 `{selections, options, available}`을 반환한다.
관리자는 `PUT /api/models/workspace`에 `{runtime: "codex" | "claude" | "opencode", model: string | null}`로
모델을 선택하거나 해제한다. 모델과 호환 채널을 검증하고 변경한 Runtime만 원자적으로 저장한다.

`selected`의 빈 규칙은 Git 접근을 차단하며 `all`은 목록으로 접근을 제한하지 않는다. 일반 Agent는
정책 모드를 변경할 수 없다. `Workspace.check_repository_access`는 `allowed`, `creation_allowed`,
`repository_mode`, `repository_policy_url`을 반환한다. `check_repository`는 허용된 저장소의 실제
접근과 초기 commit·기준 branch를 확인한다. 둘 다 Workspace를 만들지 않는다.

`Workspace.create_repository`는 `{request:{operation:"create_repository", repository:"owner/repo",
description:"...", private:true}}`를 받는다. description은 최대 350자이며 공개 여부는 명시해야 한다.
서버에서 README를 포함한 저장소를 생성하고 `new` 모드라면 허용 목록에 자동 등록한다.
결과의 `status`는 `created`, `failed`, `uncertain`이며 `allowed`, `reused`, 검증된 `repository_url`·
`base_branch` 또는 오류를 제공한다. 생성된 저장소와 실제 작업 접수는 별개라 이 호출은 Workspace나
Run을 만들지 않는다. 같은 완료 요청은 재사용하고 불명확한 요청은 다시 생성하지 않는다.

Runtime은 `command`, `codex`, `claude`, `opencode`다. `input`은 일반 명령의
`{kind:"command", script}` 또는 Agent의 `{kind:"task", prompt}`이며 각각 40,000자까지 받는다.
생성과 후속 Run은 `Idempotency-Key`를 요구한다. 같은 키·같은 내용은 기존 결과를 반환하며
다른 내용으로 키를 재사용하면 409다. Git 작업은 `repository`와 `baseBranch`를 함께 지정한다. 둘 다 없으면 Git 없는 Workspace다.
lease·operation handle·체크포인트 bytes와 주소는 사용자 응답에 넣지 않는다.

Git 동작은 `commit`, `commit-and-push`, `push`, `pull-request`(`draft` 선택), `merge`, `push-main`, `deploy`다.
`commit`·`commit-and-push`는 `message`를 받고 `push`·`push-main`은 추가 인자가 없다. 자세한 승인 조건은
[Workspace 설계](design/workspaces.md#git과-승인)를 따른다. 승인 요청과 실제 실행 모두
현재 파일 fingerprint를 확인한다. main 병합은 정확한 PR head를 요구하며 대기 중·실패한 검사를 거절한다.
`push-main`은 게시된 작업 브랜치와 검토한 main SHA를 확인하고 fast-forward만 실행한다.
검사가 없는 커밋은 `ci: "none"`으로 표시하며 성공으로 간주하지 않는다. GitHub 브랜치 규칙은 유지한다.
새 Workspace Run의 접수는 아직 승인하지 않은 Git 검토를 원자적으로 거절한다. 실행 중이거나
결과가 불확실한 Git 동작에는 새 Run을 접수하지 않는다.

`POST /api/workspaces/github/webhook`은 `X-Hub-Signature-256`의 HMAC-SHA256과
`X-GitHub-Delivery`를 요구하며 `{processed: boolean}`을 반환한다. 중복·관련 없는 이벤트는
`processed: false`, 잘못된 서명은 401, 같은 delivery ID의 다른 본문은 409다. 본문은 공용
이벤트 상한을 적용한다. PR 상태만 갱신하며 작업 실행·승인을 수행하지 않는다.

## 레지스트리·연동 오퍼레이션

이 엔드포인트들은 리소스 CRUD 외에 콘솔의 운영 행동을 뒷받침한다:

```
GET  /api/plugins
→ [ { name, version?, description?, repo, rootPath, commitSha,
      skills: ["name"], mcpServers: ["name"], syncedAt, createdAt, updatedAt } ]

GET  /api/plugins/{name}
→ 200 { …one of the above…, branch, repositoryUrl: string | null } | 404 | 400
                                           ({name} follows the Agent Plugins name rule,
                                            which allows periods — not the registry slug)

GET  /api/plugins/sync
→ { configured, repo, branch,
    last: { repo, report, actorEmail, finishedAt } | null }   (the persisted last report)

POST /api/plugins/sync
→ the sync report described below | 400 (malformed removal selection; each list holds at
  most 500 names) | 409 (a sync is already running) | 503 (not configured)

POST /api/plugins/sync/scan          (X-Scan-Token: SCHEDULE_SCAN_TOKEN)
→ 202 { started: true } | 200 { started: false, upToDate: true }
  | 200 { started: false, held: "archive" } | 401 | 503

POST /api/plugins/sync/upload        multipart/form-data: file (.tar.gz | .tgz | .tar),
                                     selection? (the removal JSON below)
→ the same sync report | 400 (not multipart, no `file`, empty archive, unreadable archive:
  a path that leaves the tree, a non-UTF-8 text entry, bad selection)
  | 409 (a sync is already running) | 413 (over 32 MB as sent; 64 MB inflated or 20,000
  entries refuse inside the reader as 400)
```

`/sync/upload` 는 GitHub 에 닿지 않는 배포의 sync 다: 체크아웃의 아카이브(`git archive
--format=tar.gz HEAD` 든 `tar czf` 든. 맨 앞의 공통 디렉터리는 벗겨 낸다)를 올리면 GitHub
클라이언트가 만드는 것과 같은 스냅샷이 되어 **같은 sync** 를 지난다. 행들이 지닐 provenance 는
설정된 `PLUGINS_REPO`, 그것도 없으면 `archive` 다. `GET /sync` 가 마지막 리포트를 읽는 바로 그
이름이고, 그래서 GitHub 가 닿던 시절의 행은 같은 저장소가 손으로 와도 주인을 유지한다. 스냅샷과
plugin 행의 `branch` 는 `archive`, `commitSha` 는 아카이브의 sha256 이다. 상세 응답은 이 branch 를
근거로 존재하지 않는 GitHub 링크를 만들지 않는다. 업로드를 식별할 뿐, 바뀌었는지는 행마다 내용으로 판정한다(GitHub sync 와 같다). `PLUGINS_REPO`
도 `GITHUB_TOKEN` 도 필요 없고, `GET /api/plugins/sync` 의 `last` 는 같은 이름 아래에서 읽힌다.
심볼릭 링크는 GitHub 트리와 같은 모드(`120000`)로 보고되어 같은 규칙으로 건너뛴다.

`/sync/scan` 은 CronJob 의 tick 이다: 브랜치 head 를 마지막 리포트와 비교해, 머지된 것이 없으면
스냅샷 비용을 치르지 않고 `upToDate` 로 답한다. 마지막 리포트가 아카이브 업로드의 것이면 `held` 로
답하고 GitHub 를 보지 않는다. 사람이 올린 것은 다음 `POST /api/plugins/sync` 까지 선다 (그 리포트가 `write-failed` skip 을 싣고 있었다면
예외다. 그것은 다시 돌려야만 복구된다). tick 은 `scheduler` 로서 sync 하고, 절대 삭제하지
않으며 (제거 선택은 콘솔에만 있다), schedule ticker 의 토큰을 공유한다. 배포당 CronJob 인증
정보는 하나다.

```

POST /api/mcps/{name}/tools
→ { tools } | 502 (connection failure)

```

sync 엔드포인트는 `GET` 은 member 에게 답하고 `POST` 는 admin 권한을 요구한다. 레지스트리 테스트
오퍼레이션은 `member` tier 를 요구하고, 등록과 dispatch 때 쓰는 것과 같은 SSRF 가드를 적용한다.
`POST /api/mcps/{name}/tools` 는 테스트를 요청한 사용자의 email 을 `X-User-Email` 로 서버에 보낸다.
Plugin 에는 생성/수정 라우트가 없다: sync 가 유일한 writer 이고, plugin 행은 sync 자신의
`remove` 선택을 거쳐 사라진다.

sync 는 한 가지 규칙을 따른다: **저장소는 자기가 선언한 것을 소유하고, 삭제는 사람이
소유한다.** 제거 선택은 종류(kind)로 한정된다. skill 레지스트리와 MCP 레지스트리가 같은 이름을
가질 수 있기 때문이다:

```
POST /api/plugins/sync  { "remove"?: { "skills"?: ["name"], "mcpServers"?: ["name"],
                                       "plugins"?: ["name"] } }
→ 200 { repo, commitSha,
        plugins: [ { plugin, version?, description?,
                     skills:     { created, overwritten: [{name, fields}], unchanged,
                                   orphaned: [{name, boundTo}], removed, skipped },
                     mcpServers: { …same shape… } } ],
        skipped, orphanedPlugins, removedPlugins }
```

종류별로, 각 plugin 의 섹션 안에서:

- **created**. 저장소에는 있고 레지스트리에는 없다. `source: "github:<repo>#<plugin>"` 과 함께
  그대로 가져온다.
- **overwritten**. 양쪽에 있고 서로 다르다. **자동으로** 저장소의 것으로 맞추며, `fields` 가
  무엇이 움직였는지를 밝힌다. 그중 `source` 는 입양(adoption)이다: 다른 출처가 만든 항목(퇴역한
  skills/tools 저장소, 다른 plugin). 또는 source 가 아예 없이 손으로 만든 항목. 의 손이 바뀐
  것이고, 이것은 `registry.adopt` 감사 행도 남긴다. repo 가 선언하는 이름에 가한 콘솔 편집은
  다음 sync 에서 대체된다. repo 가 진실의 출처다. 어떤 plugin 도 선언하지 않는 이름으로 손수
  등록된 항목은 절대 건드리지 않는다. **인증 정보는 주소를 따라가지 않는다**: URL 이 옮겨지면
  저장소가 지금 가리키는 곳 어디로든 옛 호스트의 secret 을 보내는 대신, 그 항목의 저장된 헤더와
  OAuth 블록을 버린다 (`credentials-reset` 으로 보고된다).
- **unchanged**. 양쪽에 있고 이미 일치한다. 아무것도 쓰지 않았으므로 `updatedAt` 도 움직이지
  않는다. URL은 registry의 공통 변경 판정을 사용하며, 루트 주소의 끝 `/`, 호스트 대소문자,
  기본 포트의 표기 차이는 변경으로 보지 않는다. 경로의 끝 `/` 차이는 변경이다.
- **orphaned**. 이 저장소의 sync 가 만들었고 그 안의 어떤 plugin 도 더 이상 선언하지 않는 것.
  자기 source 가 지목하는 plugin 에 귀속되며 (완전히 사라진 plugin 을 위해서는 섹션이
  합성된다), `boundTo` 는 대롱거리게 될 `agent` 바인딩을 나열한다. 이름이 대응하는
  `remove` 목록에 있지 않는 한 **아무것도 삭제되지 않는다**. MCP 항목은 인증 정보를 쥐고 있고,
  파일이 브랜치에서 사라졌다는 것은 그것을 파괴할 충분한 이유가 아니다. 읽을 수 없는
  `plugin.json`/`mcp.json` 은 아무것도 orphan 으로 만들지 않는다: 그 plugin 은 파일이 다시
  파싱될 때까지 마지막으로 정상이던 상태에 얼어붙는다. managed 항목의 삭제는 managed use case 를
  거치므로 컨테이너가 행과 함께 멈춘다. 삭제는 콘솔에서와 똑같이, 요청한 admin 의 이름을 담은
  `registry.delete` 감사 행을 남긴다.
- **skipped**. `[{ name, reason, detail? }]` 이고 `reason` 은 다음 중 하나다: `bad-name`,
  `invalid-url` (아웃바운드 가드의 메시지가 `detail` 에 담긴다), `managed-url` (managed MCP
  항목의 주소는 프로비저너가 주므로 문서의 주소는 무시하고 나머지 필드는 적용했다),
  `conflict` (sync 도중의 경합, 어느 방향이든), `attachment` (skill 은 sync 됐지만 그 파일 중
  하나가 안 됐다), `invalid-manifest` (쓸 수 없는 `mcp.json`, 또는 그 안의 쓸 수 없는 서버
  항목), `invalid-skill` (Agent Skills 스펙을 벗어난 SKILL.md),
  `unsupported-transport` (`stdio`/`sse`, 보고만 하고 절대 실행하지 않는다),
  `headers-dropped` (서버는 sync 됐지만 mcp.json 이 선언한 헤더는 가져오지 않았다. `detail` 은
  그 이름만 나열한다), `duplicate-name` (두 plugin 이 그 이름을 주장한다. 주장한 쪽 모두
  건너뛴다), `credentials-reset` (위 참조), `write-failed` (쓰기 하나가 차단됐다. 다른 plugin/항목은
  계속하고 다음 실행이 수렴시킨다. 부모 plugin 행의 쓰기라면 그 provenance 를 가질 컴포넌트는
  이번 실행에서 쓰지 않는다).

최상위 `skipped` 는 어떤 plugin 도 소유하지 않는 것을 싣는다. 쓸 수 없는 `plugin.json`, 다른
plugin 루트 안에 중첩된 plugin 루트, 두 루트가 주장하는 plugin 이름. `orphanedPlugins` 는 저장소가
더 이상 갖고 있지 않은 plugin 행을 나열한다. 그중 하나를 제거하면 (`remove.plugins` 로) 그 행만
지워진다. 구성 요소는 각각 orphan 으로 따로 드러나며, 저마다 별개의 결정이다.

쓰기는 문서가 소유한 것만 대체한다. skill 의 description·content·첨부, MCP 항목의 `url`,
`description`, `content` (plugin 의 `org.opspresso.agent-studio/mcp/<name>.md` 확장 문서에서
온다), `source`. 암호화된 헤더, 발견된 OAuth 블록, managed 항목의 프로비저닝된 주소는 절대
건드리지 않고, 문서가 싣지 않은 필드는 저장된 것을 그대로 둔다. MCP 항목의 주소를 옮기면 옛
주소에서 읽었던 OAuth 블록이 버려지므로 Discover 를 다시 돌려야 한다.

상류 실패(GitHub 도달 불가, 잘린 트리)는 다른 모든 라우트와 마찬가지로 `apiError` 를 통해
`502` 로 답한다. `PLUGINS_REPO` 나 `GITHUB_TOKEN` 이 없으면 `503` 이다.

agent 별 Slack 설정은 이 엔드포인트들을 쓴다:

```
GET    /api/agents/{name}/slack
PUT    /api/agents/{name}/slack   { botToken?, signingSecret?, enabled?, suggestedPrompts?, channelKeywords? }
DELETE /api/agents/{name}/slack
POST   /api/agents/{name}/slack/test
GET    /api/agents/{name}/slack/channels
```

`suggestedPrompts` 는 `{ title, message }[]` 이고 최대 4개다. `title` 은 80자, `message` 는
500자로 제한된다. 빈 행은 버려지고, 한쪽만 채운 행이나 어느 한도든 넘긴 행은 400 이다. 두 인증
정보와 달리 이것은 secret 이 아니라서 저장된 그대로 돌아온다.
`channelKeywords` 는 `string[]` 이다. 멘션 없이도 채널 메시지를 봇의 것으로 만드는 단어들이다
([design/slack.md](design/slack.md#어떤-이벤트가-봇에게-온-것인가) 참조): 최대 20개, 저장 시 각각
공백을 정리하고 소문자로 바꾸며, 2–50자다. 빈 값과 중복은 버려지고, 그 길이를 벗어난 키워드는
400 이다. `PUT` 에서 이 필드를 생략하면 저장된 목록을 유지한다.

Slack 읽기는 마스킹된 인증 정보 상태와 함께 `configured`, `eventsPath`, `eventsUrl`,
`suggestedPrompts`, `channelKeywords`, 그리고 생성된 앱 manifest를 돌려준다.
설정 경로의 GET·PUT·DELETE가 이 뷰로 답하며 test·channels는 아래의 별도 응답을 사용한다.
다섯 엔드포인트 모두 소유자와 effective admin 으로 제한된다 (그 외에는 403). 마스킹된 뷰도 봇
토큰 / signing secret 의 양끝은 드러내기 때문이다. 마스킹되거나 생략된 secret 은 업데이트에서
보존되고, agent 가 아닌 agent 에 대한 `PUT` 은 400 이다. Slack 봇은 agent 에만
붙는다. 저장된 것도 보낸 것도 없는 상태에서 봇 토큰과 signing secret 없이 `enabled: true` 를
보내는 `PUT` 도 마찬가지다: 켤 것이 없다.
테스트 엔드포인트는 `{ ok: true, team, botUser }` 를 돌려주고, 그 agent 에 Slack 이 설정되지
않았거나 꺼져 있으면 `400`, Slack API 실패면 `502` 다.
채널 엔드포인트는 `{ channels: [{ id, name, isPrivate?, isMember? }] }` 를 돌려준다. 설정되고
활성화된 agent bot의 token으로 읽으며, 보고서를 실제로 쓸 수 있도록 bot이 참가한 채널만
이름순으로 제공한다.

agent 별 Telegram 설정은 이 엔드포인트들을 쓴다:

```
GET    /api/agents/{name}/telegram
GET    /api/agents/{name}/telegram/chats
PUT    /api/agents/{name}/telegram          { botToken?, enabled? }
DELETE /api/agents/{name}/telegram
POST   /api/agents/{name}/telegram/test
POST   /api/agents/{name}/telegram/webhook
```

설정 경로의 GET·PUT·DELETE는 같은 뷰로 답한다: `enabled`, `configured`, 마스킹된 `botToken`, 봇의
`botUsername` (토큰을 저장할 때 알아낸 것. secret 이 아니다), `webhookPath`, `webhookUrl`.
여섯 endpoint 모두 소유자와 effective admin 으로 제한된다. `PUT` 의 *새* 토큰은 저장하기 전에
Telegram(`getMe`)으로 확인하고, Telegram 이 거부하면 400 이다. 마스킹되거나 빈 토큰은 저장된
것을 유지한다. webhook secret 은 첫 토큰과 함께 이 플랫폼이 발행하며 절대 돌려주지 않는다.
그것이 필요한 쪽은 Telegram 뿐이다. **webhook 은 `PUT` 이 스위치를 따라 관리한다**: `enabled`
가 켜지면 이 배포의 URL 에 등록하고, 꺼지면 삭제하며, 토큰이 바뀌면 이전 봇의 webhook 을 물리고
secret 을 새로 발행한 뒤 켜져 있으면 새 봇을 등록한다. 그 Telegram 호출이 실패하면 저장은 그대로
되고 응답에 `warnings: string[]` 로 말한다. `POST …/telegram/webhook` 은 같은 등록을 명시적으로
다시 하는 것이고(`PUBLIC_BASE_URL` 이 바뀐 뒤 옮길 때) `{ ok: true, url }` 로 답한다. `DELETE`
는 Telegram 에 webhook 을 없애라고 최선을 다해 알리고, 어느 쪽이든 인증 정보는 잊는다. agent
를 지울 때도 행이 사라지기 전에 webhook 을 물린다. Slack 처럼
agent 가 아닌 agent 에 대한 `PUT` 은 400 이고, 저장되거나 전달된 토큰 없이 켜는 것도
마찬가지다. `test` 는 `{ ok: true, botId, botUsername }` 을 돌려주고, Telegram 이 설정되지
않았거나 꺼져 있으면 `400`, Bot API 실패면 `502` 다. `webhook` 도 같은 방식으로 답한다.
`chats` 는 현재 설정된 봇이 실제로 응답 대상으로 받은 chat 과 포럼 topic 을 최근에 본 순서로
최근 100개까지 `{ chats: [{ chatId, chatType, title, threadId?, lastSeenAt }] }` 에 담아 돌려준다. Telegram Bot API
에는 봇의 chat 목록을 조회하는 호출이 없으므로, 아직 이 봇과 대화하지 않은 목적지는 나타나지
않는다. 토큰을 바꾸면 새 봇의 목록만 보인다.

이벤트 엔드포인트 자체인 `POST /api/telegram/webhook/{agent}` 는 Telegram 이 호출하는 것이다
(사람이 아니다): 본문이 1MB 를 넘으면 413, `X-Telegram-Bot-Api-Secret-Token` 이 틀리거나 없으면
401, 봇이 무시하는 업데이트는 아무것도 claim 하지 않은 `{ ok: true }`, 재전송은
`{ ok: true, duplicate: true }`, 그 밖의 것은 `{ ok: true }` 이고 런은 ack 이후에 처리된다
([design/telegram.md](design/telegram.md) 참조).

Agent별 Teams 설정은 이 엔드포인트들을 쓴다:

```
GET    /api/agents/{name}/teams
PUT    /api/agents/{name}/teams          { appId?, appPassword?, tenantId?, enabled? }
DELETE /api/agents/{name}/teams
POST   /api/agents/{name}/teams/test
```

설정 경로의 GET·PUT·DELETE가 같은 뷰로 답한다: `enabled`, `configured`, `appId`(secret 이 아니다, 모든 토큰의
audience 다), 마스킹된 `appPassword`, `tenantId`, `messagingPath`, `messagingUrl`. Azure Bot 의
messaging endpoint 로 붙여 넣을 주소다. 넷 모두 소유자와 effective admin 으로 제한된다. `PUT` 은
App ID 와 테넌트 id 가 GUID 인지만 확인하고 Microsoft 에는 아무것도 묻지 않는다. 한 쌍이
동작한다는 증거는 `test` 가 저장된 자격 증명으로 토큰을 받아 보는 것이고(`{ ok: true, appId,
expiresInSeconds }`, 설정되지 않았거나 꺼져 있으면 `400`, Microsoft 가 거절하면 `502`), 저장이
아니라 운영자가 요청하는 네트워크 호출이다. 마스킹되거나 빈 secret 은 저장된 것을 유지하고,
agent 가 아닌 agent 에 대한 `PUT` 과 자격 증명 없이 켜는 것은 400 이다. `DELETE` 는 등록을
잊는다. Azure 쪽 endpoint 는 운영자가 지운다.

messaging 엔드포인트 자체인 `POST /api/teams/messages/{agent}` 는 Bot Framework 가 호출하는
것이다: 본문이 1MB 를 넘으면 413, bearer 토큰이 서비스의 키로 검증되지 않거나 이 App ID 를
audience 로 하지 않거나 activity 의 `serviceUrl` 을 위해 발급된 것이 아니면 401, 봇이 무시하는
activity 는 아무것도 claim 하지 않은 빈 200, 재전송은 빈 200, 그 밖의 것은 빈 202 이고 런은 ack
이후에 처리된다 ([design/teams.md](design/teams.md)).

## 관리형 MCP 서버

managed 서버는 이 배포가 자기 호스트의 Docker CLI 로 직접 띄우고 loopback 으로 닿는
컨테이너다. 아래 작업은 모두 **admin 전용**이고, `MANAGED_MCP_RUNTIME=docker` /
`MANAGED_MCP_REGISTRY` 가 설정돼 있지 않으면
`503 { "error": "This deployment is not configured to run managed MCP servers." }` 로 답한다.
반쯤 켜진 상태가 아니라 기능이 꺼진 것이다.

```
POST   /api/mcps/managed              → 201 { …registry entry… }   | 409 | 400 | 503
GET    /api/mcps/managed/{name}       → 200 { name, image?, running, reachable, address?, detail? }
PUT    /api/mcps/managed/{name}       → 200 { …entry… }            | 404 | 409 | 400 | 403
DELETE /api/mcps/managed/{name}       → 204                        | 404 | 403
POST   /api/mcps/managed/{name}/restart → 202 (no body)            | 404 | 400 | 409 (restart in flight)
```

생성 본문:

```json
{ "name": "my-tool", "image": "registry.example.com/mcp/my-tool:1.4.0", "containerPort": 8080,
  "args": ["--port", "{{PORT}}"], "endpointPath": "/mcp",
  "environment": { "LOG_LEVEL": "info" },
  "description": "", "content": "", "headers": {} }
```

- `name` 은 slug (`^[a-z0-9][a-z0-9-]{0,62}$`) 다. 컨테이너의 이름이기도 하기 때문이다.
- `args` 는 셸 명령이 아니라 **argv 배열**이다. 최대 64개, 각각 1024자 이하이며 제어 문자가
  없어야 한다. 인자 안의 `{{PORT}}` 는 실제 listen 포트로 치환된다. `PORT` 환경변수를 존중하지
  않는 이미지를 위한 것이다.
- `environment` 값은 레지스트리 행에서 암호화되고, 읽을 때 마스킹되며, 워크로드 스펙을 만들 때만
  복호화된다. Docker 에는 0600 임시 env file 로 전달하고 호출 뒤 제거한다. 호스트 파일 경로는
  받지 않는다. `PORT` 는 거절된다. 그것은 런타임이 소유한다. 키는
  `^[A-Za-z_][A-Za-z0-9_]*$` 이고 값은 줄바꿈 없이 16,384자까지 간다.
- `endpointPath` 의 기본값은 `/mcp` 이고, query·fragment·공백이 없는 절대 경로여야 한다
  (`^\/(?!\/)[^\s?#]*$`). 그 밖의 것은 `400` 이다.
- `PUT`/`DELETE` 의 `403` 은 모든 레지스트리 라우트가 답하는 repo 소유 거절이다: sync 된 항목의
  `description` 과 `content` 는 저장소의 것이고, 워크로드 필드(`image`, 포트, env)는 여기서 계속
  수정할 수 있다.
- `PUT` 본문은 생성 본문에서 `name`을 뺀 필드의 부분 집합이다. workload 하나만 바꾸기 위해
  `image`와 `containerPort`를 다시 보낼 필요가 없다.
- `image` 는 안전한 Docker image reference 형식이어야 한다. `MANAGED_MCP_REGISTRY` 는
  기능 활성화 설정이며 허용 image registry 목록은 아니다. 앱은 `docker login`을 수행하지 않는다.
  Docker daemon의 registry 접근·credential은 배포가 준비한다.
- `containerPort` 는 요청이지 보장이 아니다: 포트 매핑을 게시하는 어댑터만이 그것을 존중할 수
  있다. 배포된 Docker 어댑터는 호스트 loopback의 결정적 포트를 `containerPort`에 매핑하고,
  컨테이너에도 `PORT=<containerPort>`를 알려 준다.

`GET`은 Docker 실행 상태 `running`과 실제 endpoint 응답 `reachable`을 별도로 반환한다.
`PUT`은 저장 설정을 갱신하고 workload 변경이 있으면 재시작을 예약한다.
`DELETE`는 컨테이너와 행을 순서대로 정리하므로 오류가 나면 실제 상태를 다시 확인한다.

`POST …/restart`는 저장된 workload를 다시 만들도록 접수하고 본문 없는 202로 응답한다.
완료 여부는 상태 GET으로 확인한다. 주소는 앱 컨테이너의 namespace가 아니라 호스트 loopback의
포트 매핑이다. [Managed 설계](design/mcp.md#managed-서버)를 따른다.

## MCP OAuth

레지스트리 항목의 authorization-server 메타데이터와 공용 OAuth 앱은 운영자 설정(admin)이다.
Agent 소유자는 Connection에서 자신의 계정으로 승인하며, access/refresh token은 Agent별로 저장한다.

### Discovery (admin)

```
POST   /api/mcps/{name}/auth   { "authorizationServer": "https://…"? }
→ 200 { status: "discovered", auth: {…} }
→ 200 { status: "choose", resource: "…", authorizationServers: ["…", "…"] }
DELETE /api/mcps/{name}/auth   → 204     (return the entry to static-header behaviour)
GET    /api/mcps/{name}/auth   → 200 { auth: {…}, defaultRedirectUri }
PUT    /api/mcps/{name}/auth   { clientId?, clientSecret?, redirectUri? }
→ 200 { …masked auth… }
```

GET과 PUT도 admin 전용이다. Tools는 GET의 `defaultRedirectUri`로 Redirect URI를 자동 입력한다.
이 주소는 서버의 공개 base 설정에서 만들며, 입력한 값도 동일한 콜백이어야 한다.
PUT에서 생략한 필드는 보존하고, 빈 값이나 마스킹된 Secret은 같은 Client ID의 기존 Secret을
유지한다. Client ID를 변경하면 이전 Secret은 재사용하지 않으며, 빈 Client ID는 공용 앱을 제거한다.
빈 Redirect URI는 배포의 기본 콜백을 사용한다. 공용 앱이 없으면 Client ID Metadata Document,
동적 등록 순서로 연결한다. 자동 등록 서버의 수동 설정은 Tools에서 접힌 상태로 제공한다.
OAuth 설정을 읽은 뒤 다른 요청이 변경했다면 저장은 `409`로 거부한다.

RFC 9728 protected-resource 메타데이터 → RFC 8414 authorization-server 메타데이터 순으로
따라가며, 발견된 모든 엔드포인트를 SSRF 정책으로 다시 검증하고 `https` 일 것을 요구한다.
리소스가 authorization server 를 하나보다 많이 광고하면 이 호출은 `choose` 를 돌려준다.
광고된 값 중 하나를 `authorizationServer` 에 넣어 다시 호출하라.

쓸 만한 문서를 게시하지 않는 서버. 또는 닿을 수 없는 서버. 는 시도한 후보 URL 들과 각각이 왜
실패했는지를 담아 **400** 으로 답한다.
[선언된 내부 호스트](SECURITY.md#선언된-내부-호스트) 의 항목에 닿는 것은 런에서와 마찬가지로
여기서도 동작한다.

항목의 **URL** 을 수정하면 `auth` 블록은 그대로 버려진다. 그것은 옛 주소의 well-known 문서에서
읽어 온 것이었다.

### 연결 (owner)

```
GET    /api/agents/{name}/mcp-connections
→ 200 { connections: [ { serverName, status, clientId, clientSecret?, clientRegistered,
                         scopes, connectedBy?, connectedAt?, expiresAt? } ] }

PUT    /api/agents/{name}/mcp-connections/{server}
       { clientId, clientSecret?, scopes?: [] }        → 200 { …connection view… }
DELETE /api/agents/{name}/mcp-connections/{server}   → 204

POST   /api/agents/{name}/mcp-connections/{server}/authorize
→ 200 { authorizeUrl: "https://provider/authorize?…" }

POST   /api/agents/{name}/mcp-connections/{server}/tools
       { headerOverrides?: { "X-Tenant": "acme", "X-Shared": null } }
→ 200 { tools } | 502 { error }
```

- `status` 는 `needs_auth` | `connected` | `needs_reauth` 다. 연결을 `needs_reauth` 로 옮기는
  것은 **거부된 grant** 뿐이다. 5xx 나 타임아웃은 그대로 둔다.
- `clientSecret` 은 읽을 때 마스킹되고 **토큰은 절대 돌려주지 않는다**. agent API 토큰과 달리 reveal 경로가 없는데, 토큰은 표시될 이유가 없기 때문이다. 쓰기에서 생략되거나
  마스킹된 값은 저장된 것을 유지한다. **빈** 값은 그것을 지우며, 이것이 confidential 클라이언트에서
  public 클라이언트로 돌아가는 유일한 길이다.
- `clientRegistered` 는 인증 정보가 손으로 입력된 것이 아니라 RFC 7591 동적 등록에서 왔을 때
  `true` 다.
- `/authorize` 는 `3xx` 를 내는 대신 프로바이더 URL 을 **돌려준다**: 호출자는 콘솔의 `fetch` 이고,
  그것은 사용자를 보내는 대신 리다이렉트를 자기가 따라가 버릴 것이기 때문이다.
- `auth` 블록이 없는 레지스트리 항목은 연결할 대상이 없으므로 `PUT` 과 `/authorize` 는 `400` 으로
  답한다. `/authorize` 는 공개 base URL 이 설정되지 않았을 때, 서버가 동적 등록을 제공하지 않고
  손으로 입력한 클라이언트도 없을 때, 그리고 저장된 인증 정보가 지금 그 항목이 지목하는 것과 다른
  issuer 에서 발급됐을 때도 `400` 이다. `DELETE` 는 그 agent 가 그 서버에 연결을 갖고 있지
  않으면 `404` 로 답한다. `/tools` 는 실행에 연결이 필요 없고, 그 `404` 는 레지스트리 항목 자체가
  사라졌다는 뜻이다.
- `/tools` 는 **이 agent 가 보는 대로** 그 서버의 도구를 나열한다. agent 자신의 연결과 그
  바인딩의 헤더 오버레이를 얹어서. 레지스트리 자신의 `POST /api/mcps/{name}/tools` 프로브와는
  구별된다. 그쪽은 항목의 정적 헤더와 요청 사용자 email 만 싣기 때문에 OAuth 서버에 대해서는
  401 밖에 낼 수 없다.
  두 probe 모두 요청한 사용자의 email을 보호된 `X-User-Email`로 추가한다.
  마스킹된 override는 현재 Agent 설정의 같은 서버 바인딩에서 해석한다. 두 probe는 tenant header를
  보내지 않으므로 tenant별 도구 목록은 실제 런과 다를 수 있다.
  소유자 게이트인 이유도 같다: 그 agent 의 연결을 소비한다. 그 `502` 는 서버에 아예 닿지 않는
  두 거절도 포함한다. 아웃바운드 가드가 막는 URL, 그리고 인증 정보를 해석할 수 없는 연결이다.

### 콜백

```
GET /api/mcps/oauth/callback?code=…&state=…&iss=…    (session)
```

authorization server 가 **브라우저**를 여기로 리다이렉트하므로, 이 엔드포인트는 JSON 이 아니라
스스로 닫히는 작은 HTML 페이지로 답한다: 결과를 opener 에게 `postMessage` 하고 닫히며, 평범한
탭에서 열렸더라도 읽을 만하게 보인다. 어느 쪽이든 상태 코드는 `200` 이다. 상태 코드는 페이지를
서빙한 일을 말하고, 결과는 메시지 안에 있다. 일회성 결과를 싣기 때문에
`Cache-Control: no-store` 다.

콜백은 code 를 교환하기 전에 RFC 9207 `iss` 를 검증하고, 사용자가 프로바이더에 가 있는 동안
바뀔 수 있는 agent 소유권과 OAuth client·resource를 다시 확인한다. 토큰 교환에는 pending
state에 저장한 원래 Redirect URI를 사용한다. 검사 전체는
[SECURITY.md](SECURITY.md#mcp-oauth) 를 보라.

### Client ID 메타데이터 문서

```
GET /api/mcps/oauth/client-metadata/{agent}          (public)
```

그 agent 의 OAuth Client ID Metadata Document 다. authorization server 가 URL 인
`client_id` 를 해석하려고 가져간다 (프로토콜 `2026-07-28`. 이 개정은 동적 등록을 deprecate 하지만,
문서를 받아들이지 않는 서버에는 여전히 그것이 폴백이다).
**일부러 비인증이다**. 읽는 쪽이 세션 없이 도착하는 그 서버다. 그리고 secret 을 싣지 않는다:
배포의 이름과, 받아들이는 단 하나의 redirect URI 뿐이다. slug 가 아닌 이름은 `404`, 공개 base
URL 이 설정되지 않았으면 `503`, 그리고 `Cache-Control: public, max-age=300` 이다.

## Agent API 토큰

Agent별 토큰은 외부 호출자가 세션 쿠키 대신 `Authorization: Bearer <token>` 으로 실행
엔드포인트에 닿게 해 준다. 토큰은 해시가 아니라 AES-256-GCM 으로 암호화해 저장되므로, 소유자가
요청하면 다시 읽어 볼 수 있다.

```
GET    /api/agents/{name}/token          → { configured, masked?, createdAt?, revealable? }
POST   /api/agents/{name}/token          → { token, masked, createdAt }   (raw token)
POST   /api/agents/{name}/token/reveal   → { token, createdAt }           (raw token)
DELETE /api/agents/{name}/token          → 204
```

토큰은 `ast_` + 랜덤 32바이트(base64url)다. `masked` 는 생성 시점에 기록된 표시용 마스크
(`ast_••••…••wXyZ`)다. 현재 토큰은 암호화되어 reveal 할 수 있고, 마스크는 routine status
조회에서 복호화하지 않고 *어느* 토큰이 설정돼 있는지 보여 주기 위해 따로 저장한다. 암호화
저장과 마스크 기록 전에 발급된 legacy 토큰에는 해시만 있어 복구할 수 없지만 계속 동작한다.

넷 다 소유자와 effective admin 으로 제한된다 (그 외에는 403). `POST` 는 토큰을 생성하거나 재생성한다.
재생성은 이전 토큰을 덮어쓰고, 그 토큰은 즉시 동작을 멈춘다. 토큰은 자기 agent 범위로 한정된다
(요청 경로의 `{name}` 에 대해 검증된다).

생성에는 **소유자의 tier** 게이트가 추가로 걸린다: API 토큰을 쓸 수 없는 tier
(`src/domain/member/tiers.ts` 의 `TIER_LIMITS`, 오늘로는 `guest`) 는 admin 을 포함해 누가
요청하든 `403` 으로 답한다. 그 토큰이 그 소유자로서 인증하게 되기 때문이다. 인증 시점의 대응
게이트는 아래 실행 엔드포인트에 있다.

`/reveal` 은 읽기인데도 POST 다: 본문이 살아 있는 인증 정보라서 캐시·히스토리·프리페치 밖에
머물러야 한다. 암호화 저장 이전에 발급된 토큰은 `revealable` 이 `false` 다. 해시만 존재하므로
`/reveal` 은 재생성하라는 안내와 함께 `400` 으로 답한다. 검증은 두 형태를 모두 받아들인다
(상수 시간 복호화-비교, 또는 레거시 토큰의 해시 비교). 모든 reveal 은 호출자의 이메일과 함께
서버 측에 로그된다.

## 실행

설정된 Agent의 최소 호출 예제다. 로컬 서버의 실제 Agent 이름과 발급한 token을 사용한다.

화면 API Reference의 curl·SDK 예제는 호출 프로세스의 `AGENT_API_TOKEN` 환경변수를 사용한다.
대화 식별 예제에는 `CONVERSATION_ID`도 설정한다. curl의 인증 헤더는 큰따옴표로 감싸 환경변수가
치환되며 Python은 `os.environ`, Node.js는 `process.env`로 읽는다. 값은 호출 서버에 보관한다.

```bash
curl --fail-with-body http://localhost:3000/api/agents/my-agent/predict \
  -H "Authorization: Bearer $AGENT_API_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"messages":[{"role":"user","content":"안녕하세요"}],"stream":false}'
```

Bearer 대신 세션 쿠키로 변경 요청을 보내면 동일 출처의 `Origin`도 필요하다.
API별 요청·응답 형태는 아래 절을 따른다.

아래 세 엔드포인트는 세션 쿠키 또는 agent API 토큰(`Authorization: Bearer <token>`)으로
인증한다. 토큰은 agent 소유자로서 인증한다. 유효하지만 그 소유자의 *현재* tier 가 API 토큰을
쓸 수 없는 토큰은 `403` 으로 답한다 (`401` 이 아니다, 인증 정보는 유효하고 정책이 거절하는
것이다). tier 해석에는 최대 30초의 인스턴스별 캐시가 있으므로 강등 전파가 그만큼 늦을 수 있다.

셋 다 `MAX_RUN_DURATION_MS` 로 한계 지어지고 (거절이 아니라 런을 스트림 도중에 끊는 벽시계
데드라인이다), 호출자별 동시성 가드와 그 agent 의 비용 가드를 거쳐 admit 된다. 둘 중 어느
쪽이든 `Retry-After` 와 함께 `429` 로 답한다. 세션 런은 호출자의 tier 로도 한계 지어지고
(동시성과 월간 비용 상한. 후자는 세 번째 `429` 다), 토큰 런은 그렇지 않다. 토큰의 지출은
개인 예산이 아니라 언제나 agent 에 속한다.

그 데드라인에 걸린 런은 **`504`** 와 함께 무엇이 자기를 멈췄는지 말한다
(`This run was stopped after 600 seconds, …`). 스트리밍 요청이면 같은 문장이 마지막
`error` 프레임으로 나간다. 호출자가 먼저 떠난 것은 실패가 아니므로 `499` 이고, 이 둘을
가르는 것은 abort 의 *이유* 가 아니라 어느 신호가 끊었는가다.

**`X-Conversation-Id`** (선택, 셋 모두) 는 그 요청이 속한 대화를 지목한다. 이 세 엔드포인트는
자기 스레드가 없으므로 연속성은 호출자가 선언할 몫이다: 한 대화의 후속 질문들에 같은 값을 보내면
런은 그것을 `RunOrigin.conversation` 으로 싣고, 호출하는 모든 MCP 서버에 그 키를 전달한다
(`X-Conversation-Id: api:{caller}:{value}`). `{caller}` 는 호출하는 actor 를 이 배포 자신의
secret 으로 키잉해 만든 16자리 hex 다이제스트다. `1` 을 보내는 두 호출자는 두 개의 대화에 있고,
이메일은 전혀 이동하지 않으며, 그 다이제스트는 이 배포 밖에서는 아무 의미가 없다. 값은 필요한
곳에서 퍼센트 인코딩된다 (공백, 제어 문자, 출력 가능한 ASCII 밖의 모든 것, 그리고 `%`). 이는
UUID 나 평범한 키에 대해서는 아무것도 바꾸지 않으면서 서로 다른 두 값을 두 개의 대화로 유지한다.
인코딩 후 최대 495자이고, 그보다 긴 헤더는 자기가 선언한 대화 없이 조용히 실행되는 대신 `400` 으로
답한다. 없으면 각 요청이 별도의 대화로 처리된다. 표면이 스레드를 *가진* 곳에서는
플랫폼이 직접 이름을 붙인다: chat 은 `chat:{chatId}`,
Slack 답글은 `slack:{channel}:{threadTs}`다.
[design/observability.md](design/observability.md#사용량과-비용-귀속) 를 보라.

### `POST /api/agents/{name}/predict`

현재 Agent 설정의 MCP 도구·Skill·Subagent로 멀티턴 실행을 수행한다.
`messages`는 비어 있지 않은 배열이다. `documents` 첨부와 `stream`을 선택할 수 있다.
`variables`·`prompt`·`size`·`quality`·최상위 `images` 등 지원하지 않는 입력은 400으로 거절한다.
이미지는 메시지의 인라인 image part로 전달하고 생성·편집은 Agent 도구로 수행한다.

```text
// request
{ "messages": [ { "role": "user", "content": "hi" } ], "stream": false }
// response
{ "result": "…assistant text…", "model": "openai/gpt-5-mini",
  "usage": { "inputTokens": 12, "outputTokens": 34, … },  // cachedTokens 와 reasoningTokens 는
                                                          // 각각 앞의 두 수의 *부분집합*이며,
                                                          // 프로바이더가 보고했을 때만 실린다
  "finishReason": "completed",  // 런이 끝난 이유: "turn-limit" / "output-limit" 은 부분 답을 뜻한다
  "warnings": [ "Skill 'x' is no longer in the registry; it was not offered." ]?,  // 런이 무언가를 잃었을 때만
  "images": [ { "b64": "…", "mimeType": "image/png" } ]?,  // 런이 무언가를 그렸을 때만
  "files": [ { "fileId": "…", "name": "report.docx", "mimeType": "…", "byteSize": 2048, "url": "https://…" } ]?  // 툴이 파일을 만들었을 때만
}
```

`files` 는 도구가 만들어 낸 문서다. 바이트는 artifact 로 보관되고 런의 스트림에서 제거되므로,
여기 실리는 것은 파일이 아니라 **서명된 다운로드 주소**다. 서명은 수명이 짧다 (API 응답에는 15분,
메시징 답변처럼 링크가 지속되는 기록에는 7일). artifact 자체는
그 Agent의 갤러리에 남는다. 오브젝트 스토리지가 없는 배포에서는 바이트를 떼어내지 않으므로,
raw-chunk 표면은 대신 자기 프레임에 파일을 인라인으로 실어 보낸다. 이 배포가 보관하지 못했거나
서명하지 못한 파일은 나열되는 대신 `warnings` 로 보고된다. 런이 만들어 냈는데 호출자에게 존재조차
알려 주지 않은 문서는 플랫폼이 그것을 잃어버린 것으로 읽히기 때문이다.

`warnings` 는 그 답에 이르는 길에 런이 무엇을 잃었다고 보고했는지다. 더 이상 레지스트리에 없는
바인딩, 아웃바운드 가드가 막은 MCP 서버, 런당 상한을 넘은 도구들, 잘린 transfer 전사, 빈손으로
돌아온 subagent. 스트리밍된 런은 이런 것들을 그때그때 `warning` 프레임으로 말한다. 모아서 주는
본문에는 나중의 프레임이 없으므로 이것들이 답과 함께 이동한다. 없으면 잃은 것이 없다는 뜻이다.

`stream: true`이면 JSON 본문 대신 SSE `EngineChunk` 프레임으로 답한다.
파일 프레임의 주소·손실 보고는 `/agent`와 같다. 수집형 응답에서 실행이 실패하면 모델과
upstream 이유를 포함한 502를 반환한다. 응답 전 호출자가 연결을 닫으면 실행을 취소한다.

### `POST /api/agents/{name}/chat/completions`

OpenAI Chat Completions 호환 형태로 같은 Agent 도구 루프를 실행한다.
모델은 현재 Agent 설정이 결정한다.

```text
// request
{ "model": "ignored-uses-agent-settings", "messages": [ { "role": "user", "content": "hi" } ],
  "stream": false }
// `temperature`/`max_tokens` 는 받지만 무시한다 — 샘플링은 Agent 설정에 저장된
// `parameters` 에서 온다.
// 응답: OpenAI chat.completion 객체 (stream=true 면 chat.completion.chunk SSE)
```

**이미지 입력.** 메시지 본문은 문자열 대신 OpenAI content part 여도 된다. 이미지 바이트는
`data:image/…;base64,…` URL 로 인라인 이동한다. PNG, JPEG, GIF, WebP만 받고 디코딩 크기는
하나당 5MB로 제한하며 base64 형식도 검증한다. 원격 URL은 받지 않는다. 호출자가 고른 주소를
모델 제공자에게 넘기면
이 배포의 SSRF 정책을 적용할 수 없기 때문이다. Agent 설정의 모델은 `imageInput` 능력을 가져야
한다. 아니면 `400`이며, 이미지를 읽을 수 없는 `fallbackModel`은 그 요청에서 건너뛴다.

```json
{ "messages": [ { "role": "user", "content": [
    { "type": "text", "text": "what is in this picture?" },
    { "type": "image_url", "image_url": { "url": "data:image/png;base64,iVBORw0…", "detail": "auto" } }
] } ] }
```

**이미지 출력.** Agent의 `GenerateImage` / `EditImage` 도구가 만든 이미지는
OpenAI 스키마에 자리가 없으므로 확장으로 함께 실려 간다: completion 객체의
`images: [ { b64, mimeType, prompt? } ]`, 그리고 스트림에서는 `choices[0].delta.images`
프레임이다. 이 필드를 모르는 클라이언트는 그냥 무시한다.

**파일 출력.** 같은 취급을 다시 하되 중요한 차이가 하나 있다: 문서는 그려지는 것이 아니라
*가져가는* 것이므로 주소로 이동한다. completion 객체의 `files: [ { fileId?, name, mimeType,
byteSize?, url } ]` 와 스트림의 `choices[0].delta.files` 프레임이다. 그 주소가 무엇이고 얼마나
사는지는 위 `/predict` 를 보라.

**런이 잃은 것.** 같은 취급, 같은 이유다: completion 객체의 `warnings: [ "…" ]` 와 스트림의
`choices[0].delta.warnings` 프레임이다. 런이 진행하면서 보고하는 손실이며 (위 `/predict` 참조),
이것이 없으면 이 표면에서는 성능이 깎인 런과 깨끗한 런이 같은 응답이 된다.

OpenAI 완료형 응답에는 `usage`가 포함되지만 스트리밍 응답에는 usage 프레임이 없다.
스트림의 토큰 합계는 앱 사용량·Trace에서 확인한다. raw Agent 스트림은 `usage` 축을 제공한다.

### `POST /api/agents/{name}/agent`

Agent SSE 스트림이다. 본문은 `{ "messages": [ … ] }`. `EngineChunk` 프레임을 내보낸다
(`delta.content`, `toolResult`, `warning`, `image`, `file`, subagent 턴에는 `author`,
`error`, 그리고 런이 왜 끝났는지를 밝히는 종단 `done: true` 또는 `finishReason`). 그다음
`data: [DONE]` 이다. 필드 계약 전체는
[ARCHITECTURE.md](ARCHITECTURE.md#enginechunk-계약) 에 있다.

`file` 프레임은 이 엔드포인트를 **주소가 붙은 채로** 떠난다: 런 브래킷이 붙여 둔 object key 와
artifact id 대신 다운로드용 서명 `url`과 후속 `File` 도구 호출용 `fileId`를 제공한다.
저장소 키는 외부에 노출하지 않으며 `fileId` 자체는 접근 권한이 아니다. 서명할 수 없었던 파일은, 아무것도 가져올 수 없는 문서를
지목하는 `file` 프레임 대신 `warning` 프레임으로 도착한다.

모든 Agent는 Agent이며 이 경로는 현재 저장된 설정을 사용한다.

이미 현재 transfer 사슬에 있는 agent 로의 transfer, 또는 5단계 중첩을 넘는 transfer 는 재귀하는
대신 author 가 붙은 error chunk 로 거절된다.

## 사용량

```
GET /api/usages/summary?from=2026-01-01&to=2026-01-31[&agent=my-bot]
→ 200 { "items": [ { agentName, date, calls, inputTokens, outputTokens, cachedTokens,
                     costUsd }, … ] }
      (every metric is a per-model map: { "provider/model": number })
→ 400 { "error": "…" }   (bad/oversized range: max 184 days, from ≤ to)
```

`cachedTokens` 는 `inputTokens` 중 프로바이더가 자기 프롬프트 캐시에서 서빙한 부분이며, 이미
캐시 단가로 값이 매겨져 있다. 이 필드가 존재하기 전에 기록된 날과 `prompt_tokens_details` 를
보고하지 않는 채널에 대해서는 `{}` 다. 콘솔이 `0%` 가 아니라 빈칸을 렌더링하는 이유가 이것이다:
아무도 보고하지 않는 캐시는 차가운 캐시가 아니다.

### 호출자별 지출

```
GET /api/agents/{name}/usage/actors?from=2026-07-01&to=2026-07-31
→ 200 { "items": [ { agentName, actor, calls, inputTokens, outputTokens, cachedTokens,
                     costUsd, display?: { name, avatarUrl? } }, … ],
        "totalActors": 123, "truncated": true }
```

`actor` 는 `{kind}:{id}` 다. `user:a@example.com`, `agent-token:owner@example.com` (토큰은
자기 소유자로서 인증하므로, 기계의 지출을 그 사람 자신의 런과 갈라 두는 것이 kind 다. 그리고
개인 tier 예산에 계산되는 것은 `user:` 행뿐이다),
`slack:U123`, `telegram:123456`, `teams:{Entra object id}`, 그리고 trigger 발화에는
`webhook:{agent}:{triggerId}` 또는 `schedule:{agent}:{triggerId}` 다. 지표 필드는 위 요약과
정확히 같이 모델별 맵이다.

일별 행은 서버에서 `actor` 별로 합친 뒤 비용이 큰 순서로 최대 100명을 돌려준다. `totalActors` 는
그보다 뒤에 생략된 사람까지 포함한 전체 호출자 수이고, `truncated` 는 `items` 가 상위 일부인지
알려 준다. Slack 프로필도 반환하는 호출자만 해석한다. 한 요청이 읽어야 할 일별 actor 행이
10,000개를 넘으면 조용히 일부만 집계하지 않고 400으로 거절하므로 기간을 좁혀 다시 요청하라.

`display` 는 `slack:` 행에 얼굴을 붙여 준다. 그 agent 자신의 봇 토큰으로 해석한다. 장식이며
어떤 이유로든 없을 수 있다. Slack 봇 없음, 회수된 토큰, 비활성화된 사용자, Slack 장애. 그리고
어느 경우에도 `actor` 는 그대로다. 두 호출자를 구별하는 키가 그것이기 때문이다. `telegram:` 행은
`display` 를 싣지 않는다: Bot API 는 사용자 id 로 프로필을 조회하는 방법을 제공하지 않으므로 있는
것은 id 뿐이다.

트레이스와 같은 이유로 소유자/admin 전용이다: agent *총계*는 카탈로그가 공유되므로 로그인한
사용자 누구에게나 열려 있지만, 호출자별 분해는 개인의 이름을 담는다. 범위 검증은
`/api/usages/summary` 와 같다 (두 날짜 모두 필수, `from ≤ to`, 184일 이하). 다만 여기의 거절은
`/api/usages/summary` 가 싣는 `issues` 배열이 아니라 벌거벗은 `{ error }` 다. subagent transfer 는
transfer 해 들어간 agent 가 아니라 런을 시작한 사람에게 귀속된다.

## Triggers

한 agent 는 agent 이름만으로 주소가 정해지는 **webhook 하나**와, 각각 이름을 가진 임의 개수의
**schedule** 을 갖는다. 둘 다 trigger 행이고 아래 내용을 전부 공유한다. webhook 은 예약된 id
`webhook` (`AGENT_WEBHOOK_ID`) 아래 저장되고, `create` 는 그 양쪽을 400 으로 강제한다.
webhook 은 다른 id 를 가질 수 없고, schedule 은 이 id 를 가질 수 없다. 앞의 것은 발행된 secret 이
그것을 쓸 주소도 없이 존재하는 일을 막아 준다. `/api/webhook/{agent}` 가 해석하는 것은 그 id
하나뿐이기 때문이다. 콘솔에 "webhook 만들기" 단계가 없는 것도 같은 이유다: Settings → Webhook 은
스위치이고, 그것을 처음 켜는 것이 그 행을 쓴다.

설정 (owner/admin):

```
GET    /api/agents/{name}/triggers                     → 200 { triggers: [ … ] }
POST   /api/agents/{name}/triggers                     → 201 { …, secret? }  | 409
PUT    /api/agents/{name}/triggers/{trigger}           → 200 { … }           | 404
DELETE /api/agents/{name}/triggers/{trigger}           → 204                 | 404
POST   /api/agents/{name}/triggers/{trigger}/reveal    → 200 { secret, createdAt }
GET    /api/agents/{name}/triggers/{trigger}/runs?limit=20 → 200 { runs: [ … ] }   (1–100)
```

생성 본문: `{ triggerId (slug), kind?, description?, enabled?, allowConcurrent?, cron?, timezone?, message?, deliveries?, runAsOwner?, githubReview? }`. `kind` 의 기본값은 `webhook` 이다. `schedule` 은
`cron` (다섯 필드) 과 `timezone` (IANA) 을 요구하고, 각 kind 는 상대의 필드를 무시하는 대신 400
으로 거절한다. `rotateSecret`은 webhook의 것이고,
`cron`/`timezone`/`message`/`deliveries` 는 schedule 의 것이다. `deliveries` 는 최대 3개이고
플랫폼을 중복할 수 없는 tagged union 이다: `{ kind: "slack", channelId }`,
`{ kind: "telegram", chatId, threadId? }`, `{ kind: "teams", conversationId }`. `triggerId` 는 agent 이름과 같은 규칙
(`^[a-z0-9-]+$`) 을 따른다. 콘솔은 입력한 것을 agent 폼이 쓰는 것과 같은 `toSlug` 헬퍼로
정규화하고, API 는 클라이언트가 무엇이든 그 밖의 것을 거절한다.

Schedule 생성·수정의 `runAsOwner: true`는 로그인한 소유자의 email을 `executionEmail`로 저장한다.
관리자도 다른 소유자를 대신해 켤 수 없다. `false`는 저장한 email을 지우고, 생략은 기존 값을
유지한다. Webhook에는 이 옵션을 사용할 수 없다. Admission과 실행 직전에 현재 소유권과 member
상태를 확인한다. actor는 schedule로 유지하며 검증된 email만 MCP `X-User-Email`로 전달한다.

평범한 읽기는 `secretMasked` 만 돌려준다 (webhook 에 한한다. schedule 에는 secret 이 없다).

관리자는 Webhook 생성·수정에 `githubReview: {scope:"accessible"}` 또는
`{scope:"repositories", repositories:["owner/repo"]}`를 전달할 수 있다. 수정의 `null`은 리뷰를
끄고 생략은 기존 선택을 유지한다. 저장소 목록은 최대 20개이며 wildcard·URL은 받지 않는다.
설치의 GitHub 연결이 필요하고 일반 소유자는 리뷰 권한을 새로 위임할 수 없다.
리뷰 모드는 GitHub HMAC만 받아 PR의 repository·number·HEAD를 검증한다. 비대상 이벤트는
`202 {ok:true,status:"ignored",reason}`이며 모델을 실행하지 않는다. 정상 접수는 기존 accepted
형태를 유지하고 완료 이력의 `review`에 repository·number·headSha·posted/skipped/failed와
확인된 url 또는 reason을 담는다. [PR 리뷰 계약](design/triggers.md#github-pr-리뷰)을 따른다.
secret 은 해시가 아니라 AES 로 암호화해 저장되므로. agent API 토큰과 정확히 같이.
`POST …/reveal` 로 **다시 읽을 수 있다** (본문이 살아 있는 인증 정보라서 POST 다. 소유자/admin
전용이고, 모든 reveal 은 호출자의 이메일과 함께 로그된다). `rotateSecret: true` 를 담은 `PUT` 은
그것을 재발급하고 새 것을 돌려준다. 이전 secret 은 즉시 동작을 멈춘다.

전달 (세션 없음, secret 이 인증이다):

```
POST /api/webhook/{agent}
  X-Trigger-Secret: asw_…
  Idempotency-Key: <optional>
  { "any": "json payload" }
→ 202 { ok: true, status: "accepted", runId }
→ 202 { ok: true, status: "duplicate" | "disabled" | "busy" | "no-configuration" }
→ 401 (wrong or missing secret/signature) | 404 (no webhook on this agent) | 400 (bad JSON or GitHub metadata) | 413 (>1MB)
```

GitHub도 같은 URL을 사용한다. GitHub Webhook의 Content type은 `application/json`, Secret은
이 Agent가 발급한 Webhook 시크릿으로 설정한다. `X-Hub-Signature-256`의 HMAC-SHA256을
원본 UTF-8 body로 검증하며, 직접 `X-Trigger-Secret` 헤더를 추가할 필요가 없다. GitHub 헤더가
있으면 서명 방식을 선택하고 누락·잘못된 서명에서 일반 시크릿 방식으로 폴백하지 않는다.
`X-GitHub-Delivery`와 `X-GitHub-Event`를 요구하며 delivery ID를 중복 방지 키로 쓴다.
서명된 `ping`은 `202 {ok:true,status:"ping"}`으로 연결만 확인하고 모델을 실행하지 않는다.
이 인증은 원래의 webhook actor를 유지하며 사용자 OAuth·Workspace 실행 권한을 부여하지 않는다.
Workspace PR 메타데이터 전용 `/api/workspaces/github/webhook`과는 목적과 시크릿이 다르다.

이것이 **유일한** 전달 주소다. `admitDelivery` 는 agent 이름 자체에서 그 행을 해석하고 trigger
id 를 받지 않으므로, 바깥의 무엇도 전달이 어느 webhook 에 떨어질지 지목할 수 없다.

런을 시작하는 것은 `accepted`뿐이다. `busy`·`no-configuration`은 skipped 이력을 남기고,
비활성·중복·ping은 새 실행 이력을 만들지 않는다. 202는 처리 완료를 뜻하지 않는다.

이 엔드포인트는 즉시 답하고 배경에서 실행한다. 런은 10분까지 갈 수 있고 그만큼 기다리는 webhook
발신자는 없으므로, 결과는 응답이 아니라 그 전달의 이력 행에 있다. trigger 는 언제나 그 agent 의
현재 Agent 설정을 실행한다. `succeeded` 행도 `warning` 을 실을 수 있다. 런이 실패하지
않고 보고한 것(부딪힌 턴·예산 한계, 쓸 수 없었던 바인딩)이다: 발화는 지켜보는 사람이 없고, 그
행이 그것을 위한 유일한 통로다.

Webhook JSON 본문은 사용자 메시지로 직렬화한다. 예약 실행은 저장한 `message`를 사용한다.

`allowConcurrent` 의 기본값은 false 다: 하나가 아직 돌고 있는 동안 온 두 번째 전달은 런을 쌓아
올리는 대신 `skipped` 로 기록된다.

스케줄러 tick (세션 없음, 공유 토큰이 인증이다):

```
POST /api/triggers/scan
  X-Scan-Token: <SCHEDULE_SCAN_TOKEN>
→ 200 { checked, fired, alreadyClaimed, skipped, repaired, invalid, errors }
→ 401 (wrong or missing token) | 503 (SCHEDULE_SCAN_TOKEN not configured)
```

`fired`는 `queued`로 접수한 발생 수이며 모델 실행의 시작·완료 수가 아니다. Schedule 이력은
접수 시 `queuedAt`·`queueLeaseUntil`을 가지며, 실제 실행 시작 시 `running`과 `startedAt`을
기록하고 `queueLeaseUntil`을 제거한다. 시작하지 못한 `queued`·실패 이력에는 `startedAt`이
없을 수 있다. `runId`와 `scheduledFor`는 상태 전이 중 유지한다.

배포 환경의 ticker가 1분에 한 번 호출하는 것이다. ticker 는 상태를 쥐지 않는다: 어느 발생분이
도래했는지와 각각을 누가 차지하는지는 조건부 쓰기로 발생분마다 서버 측에서 결정된다. 그래서 두 번
ticking 하든, 여러 곳에서 하든, 늦게 하든 절대 이중 발화하지 않는다. admit 된 발화는 webhook 전달과
정확히 같이 배경에서 실행되고, 그 결과는 그 trigger 의 이력 행에 남는다 (`scheduledFor` 가 발생분을
싣는다). 목적지가 설정된 schedule 은 성공한 텍스트 답을 각 플랫폼으로 전송하고, 이력의
`deliveryResults` 에 플랫폼별 `sent`/`failed` 를 남긴다. 전송 실패는 성공한 런을 실패로 바꾸지
않고 `warning` 에도 기록된다. `alreadyClaimed` 는 다른 tick 이 이미 차지한 발생분의 수다. 겹치는 창에서 나오는 예상된
잡음이지 이상 징후가 아니다. 같은 요약이 매 tick 마다 서버 측에 로그되며, 운영자가 알림을 거는 것이
그것이다.

카탈로그 reindex (같은 공유 토큰, 별도 CronJob):

```
POST /api/catalog/reindex
  X-Scan-Token: <SCHEDULE_SCAN_TOKEN>
→ 200 { started: true }
→ 401 (wrong or missing token)
→ 503 (SCHEDULE_SCAN_TOKEN not configured — answered before the token is compared, so a
       deployment missing it gets this rather than a 401) | 503 ("CATALOG_ENABLED is not set")
```

전역 capability 인덱스를 레지스트리에서 다시 만든다. 모든 Skill과 MCP 서버·도구를 색인하고
레지스트리에서 사라진 항목은 지운다. 작업은 배경에서 돌아가므로 결과는
응답 본문이 아니라 로그 한 줄(`indexed`, `removed`, `undiscovered`)이다. 두 번 ticking 해도
안전하다: 키가 항목에서 유도되므로 두 번째 패스는 같은 레코드를 쓴다. 시간당 한 번이면 충분하다.
더 빠른 tick 은 모든 MCP 서버를 더 자주 찔러 볼 뿐이다.
[OPERATIONS.md](OPERATIONS.md#카탈로그-재색인) 를 보라.

## Artifacts

런이 만들어 낸 것. 이미지와 문서. 을 각각의 주소와 함께 담는다. `S3_BUCKET_NAME` 이 설정돼
있을 때만 존재한다. 그렇지 않으면 아래 모든 라우트가 빈 목록이 아니라 `404 {error}` 로 답하는데,
"당신은 만든 것이 없다"와 "애초에 아무것도 보관되고 있지 않았다"는 서로 다른 주장이기 때문이다.

```
GET /api/artifacts?[kind=image|document|audio][&source=generated|attachment][&limit=24][&before=…][&from=2026-08-01&to=2026-08-12]
→ 200 { artifacts: [ … ], nextBefore?: "2026-08-11T22:03:00.000Z#8f0c…" } | 400 | 404
GET /api/agents/{name}/artifacts?…same query…
→ 200 { artifacts: [ … ], nextBefore?: … } | 400 | 403 | 404
DELETE /api/artifacts/{artifactId}
→ 204 | 403 | 404
GET /api/artifacts/{artifactId}/view
→ 200 text/html | 400 | 403 | 404
```

`/view`는 지원되는 텍스트 기반 파일을 HTML 응답으로 렌더링한다.
PDF·Office 등 대상이 아닌 MIME은 400으로 거절한다.
바이트를 반환하는 다른 경로로 proxied 객체와 비공개 파일 다운로드가 있으며 각각 인증 계약이 다르다.

응답은 `text/html; charset=utf-8` 이다. 저장된 HTML 은 선언된 charset 으로 디코딩한 뒤
원문을 이스케이프한 iframe `srcdoc` 속성에 넣은 실행 화면으로 응답한다. 다른 타입도 앱이 UTF-8 view를 만든다.

| 저장된 타입 | 어떻게 보이는가 |
|---|---|
| `text/html` | 페이지를 열면 CSS·JavaScript·입력·canvas·SVG를 별도의 sandbox iframe에서 즉시 실행한다. 중지·다시 시작을 제공한다 |
| `text/markdown` | 채팅 스레드와 같은 렌더러로 렌더 |
| `text/csv` | 첫 행을 머리행으로 삼은 표 (RFC 4180 파싱, 2,000행 상한) |
| `application/json` | 다시 들여쓴 텍스트. 파싱되지 않으면 원문 그대로 + 그 사실을 말한다 |
| `image/svg+xml` | `<img>` 안의 그림 |
| `text/plain` | 원문 그대로 |

HTML 이외에는 스크립트 없는 `ARTIFACT_VIEW_POLICY`를 적용한다. HTML 실행 화면은
`INTERACTIVE_HTML_VIEW_POLICY`와 iframe의 `sandbox="allow-scripts"`를 함께 적용한다.
원문은 바깥 화면의 DOM에서 실행되지 않으며 iframe은 별도의 불투명 origin을 갖는다.
부모·콘솔 DOM, 쿠키, localStorage에 접근할 수 없다. 일반 웹 요청, 외부 프레임 이동,
폼 제출, 팝업은 제한한다. WebRTC 등 모든 브라우저 통신을 차단하는 환경은 아니다.
미리보기를 여는 즉시 HTML 코드가 실행된다. 수정 상태는 파일에 저장되지 않는다.
정책은 `htmlSafety.ts`, 실행 화면은 같은 디렉터리의 `interactiveHtml.ts`가 소유한다.

서명된 오브젝트 URL 로는 그 헤더를 실을 수 없고, 건네진 주소는 그것을 연 사람의 권한보다
오래 산다. public 모드에서는 영구다. `/view`는 매 요청 session으로 읽기 권한을 확인한다. 읽기 상한은
2 MB 이고, 권한 술어는 삭제와 같다.

```
GET /api/objects/{...key}?exp=<unix>&sig=<hmac>[&dl=<filename>]
→ 200 <the object's bytes, its Content-Type> | 403 (invalid or expired) | 404 (not stored,
  or artifact storage is not configured)
```

`/api/objects` 는 `ARTIFACT_ACCESS_MODE=proxied` 에서 모든 서명 `url` 이 가리키는 곳이다.
스토어가 앱에게만 닿는 배포에서 독자에게 건네는 주소. **세션을 보지 않는다**: 주소를 쥐는
것은 브라우저 이미지·파일 링크와 메신저 같은 독자이며 token이 자격 증명이다(키·
만료·파일명을 덮는 HMAC. [SECURITY.md](SECURITY.md#데이터-노출과-보존)). `dl` 이 있으면
`Content-Disposition: attachment` 로 그 이름에 내려가고, 없으면 인라인이다. 응답은
`Cache-Control: private, max-age=<토큰의 남은 초>` 를 싣고, 브라우저가 문서로 그릴 수 있는
타입 중 raster image 와 PDF 를 제외한 것은 정적 view와 같은
`sandbox; default-src 'none'` 아래로 나간다. raster image 와 PDF 는
`frame-ancestors 'none'` 만 적용한다. 한 번에 읽는 상한은 저장될 수 있는 오브젝트의 최대인
10 MB 다.

각 행은 `artifactId`, `kind`, `source`, `key` (object key), `mimeType`,
`byteSize`, `filename?`, `derivedFrom?` (수정본의 원본 artifact ID), `agentName`, `actor?`, `ownerEmail?` (Slack 런의
출력이 누구 앞으로 정리되는지. 물어본 사람에서 해석한다), `ancestry?` (transfer 사슬. 바깥쪽이
먼저), `producedBy?`, `model?` (그린 모델. 이름을 댈 수 있는 생산자만. MCP 도구의
그림, 렌더링된 문서, 첨부는 비어 있다), `runId?`, `prompt?`, `createdAt`, 그리고 서명된 `url` (15분. 문서의 것은
자기 이름으로 내려받도록 서명된다) 을 싣는다. URL 은 타일마다 가져오는 대신 인라인으로 들어간다.
사전 서명은 로컬 서명이라 한 페이지치가 비용이 들지 않는 반면, 각각 왕복하면 갤러리가 N+1 이 된다.
주소를 만들 수 없으면 없으며, UI 는 그것을 깨진 이미지가 아니라 사용 불가로 렌더링한다.

**두 목록은 한 집합의 두 가지 뷰가 아니다.** `/api/artifacts` 는 소유자 인덱스를 읽는데, 여기에는
actor 가 이메일을 지목하거나 표면이 소유자 이메일을 해석한 행만 들어 있다. Slack 런은 질문한
사람의 이메일을 해석할 수 있으면 이 목록에도 들어가고, 조회가 실패하면 agent 에만 남는다.
개인 이메일 문맥이 없는 Webhook·Schedule 결과는 Agent 목록에서 관리한다.
소유자가 개인 문맥을 설정한 Schedule 결과는 개인 목록에도 귀속될 수 있다. `from`/`to` 는 실재하는 날짜로 검증되는 UTC 일이고, `before` 는 이전 페이지의
`nextBefore` 다.

삭제는 생성자, 그 agent 의 소유자, 그리고 effective admin 에게 허용된다. 남의 출력을 지우면
`artifact.delete` 감사 행이 기록되고, 자기 것을 지우면 그렇지 않다. chat 메시지는 object key 의
사본을 자기가 갖고 있으므로, 여기서 지운 이미지는 그것을 보여 주던 전사에서 사용 불가로 렌더링된다
확인 절차가 그렇게 되기 전에 그 사실을 말해 준다.

## 트레이스

```
GET /api/agents/{name}/traces?limit=50[&from=2026-07-01&to=2026-07-31][&actorKind=slack]
→ 200 { traces: [ … ] } | 400
GET /api/agents/{name}/traces/{traceId}
→ 200 { …the trace itself, unwrapped… } | 404
```

`from`/`to` (YYYY-MM-DD, 양끝 포함) 는 GSI1 날짜 키로 목록을 트레이스 날짜로 거른다. 잘못된
형식의 날짜나 뒤집힌 범위는 `400` 이다. `limit` 의 기본값은 50 이고 1–100 으로 제한된다.
`actorKind` 는 `user`·`agent-token`·`slack`·`telegram`·`teams`·`webhook`·`schedule` 중 하나이며,
해당 실행 주체로 저장된 Trace만 `limit` 전에 거른다. 전달 성공 여부는 Trace 상태와 별개다.
다른 agent 에 속한 `traceId` 는 남의 트레이스가 아니라 `404` 다.

두 엔드포인트 모두 소유자와 effective admin으로 제한된다(그 외에는 403). agent 런은 항상
기록한다. SDK 실행은 Agent·모델·도구·
Handoff·MCP listing·Guardrail span을 저장한다. `spanId`, `parentSpanId?`, 종류·이름·상태·시간과
모델 사용량을 보존하고 text 자식은 같은 앱 Trace의 native 계층에 들어간다.
`prepare`에는 준비한 capability 수와 발견한 이름 최대 20개를 기록한다.

원본 프롬프트와 도구 결과는 span에 저장하지 않는다. 실행 오류·경고에는 잘린 원문 오류가
포함될 수 있다. Trace의 종료 상태는 `completed`, `awaiting-approval`, `turn-limit`,
`output-limit`, `failed`, `cancelled`다. `actor`는 실행을 일으킨 사람이며 대화의
`conversation` 키도 기록한다(`chat:{id}`, `slack:{channel}:{thread}` 등). 대화 키는 아직
목록 필터나 인덱스로 제공하지 않는다. 기록 범위는 [관측 설계](design/observability.md#trace)를 따른다.

## Models

`/models` 화면은 선택·등록된 모델의 목록과 검색, 개인 즐겨찾기 관리를 제공한다. 등록·수정·삭제·상태 확인과
모델 사용 설정은 Settings → Models에서 관리한다.

모델 등록·선택·기본값·상태 검사는 admin 전용이며 목록은 member부터 읽는다.
`GET /api/models`는 로그인한 사용자에게 등록된 실행 모델(Text·Image)을 제공한다.
연결이 없는 모델은 제공하지 않으며 기본 모델을 먼저 정렬한다. 즐겨찾기는 사용자별이다.

| API | 계약 |
|---|---|
| `GET /api/models/discover?provider=<name>` | 등록한 공개 Provider의 모델을 `models.opspresso.com/models.json`에서 조회한다. 실패·폐쇄망에서는 내장 스냅샷을 사용한다. `selfhosted`는 해당 내부 연결의 목록을 조회한다. `{ models: [{ id?, wireId, displayName, family?, maker?, type?, inputModalities?, outputModalities?, contextWindow?, maxTokens?, capabilities?, pricing? }] }`. 공개 모델의 `id`는 API의 키다. 조회는 모델을 활성화하지 않는다 |
| `GET /api/models/registry` | `{ models: RegisteredModelView[] }`. 관리자가 선택하거나 직접 등록한 모델만 반환한다. 공개 가격이 적용되면 현재 가격과 `pricingSource: "catalog"`를 표시한다 |
| `POST /api/models/registry` | `{ id, provider, wireId, displayName, family?, maker?, type, inputModalities?, outputModalities?, contextWindow, maxTokens, capabilities, pricing? }`를 저장하고 갱신된 목록을 반환한다. 공개 모델의 `id`는 models API의 키와 일치해야 하고 `wireId`는 실제 전송 ID다. 내부 모델 ID는 `provider/wireId`다. 타입은 `text`, `image`, `transcription`, `embedding`, `rerank`, `decision`이다 |
| `DELETE /api/models/registry?id=<id>` | 미사용 모델을 삭제한다. 성공 204, 현재 기본·결정·검색·Workspace에서 사용하면 409 |
| `GET /api/models/status?id=<id>` | 등록 모델이 공개 카탈로그 또는 내부 `selfhosted` 목록에 있는지 `{ available }`로 반환한다. 실제 추론 성공을 뜻하지 않는다 |
| `GET /api/models/default` | `{ model: string | null }` |
| `PUT /api/models/default` | `{ model }`. 도구 호출을 지원하는 등록 Text 모델을 선택한다 |
| `GET /api/models/decision` | `{ model: string | null }`. Agent 추천에 쓰는 전역 결정 모델 선택 |
| `PUT /api/models/decision` | `{ model: string | null }`. OpenRouter 또는 System One 호환 연결의 등록된 Decisions 모델을 선택하거나 해제한다 |
| `GET /api/models/catalog` | 등록 모델의 runtime facts, 현재 검색 선택, `catalogMinScore`·`rerankerMinScore`·`unknownModelPolicy`의 유효 값과 출처, 검색 기능 활성 여부와 사용자 즐겨찾기를 반환한다 |
| `PUT /api/models/selection` | `{ type: "embedding" | "rerank", model, migrate?, catalogMinScore?, rerankerMinScore? }`. Embedding 변경은 `migrate: true`와 전체 재색인을 요구하며 Rerank는 probe 후 저장한다. 점수만 변경할 때는 재색인·probe가 필요하지 않다. Embedding 변경과 함께 보낸 점수는 재색인 실패 시 이전 값으로 복원한다 |
| `GET /api/models/workspace` | Runtime별 선택·호환 모델의 runtime facts·사용자 즐겨찾기와 사용 가능한 Runtime 목록 |
| `PUT /api/models/workspace` | `{ runtime, model: string | null }`. 등록된 호환 모델을 선택하거나 해제한다 |
| `GET/PUT /api/models/favorites` | 사용자별 `{ models: string[] }` 조회·전체 교체 |
| `PATCH /api/models/favorites` | `{ model, favorite: boolean }`으로 개인 즐겨찾기 한 개를 원자적으로 추가·제거하고 `{ models: string[] }` 반환 |
| `POST /api/models/test` | `{ model }`로 Text·Decisions·Image·Rerank의 실제 호출을 수행하고 `{ ok, latencyMs, error? }`를 반환한다. Decisions는 Choice 엔드포인트를 사용한다. 호출 비용이 발생할 수 있다 |

`POST /api/agent-recommendations`는 `{ surface: "chat" | "workspace", request: string }`을 받고
`{ recommendation: { name, confidence } | null }`을 반환한다. 입력은 1–4,000자다. 서버가
로그인 사용자의 접근 가능한 Agent만 조회하며 Workspace는 도구 정책이 활성화된 Agent로
좁힌다. 미설정·적합한 Agent 없음은 `null`이고 모델 호출 실패는 502다. 사용자별 분당 120회,
UTC 하루 2,400회를 넘으면 `Retry-After`가 포함된 429를 반환한다. 추천은 실행 대상이나
Agent의 모델 설정을 자동 변경하지 않는다. 입력 중인 요청과 후보 설명은 공통 PII 필터를
거쳐 선택한 provider로 전달된다.

등록 모델은 최대 500개다. 가격 미제공은 `pricingKnown: false`로 표시하며 명시적 0과 구별한다.
모델 선택기는 표시 이름·등록 ID·provider·유형별 가격을 공통으로 보여준다. 개인 즐겨찾기는
`/models`에서 변경하며, 선택기에서는 provider 그룹보다 먼저 표시한다.
선택 옵션 응답에서는 개인 즐겨찾기 조회가 실패해도 모델 목록을 반환하며 `favorite: false`로 표시한다.
즐겨찾기 전용 API는 읽기 실패를 오류로 반환한다.
공개 Provider는 카탈로그가 제공하는 `id`·유형·한도·기능·가격을 사용하고, 별도의
`wireId`를 전송 ID로 사용한다. 숨김 모델은 새 조회 목록에서 제외한다. 내부 `selfhosted`는
응답의 명시적 유형·출력 modality를 이름 추정보다 우선한다. 지원 parameter가 객체로 오면
명시적으로 `true`인 항목만 지원 기능으로 취급한다. 어느 조회도 실행 레지스트리를 자동 변경하지 않는다.
UI의 추가 버튼은 조회한 facts를 즉시 저장한다. 공개 모델은 API에 있는 ID만 등록한다.
내부 모델에 유형 정보 자체가 없으면 행 안에서 유형을 선택해야 하며, 지원하지 않는 출력
프로토콜을 Text로 변환해 등록하지 않는다.
조회 실패나 프로바이더의 목록 변경은 저장된 선택을 자동 삭제하지 않는다. 모델 선택의 DB
변경은 설정 캐시 TTL 이내에 다른 인스턴스에도 적용된다. 모델의 URL·키는 응답에 포함하지 않는다.
등록된 공개 모델의 실행 요금은 동일한 Provider 종류와 `wireId`가 일치하는 카탈로그 가격을
우선한다. 갱신이 활성화된 웹 서버·오디오·Workspace worker는 실행 중 15분 간격으로 공개 가격을 다시 조회하며,
오류 시 마지막으로 검증된 가격을 유지한다. Provider가 호출 비용을 직접 보고하면 그 값을 우선한다.
카탈로그의 `discount`가 있더라도 표시된 단가는 이미 할인이 반영된 금액이므로 다시 할인하지 않는다.
카탈로그 관리 가격은 Registered models 화면에서 읽기 전용으로 표시한다.

## 플랫폼 엔드포인트

```
GET /api/health   → 200 (static)
GET /api/ready    → 200 { ready: true, checks: { db, llm } }
                  | 503 { ready: false, draining: true }          (after SIGTERM)
                  | 503 { ready: false, checks: { db, llm } }     ("ok" | "unreachable" each)
GET /api/metrics  → 200 text/plain; version=0.0.4
```

`/api/health` 는 liveness 다. "프로세스가 서빙하고 있는가"에 답하는 정적 200 이고, 의존성이
없어서 하류의 순간적인 문제가 재시작을 유발하지 않는다. `/api/ready` 는 readiness 다. PostgreSQL 과
LLM 채널을 찔러 보고 (짧은 타임아웃, 상세는 드러내지 않는다), 하류에 닿을 수 없거나 인스턴스가
SIGTERM 이후 draining 중이면 503 을 돌려준다.

`/api/metrics` 는 Prometheus scrape 이고 `agent_studio_active_runs`,
`agent_studio_oldest_active_run_seconds`, `agent_studio_build_info`,
`agent_studio_runs_{started,finished,failed}_total`, `agent_studio_run_duration_seconds`,
`agent_studio_unknown_model_calls_total`, `agent_studio_unknown_models`,
`agent_studio_draining` 과 Node.js process CPU·메모리·event loop 지표를 노출한다. 어떤 지표에도
agent·사용자·모델 라벨은 붙지 않는다. build 정보만 값의 범위가 제한된 `version`·`stage`
라벨을 지닌다.

셋 다 일부러 비인증이고 의존성이 가볍다. 세션이 없는 인프라가 이것들을 찔러 보기 때문이다.
연결하는 방법은 [OPERATIONS.md](OPERATIONS.md#헬스-프로브) 를 보라.

## 오디오 작업과 원본 파일

아래 경로는 member session과 Agent 소유자 권한을 요구한다. 실행 사용자 email은 session에서
결정하며 body로 전달할 수 없다. 기존 `S3_BUCKET_NAME`을 사용하며 전사가 포함된 작업에는 전사 채널 설정도 필요하다.

| Method | 경로 | 계약 |
| --- | --- | --- |
| POST | `/api/agents/{name}/source-references` | `{url, namespace, itemId, filename, mimeType}` → 201 `{sourceRef, filename, mimeType}`. URL은 암호화한다 |
| POST | `/api/agents/{name}/source-files?unit=months&value=3&timezone=Asia%2FSeoul` | raw 파일 body, Content-Type과 percent-encoded `X-Filename` → 201 SourceFile metadata |
| GET | `/api/agents/{name}/source-files/{file}` | 개인 파일 다운로드. 만료되면 거절하며 항상 attachment·no-store로 반환한다 |
| GET | `/api/artifacts/{artifactId}/download` | 비공개 원본·결과 Artifact 다운로드. 소유자 session을 확인하며 공개 서명 URL로 전환하지 않는다 |
| GET | `/api/agents/{name}/audio-options` | 설정된 전사 모델의 runtime facts·사용자 즐겨찾기 목록과 Agent 현재 설정에 바인딩된 MCP 이름 목록. 실제 저장 기능은 제출 시 검증한다 |
| GET | `/api/agents/{name}/audio-config` | 현재 Agent 작업 설정 또는 null. 소유자만 읽는다 |
| PUT | `/api/agents/{name}/audio-config` | `{revision, enabled, model, language?, retention, postprocess?, destination?, maxActive, maxPerOccurrence}` → 다음 revision. 최초 revision은 0, 충돌은 409 |
| POST | `/api/agents/{name}/audio-jobs` | 작업 제출 → 202 accepted/duplicate, 접수 한도 초과·경합은 409 busy |
| GET | `/api/agents/{name}/audio-jobs?limit=20&after={id}` | `{jobs, nextCursor}`, limit 1–100. 다른 사용자 작업은 limit 전에 제외한다 |
| GET | `/api/agents/{name}/audio-jobs/{job}` | AudioJobView |
| POST | `/api/agents/{name}/audio-jobs/{job}` | `{action: "cancel" \| "retry" \| "delete", revision}`. 변경된 revision 또는 허용하지 않는 상태는 409 |

`maxActive`는 대기·진행을 합친 비종료 작업 상한이고, `maxPerOccurrence`는 한 Agent 실행의
신규 접수 상한이다. 여러 작업을 접수해도 worker는 Agent별 접수 순서대로 한 건씩 실행한다.

작업의 `source`는 `{kind:"artifact", artifactId}`, `{kind:"file", fileId}` 또는
`{kind:"source", sourceRef}`다. artifact는 같은 사용자가 소유한 다른 Agent의 비공개 결과도 재사용하며,
file은 해당 Agent의 업로드·보관 파일이다. 원본 URL과 외부 녹음 ID는 파일 ID를 대신하지 않는다.

`task`는 `import | transcribe | postprocess | process`이며 기본은 `process`다.

- import는 보관만, transcribe는 전사까지 수행한다. transcribe와 process에는 등록된 Transcription model이 필요하다.
- postprocess는 전사 Artifact와 `{agentName}` 후처리 대상을 받아 ASR 없이 처리한다.
  model·language·destination·configRevision을 함께 보낼 수 없다.

retention은 `{unit:"days"|"months", value:양의 정수, timezone:IANA 시간대}`다.
language는 전사에 사용하는 선택적 2–3자 언어 코드다. 같은 Agent·사용자·source identity·
task·processingRevision은 duplicate로 기존 작업을 반환한다. 명시적인 새 processingRevision은
같은 원본의 재처리를 요청하며 설정 변경만으로 기존 작업을 다시 처리하지 않는다.

postprocess는 현재 Agent 설정을 접수 시점에 고정한다. 재시도 중 모델·지시문·전달 설정을 다시 선택하지 않는다.
configRevision을 지정하면
서버가 해당 revision의 model·language·retention·postprocess·destination을 읽는다. source와
명시적 processingRevision 외의 처리 override는 섞지 않으며 task는 생략하거나 process여야 한다.
revision 충돌은 409다. enabled=false는 신규 제출·수동 재시도를 막으며 기존 작업 snapshot은 바꾸지 않는다.
Agent의 admission 한도는 요청별 설정에도 적용한다. 설정 소유자가 바뀌면 현재 소유자가 다시
저장하기 전까지 제출·재시도를 거절한다. 설정 행에는 credential이나 Agent 설정 본문을 저장하지 않는다.

`destination: {serverName, documents, memories}`는 명시적으로 선택한 외부 복사 경로다.
해당 MCP는 원래 Agent의 현재 설정에 연결되어 있고 멱등 수집 도구를 제공해야 한다.
기본 Artifact 처리에는 destination이 필요하지 않다. 사용자 요청에 따른 `personal-records` skill의
직접 기록도 사용할 수 있으며 무인 수집 기본 설정에는 외부 저장 대상을 지정하지 않는다.

AudioJobView는 id·task·sourceIdentity·status·stage·model·createdAt·updatedAt·dueAt·attempt·failures·
revision과 선택적인 configRevision·fileId·fileInfo·transcriptionProgress·postprocessProgress·transcriptRef·draftRef·
movedTo·receipts·errorCode를 반환한다. `artifacts`는 source·transcript·processed·structured·dialogue의
Artifact ID를 제공한다. `transcriptAgentName`은 전사 파일을 읽을 Agent다.
fileInfo는 filename·byteSize·expiresAt, transcriptionProgress는 processedSeconds·totalSeconds·completedSegments다.
postprocessProgress는 phase(`extract`·`reduce`·`saving`)·round·completed·total이다.
건수는 현재 추출·통합 회차 또는 결과 파일 저장 단계 기준이며 전체 작업의 퍼센트가 아니다.
전사는 첫 구간 요청 전에 전체 길이를 기록하고, 후처리는 각 구간 검증·저장 뒤 완료 건수를 기록한다.
본문·원본 URL·암호문·내부 중복 방지 키는 목록에 넣지 않는다.

접수 거절은 `{status: "busy", reason}`이며 reason은 `active_limit`(동시 작업 한도),
`occurrence_limit`(현재 Agent 실행의 신규 접수 한도), `conflict`(상태 경합)다.
발생당 한도는 앞 작업이 완료돼도 복원되지 않는다. Agent 도구는 이 거절을 `Error:`로 반환하고,
같은 실행에서 반복 조회·재제출하지 않도록 원인과 다음 행동을 안내한다.
다운로드·전사·요약 요청은 `AudioJob {request:{operation:"submit",...}}`과 config_revision으로 한 작업에 등록한다.
`ImportFile`은 가져오기만, `TranscribeAudio`는 가져오기·전사까지만 수행하며 후처리를 이어가지 않는다.
전사 Artifact를 transcribe/process의 오디오 입력으로 접수하면 400이다. 기존 전사문 요약은
postprocess 작업으로 요청하며 이 입력 오류는 접수 한도를 소비하지 않는다.

제출 응답의 accepted/duplicate/busy와 job.status는 다르다. job.status가 completed라면 마지막
stage가 importing이나 cleaning이어도 끝난 작업이다. movedTo는 외부 문서 복사 ID이며 Artifact 삭제를
뜻하지 않는다. cleaning은 checkpoint만 정리하고 원본·최종 결과는 보존 만료까지 유지한다.
원본 파일은 설정된 기간 후 삭제하지만 작업 이력·중복 방지 기록은 남긴다.

삭제는 completed/failed/blocked/cancelled에 적용하며 `{deleted: true}`를 반환한다. 작업 이력과 해당
중복 방지 키를 한 transaction으로 삭제하므로 같은 입력을 새 발생에서 다시 제출할 수 있다.
원본·파생 Artifact와 외부 저장 결과는 삭제하지 않으며 기존 만료 정책을 유지한다. 실행 중인 작업은
먼저 취소한다. 삭제 자체가 새 가져오기나 전사를 시작하지 않으며 발생당 접수 한도를 초기화하지 않는다.
취소는 queued/running/waiting에, 수동 재시도는 failed/blocked에 적용한다. 자동 재시도는 최초 시도
포함 최대 5회이며 수동 재시도는 새 24시간 실행 구간을 시작한다. 생성 시각·완료 단계·파일 보존 만료는
유지한다. 202나 제출 성공만으로 처리 완료를 보고하지 않는다.

Agent 설정의 `parameters.audioProcessing=true`는 ImportFile·TranscribeAudio·AudioJob을 제공한다.
AudioJob 도구 인수는 `{request:{operation,...}}`이며 operation별 입력은 분리된다.
config는 operation만, list는 cursor·limit, status는 job_id, read는 job_id·cursor·limit·result_kind를 받는다.
submit은 source `{kind:"artifact"|"file"|"source",id}`·config_revision·processing_revision만 받는다.
postprocess는 artifact_id·postprocess·retention·processing_revision을 받고, process는 source와 명시적 처리 옵션을 받는다.
선택값은 null로 지정하며 선택하지 않은 작업의 필드나 빈 문자열을 넣지 않는다.
ImportFile·TranscribeAudio도 source `{kind,id}`를 사용한다. HTTP 작업 API의 source·task 계약은 별도다.
각 도구는 현재 사용자·Agent·발생 ID에 바인딩된다. source 인수는 artifact_id·file_id·source_ref 중
하나이고 원본 URL·임의 email은 받지 않는다. 세 제출 도구 모두 processing_revision을 지원한다.
AudioJob read는 최대 20,000자씩 전사문을 반환하고 nextCursor로 이어 읽는다.
`result_kind:"processed"`는 후처리 본문이다. 로컬 본문 참조 없이 외부 복사 정보만 있는 작업에서만
`{status:"moved", destination:movedTo, jobStatus}`를 반환한다. 원본 JSON에는 text·segments·model·
coverage·원본 checksum·사용량 receipt 참조가 포함된다.

개인 문맥 Schedule은 [Triggers](#triggers)의 `runAsOwner` 계약을 따른다.

MCP binding의 `sourceOutputs`는 도구의 JSON 응답을 파일 참조로 변환한다. 항목은
`{tool, namespace, urlPath, idPath, namePath?, mimeType, refreshArgument?}`이며 경로는 object key 배열이다.
도구당 한 항목, binding당 최대 8개, 경로 깊이 최대 8개다. 예시는 다음과 같다.

```json
{
  "name": "files",
  "sourceOutputs": [{
    "tool": "fetch_asset",
    "namespace": "account-a",
    "urlPath": ["asset", "downloadUrl"],
    "idPath": ["asset", "id"],
    "namePath": ["asset", "name"],
    "mimeType": "audio/mpeg"
  }]
}
```

변환은 MCP 결과가 잘리기 전에 실행된다. 모델과 trace에는 `source_ref`, `filename`, `mime_type`,
`source`, `external_id`만 전달하며 원본 응답의 다른 URL·notes는 전달하지 않는다. 잘못된 응답,
미설정 storage, 없는 사용자 문맥에서는 Error 결과를 반환하며 원본으로 fallback하지 않는다.
namespace는 연결 계정을 식별하는 운영자 설정이며 계정이 달라지면 새 namespace를 사용한다.

`refreshArgument`를 설정하면 해당 읽기 도구를 원래 item ID 하나로 다시 호출할 수 있다. 문자열 또는
정수 ID 인수 하나만 필요한 조회 도구에 사용한다. 재조회 recipe는 접수된 작업에 보관되므로 임시
source_ref 행이 만료돼도 최초 다운로드 직전에 새 URL을 얻는다. 원본을 이미 보관했다면 재조회하지 않는다.
서버 주소·등록 header·binding·OAuth authorizationEpoch를 재조회 전후 비교하며 일반 access token
갱신은 세대를 바꾸지 않는다. 재인증·연결 교체·다른 item 반환은 자동 재개를 차단한다.
raw URL은 작업에 복제하지 않으며 새 URL에도 동일한 다운로드 URL 정책을 적용한다.

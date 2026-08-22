# API 레퍼런스

Agent Studio 의 HTTP 계약: 모든 라우트, 각각이 어떻게 인증하는지, 그리고 자명하지 않은
것들의 요청 / 응답 형태와 에러 케이스.

어떤 표면이 *왜* 이런 모습인지에 대한 설계 근거는
[ARCHITECTURE.md](ARCHITECTURE.md) 에 있고, 인가(authorization) 모델은
[SECURITY.md](SECURITY.md) 에 정리돼 있다.

## 규약

- **Content type**: 따로 언급하지 않는 한 요청과 응답은 JSON 이다. 스트리밍 응답은
  `text/event-stream` 이다.
- **Auth**: 애플리케이션 라우트는 Better Auth 세션 쿠키를 요구한다 (Google OAuth 로그인.
  로컬 개발에서는 `scripts/dev-session.ts` 가 하나 출력해 준다). 세션이 없거나 유효하지 않으면 →
  `401 { "error": "Unauthorized" }`. 로그인 플로우 자체는 `/api/auth/*` 아래에 있다
  (Better Auth catch-all). 실행 엔드포인트 셋(`predict`, `chat/completions`,
  `agent`)은 세션 쿠키 대신 `Authorization: Bearer <token>` 으로 오는 **project 별 API 토큰**도
  받는다. 토큰은 project 소유자를 대신해 동작하며 그 project 범위로 한정된다
  (참고: [Project API 토큰](#project-api-토큰)). AG-UI 엔드포인트(`/api/agui/{project}`)도
  같은 게이트다. 기계 표면은 게이트가 다르다:
  `/api/a2a/*` 는 `X-A2A-Key`, `/api/slack/events/*` 는 Slack signing secret,
  `/api/telegram/webhook/*` 는 Telegram 이 되돌려 주는 secret token, `/api/teams/messages/*` 는 Bot
  Framework 가 서명한 토큰, `/api/webhook/{project}` 는
  그 webhook 자신의 secret, `/api/triggers/scan` 은 배포의 `SCHEDULE_SCAN_TOKEN` 이다. `/api/health`, `/api/ready`, `/api/metrics` 는 열려 있다.
- **Authorization**: project 는 공개 범위를 갖는 공유 카탈로그다 — `public`(기본값) 은
  로그인한 누구나 읽고 실행하고, `private` 은 소유자·초대 멤버·admin 만이다
  ([SECURITY.md](SECURITY.md#인가-모델), 그 외에는 `403 { "error": "Project \"…\" is private" }`).
  변경(수정/삭제/publish, version 생성/수정, Slack·Telegram 설정)은 공개 범위와 무관하게
  소유자와 설정된 admin 만 할 수 있고, 그 외에는
  `403 { "error": "You do not have permission to modify project \"…\"" }` 이다.
  다른 사용자의 런타임 데이터나 마스킹된 secret 을 드러내는 project 하위 리소스 — 트레이스,
  Slack·Telegram 설정, API 토큰, trigger, 호출자별 사용량, MCP 연결 — 은
  *읽기*도 소유자와 admin 으로 제한된다. Chat 은 소유자에게만 비공개다 (소유자가 아닌 읽기는
  404 를 돌려준다). MCP/agent/skill/plugin 레지스트리와 모델 카탈로그(`/api/models/catalog`)는
  **`member` tier 이상**에게 읽기가 공유된다 — 모든 가입자가 시작하는 tier 인 `guest` 는
  `403 { "error": "This resource is not available to your account" }` 을 받는다 (`withMemberAuth`).
  변경은 `ADMIN_EMAILS` 가 설정돼 있으면 그 목록에 속해야 하고 (설정되지 않았으면 로그인한
  사용자 누구나 허용), 그렇지 않으면 `403 { "error": "Only admins can modify this resource" }` 이다.
  project 생성도 마찬가지로 tier 능력이다: 그 능력이 없는 tier 는
  `403 { "error": "Your tier does not allow creating projects" }` 을 받는다.
- **Errors**: `{ "error": string }` 이고, 스키마 검증 실패에는 `issues` 배열이 추가로 붙는다.
  상태 코드: `400` (잘못된 입력), `401` (세션 없음), `403` (소유자/admin 아님),
  `404` (없음), `409` (이름 충돌), `413` (페이로드 과대), `429` (지금은 거절 —
  아래 참조), `500` (처리되지 않음), `502` (이 앱이 호출한 상류가 실패), `503` (이 배포가
  설정하지 않은 기능).
- **Retry-After**: `429` 는 항상 이 헤더를 초 단위로 실어 보낸다. 그 거절은 언제 더 이상
  참이 아니게 되는지를 안다 — 일일 비용 차단은 00:00 UTC 까지 지속된다 — 그래서 호출자가
  짐작해서 같은 벽에 다시 부딪히게 두지 않고 알려 준다.
- **List responses**: 리소스 컬렉션(`projects`, `skills`, `mcps`, `agents`)은 벌거벗은
  배열을 돌려준다. `chats`, `models`, `usages/summary`, `triggers`, `connections` 는 각자의
  것을 객체로 감싼다 (`{ chats }`, `{ models }`, `{ items }`, `{ triggers }`, `{ connections }`).
- **Names** 는 slug (`^[a-z0-9-]+$`) 이고 `parseName` 이 검증한다. 실패 시
  `ValidationError` 를 던져 `400` 이 된다.
- **SSE framing**: 각 이벤트는 `data: {json}\n\n` 이다. `sseResponse` 가 서빙하는 모든
  스트림은 — OpenAI 형식의 것들과 chat 스트림 모두 — `data: [DONE]\n\n` 으로 끝난다 (A2A
  엔드포인트의 JSON-RPC 스트림과 AG-UI 이벤트 스트림은 이것을 생략한다 — 각자의 프로토콜이
  종단 이벤트와 스트림 종료로 끝을 말한다). 스트림 도중 실패하면 마지막에
  `data: {"error":"…"}` 프레임이 나간다.
  `chat/completions` 스트림은 항상 정확히 하나의 `finish_reason` chunk 를 싣는다: 모델이
  스스로 끝냈으면 `stop`, 런이 한계에서 끝났으면 — 턴 예산이거나, 프로바이더가 출력 상한에서
  응답을 끊은 것 — `length` 다. 엔진이 알리는 종료 사유에서 읽어 오므로, 취소나 스트림 도중
  에러가 length 정지로 둔갑하는 일은 없다.
  비스트리밍 응답도 같은 두 값을 보고한다.

## 라우트 색인

`session` = Better Auth 세션 쿠키. `member` = 세션 + `member` tier 이상
(`withMemberAuth`. `guest` 는 403 을 받는다). `admin` = 세션 + 유효 admin 목록에 속함.
`owner` = 그 project 의 소유자 또는 설정된 admin.

### Projects

| 라우트 | 메서드 | 권한 |
|---|---|---|
| `/api/projects` | `GET` `POST` | session / session + project 를 만들 수 있는 tier |
| `/api/projects/{name}` | `GET` `PUT` `DELETE` | session / owner |
| `/api/projects/{name}/versions` | `GET` `POST` | session / owner |
| `/api/projects/{name}/versions/{version}` | `GET` `PUT` `DELETE` | session / owner |
| `/api/projects/{name}/publish` | `POST` | owner |
| `/api/projects/{name}/preview` | `POST` | member |
| `/api/projects/{name}/versions/{version}/predict` | `POST` | session 또는 project 토큰 |
| `/api/projects/{name}/versions/{version}/chat/completions` | `POST` | session 또는 project 토큰 |
| `/api/projects/{name}/versions/{version}/agent` | `POST` | session 또는 project 토큰 |
| `/api/projects/{name}/token` | `GET` `POST` `DELETE` | owner |
| `/api/projects/{name}/token/reveal` | `POST` | owner |
| `/api/projects/{name}/artifacts` | `GET` | owner |
| `/api/projects/{name}/traces` | `GET` | owner |
| `/api/projects/{name}/traces/{traceId}` | `GET` | owner |
| `/api/projects/{name}/usage/actors` | `GET` | owner |
| `/api/projects/{name}/triggers` | `GET` `POST` | owner |
| `/api/projects/{name}/triggers/{trigger}` | `PUT` `DELETE` | owner |
| `/api/projects/{name}/triggers/{trigger}/reveal` | `POST` | owner |
| `/api/projects/{name}/triggers/{trigger}/runs` | `GET` | owner |
| `/api/projects/{name}/slack` | `GET` `PUT` `DELETE` | owner |
| `/api/projects/{name}/slack/test` | `POST` | owner |
| `/api/projects/{name}/slack/channels` | `GET` | owner |
| `/api/projects/{name}/telegram` | `GET` `PUT` `DELETE` | owner |
| `/api/projects/{name}/telegram/chats` | `GET` | owner |
| `/api/projects/{name}/telegram/test` | `POST` | owner |
| `/api/projects/{name}/telegram/webhook` | `POST` | owner |
| `/api/projects/{name}/teams` | `GET` `PUT` `DELETE` | owner |
| `/api/projects/{name}/teams/test` | `POST` | owner |
| `/api/projects/{name}/a2a` | `GET` | session |
| `/api/projects/{name}/mcp-connections` | `GET` | owner |
| `/api/projects/{name}/mcp-connections/{server}` | `PUT` `DELETE` | owner |
| `/api/projects/{name}/mcp-connections/{server}/authorize` | `POST` | owner |
| `/api/projects/{name}/mcp-connections/{server}/tools` | `POST` | owner |

### 레지스트리

| 라우트 | 메서드 | 권한 |
|---|---|---|
| `/api/skills`, `/api/mcps`, `/api/agents` | `GET` `POST` | member / admin |
| `/api/skills/{name}`, `/api/mcps/{name}`, `/api/agents/{name}` | `GET` `PUT` `DELETE` | member / admin |
| `/api/plugins` | `GET` | member |
| `/api/plugins/{name}` | `GET` | member |
| `/api/plugins/sync` | `GET` `POST` | member / admin |
| `/api/mcps/{name}/tools` | `POST` | member |
| `/api/mcps/{name}/auth` | `POST` `DELETE` | admin |
| `/api/mcps/managed` | `POST` | admin |
| `/api/mcps/managed/{name}` | `GET` `PUT` `DELETE` | admin |
| `/api/mcps/managed/{name}/restart` | `POST` | admin |
| `/api/mcps/oauth/callback` | `GET` | session |
| `/api/mcps/oauth/client-metadata/{project}` | `GET` | **공개** |
| `/api/agents/{name}/message` | `POST` | member |

### Chat·사용량·플랫폼

| 라우트 | 메서드 | 권한 |
|---|---|---|
| `/api/chats` | `GET` `POST` | session |
| `/api/chats/{chatId}` | `GET` `DELETE` | 그 chat 의 소유자 |
| `/api/chats/{chatId}/messages` | `POST` | 그 chat 의 소유자 |
| `/api/chats/{chatId}/runs/{runId}` | `GET` `DELETE` | 그 chat 의 소유자 |
| `/api/chats/{chatId}/runs/{runId}/stream` | `GET` | 그 chat 의 소유자 |
| `/api/artifacts` | `GET` | session |
| `/api/artifacts/{artifactId}` | `DELETE` | 생성자, project 소유자, 또는 admin |
| `/api/artifacts/{artifactId}/view` | `GET` | 생성자, project 소유자, 또는 admin |
| `/api/usages/summary` | `GET` | session |
| `/api/models` | `GET` | session |
| `/api/models/catalog` | `GET` | member |
| `/api/models/test` | `POST` | admin |
| `/api/models/refresh` | `POST` | admin |
| `/api/models/selfhosted` | `GET` | admin |
| `/api/me` | `GET` | session |
| `/api/me/profile` | `GET` | session |
| `/api/me/usage` | `GET` | session |
| `/api/members` | `GET` | admin |
| `/api/members/{id}/tier` | `PUT` | admin |
| `/api/settings` | `GET` `PUT` | admin |
| `/api/settings/a2a-key` | `POST` | admin |
| `/api/settings/a2a-key/reveal` | `POST` | admin |
| `/api/settings/a2a-keys` | `GET` `POST` | admin |
| `/api/settings/a2a-keys/{name}` | `DELETE` | admin |
| `/api/settings/a2a-keys/{name}/reveal` | `POST` | admin |
| `/api/audit` | `GET` | admin |

### 비인증 / 기계 표면

| 라우트 | 메서드 | 게이트 |
|---|---|---|
| `/api/auth/{...all}` | `GET` `POST` | Better Auth 로그인 플로우 자신 |
| `/api/a2a` | `GET` | session |
| `/api/a2a/{project}/.well-known/agent-card.json` | `GET` | 공개 |
| `/api/a2a/{project}` | `POST` | `X-A2A-Key` |
| `/api/agui/{project}` | `POST` | project 토큰 또는 session |
| `/api/slack/events/{project}` | `POST` | Slack signing secret |
| `/api/telegram/webhook/{project}` | `POST` | `X-Telegram-Bot-Api-Secret-Token` |
| `/api/teams/messages/{project}` | `POST` | Bot Framework bearer 토큰 |
| `/api/webhook/{project}` | `POST` | `X-Trigger-Secret` |
| `/api/triggers/scan` | `POST` | `X-Scan-Token` |
| `/api/catalog/reindex` | `POST` | `X-Scan-Token` |
| `/api/plugins/sync/scan` | `POST` | `X-Scan-Token` |
| `/api/health` | `GET` | 열림 |
| `/api/ready` | `GET` | 열림 |
| `/api/metrics` | `GET` | 열림 |

## 리소스 CRUD — projects, skills, mcps, agents

넷 다 같은 형태를 따른다. 예 (skills):

```
GET    /api/skills            → 200 [ { name, description, source?, files, updatedAt }, … ]
GET    /api/skills/{name}     → 200 {…}                 | 404
POST   /api/skills            → 201 {…}                 | 409 (name exists) | 400
PUT    /api/skills/{name}     → 200 {…}                 | 404 | 400
DELETE /api/skills/{name}     → 204                     | 404
```

- 이름은 slug (`^[a-z0-9-]+$`) 다.
- `mcps`/`agents` 는 `headers` 를 AES 로 암호화해 저장하고 마스킹해서 돌려준다 (길이 보존.
  9–20자는 양끝 2자씩, 21자 이상은 4자씩 드러낸다). 업데이트 때 마스킹된 값이나 빈 값은
  저장된 secret 을 보존한다. 이들의 `url` 은 SSRF 가드를 받는다 —
  private/loopback/link-local/metadata 대상(또는 http(s) 가 아닌 scheme)은 `400` 으로 거절된다.
- `mcps` 는 선택적인 `content` (markdown 운영자 노트) 도 받는다. `description` 은 agent 런의
  서버 표에서 모델이 보는 한 줄 요약이고, `content` 는 콘솔 전용이라 모델에 절대 닿지 않는다.
- `agents` 는 `protocol` (`openai` | `a2a`, 기본값 `openai`) 을 갖는데, 이것이
  `POST /api/agents/{name}/message` 와 아웃바운드 transfer 가 원격을 어떻게 호출할지를 정한다.
- **managed** MCP 항목은 그것을 소유하지 않은 공유 레지스트리 라우트에서 거절된다:
  `DELETE /api/mcps/{name}` 은 `400` 이고 (`/api/mcps/managed/{name}` 을 통해 지워야 컨테이너가
  행과 함께 멈춘다), `url` 을 옮기는 `PUT` 도 `400` 이다 — 그 주소는 프로비저너가 준다.
- `GET /api/skills` 는 요약을 돌려준다 — `{ name, description, source?, files: count,
  updatedAt }` — 목록 페이지가 렌더링하는 것은 문서가 아니라 카드이기 때문이다. 전체 엔티티
  (markdown `content`, 첨부 `files[]` 자체) 는
  `GET /api/skills/{name}` 에서 온다. `source?` 는 repo 에서 sync 된 항목의 출처다. 예:
  `github:opspresso/agent-plugins#devops` — 그것을 선언한 repo 와 plugin.
- **`source` 를 가진 항목은 repo 소유이고, 콘솔은 그것을 두고 저장소와 경쟁하기를 거부한다
  (`403`)**: skill 은 `PUT`/`DELETE` 전부, MCP 항목은 `url`·`description`·`content` 와 그
  `DELETE` 다 — headers 만 바꾸는 `PUT` 은 여전히 통과하는데, 인증 정보는 콘솔 소유이고 git 에
  들어가지 않기 때문이다 (OAuth 도 마찬가지). sync 된 managed 항목은 워크로드 필드
  (`image`, 포트, env) 를 계속 수정할 수 있다. repo 소유 항목의 삭제는 plugins sync 의 orphan
  선택을 거쳐 일어난다.
- `projects` 변경은 소유자 게이트를 받는다 (403). `POST /api/projects` 본문:

```json
{ "name": "my-bot", "displayName": "My Bot", "description": "",
  "projectType": "llm | agent | image", "departmentCode": "OPT-optional" }
```

  생성은 project 의 초기 version `"1"` 도 함께 쓴다 — 빈 프롬프트, 그 project 타입에 맞는
  배포의 첫 제공 모델 — 그래서 chat 과 playground 가 첫 순간부터 동작한다. 초기 version 은
  **publish 되지 않는다**: publish 는 의도적인 행위로 남는다 (project 가 publish 되지 않은
  동안 콘솔이 저장 후에 그것을 제안한다). 맞는 제공 모델이 하나도 없으면 project 는 version
  없이 생성되며, 이는 이전과 정확히 같다.

#### 공개 범위와 복제

`PUT /api/projects/{name}` 은 공개 범위도 싣는다: `visibility: "public" | "private"` 와, private
일 때 의미를 갖는 초대 목록 `memberEmails: string[]` (통째로 대체, 저장 시 trim·소문자·중복
제거·소유자 제외로 정규화). 필드가 없는 기존 행은 public 이다. private project 는 세션
기반의 모든 읽기·실행 표면에서 소유자·초대 멤버·admin 외에 403 으로 거절되고, 목록
(`GET /api/projects`) 에서는 보이지 않는다. 누가 게이트를 받고 누가 받지 않는지(API token,
bot, Slack 의 이메일 판정)는 [SECURITY.md](SECURITY.md#인가-모델) 가 정본이다.

```
POST /api/projects/{name}/clone    { "name": "my-copy", "displayName": "My Copy" }
  → 201 { "project": { … }, "warning": "…"? }
```

접근 가능한 project 를 호출자 소유의 새 project 로 복제한다. tier 게이트는 생성과 같다.
복사되는 것은 설명·타입·부서 코드·**공개 범위**(private 원본의 복제본은 private 으로
시작한다 — 초대받은 사람이 클릭 한 번으로 private 프롬프트를 전사에 재공개하는 일을 막는다)
와 version 하나 — 원본이 실제로 실행하는 것, 즉 `resolveRunnableVersion` 이 답하는 published
또는 최신 draft — 다. MCP 바인딩의 header 오버라이드(원 소유자의 시크릿), bot 연동, 비용
한도, API token, 초대 목록, published 포인터는 복사되지 않는다. 복제본의 version 은 publish
되지 않은 `"1"` 로 시작한다. version 을 복사할 수 없었던 경우(복제자가 접근할 수 없는
subagent 참조, 카탈로그를 떠난 모델) project 는 만들어지고 `warning` 이 무엇을 잃었는지
말한다.

#### 비용 한도

`PUT /api/projects/{name}` 은 그 project 의 지출 가드도 함께 싣는다:

```json
{ "costLimits": { "alertThresholdUsd": 20, "blockThresholdUsd": 50,
                  "monthlyAlertThresholdUsd": 300, "monthlyBlockThresholdUsd": 500,
                  "alertDestinations": [
                    { "kind": "slack", "channelId": "C0123456789" },
                    { "kind": "telegram", "chatId": -1001234567890, "threadId": 7 },
                    { "kind": "teams", "conversationId": "19:conversation-id" }
                  ] } }
```

통째로 보낸다 — 이 객체가 저장된 것을 대체하고, `null` 은 가드를 지우며, 필드를 생략하면
그대로 둔다. 부분 병합이면 "block 임계값은 없애고 alert 는 유지"를 표현할 수 없게 된다. 모든
임계값은 선택이고 서로 독립이다. 각 창(window) 안에서 alert 는 block 을 넘을 수 없다 (넘으면
alert 는 혼자서는 절대 발화하지 못하는데, block 이 거기 도달할 지출을 멈추기 때문이다).

지출은 project 의 UTC-일 사용량 행에 있는 모든 모델의 `costUsd` 합이다 — 일간 창은 한 행,
월간은 그 달의 행들을 합산한다. block 임계값에 도달하면 모든 실행 진입점이
`429 { "error": "Project \"…\" has reached its daily cost limit …" }` (또는 `monthly`) 로
답하고, `Retry-After` 에는 창이 넘어갈 때까지의 초가 담긴다 — 일간은 00:00 UTC, 월간은 다음 달
1일이다. 임계값을 넘으면 `alertDestinations` 에 선택한 Slack·Telegram·Teams 연동으로 창당
한 번 알린다. 플랫폼마다 목적지는 하나만 선택할 수 있고, 각 전송은 독립적으로 시도한다.
목적지나 연동이 없어도 임계값은 여전히 차단한다. 가드가 무엇을 한계 지우고 무엇은 그러지
못하는지는 [OPERATIONS.md](OPERATIONS.md#비용-가드--fail-open) 를 보라.

### Version 과 publish

```
GET|POST /api/projects/{name}/versions
GET|PUT|DELETE /api/projects/{name}/versions/{version} ({version} = a name or "published")
POST     /api/projects/{name}/publish   { "versionName": "3" }   → sets the published pointer
```

Version 본문: `systemPrompt`, `userPromptTemplate`, `model` (필수, `provider/model`),
`fallbackModel?`, `parameters { temperature?, maxTokens?, reasoningEffort?, piiFiltering,
structuredOutput?, jsonSchema?, imageGeneration?, imageModel?, callerContext?, urlFetch?,
slackWorkspace?, dynamicCapabilities?, memoryRecall?, reasoningTrace? }`,
`mcpList[{ name, headers?, tools? }]`, `skillList[]`,
`subagentList[{ name, type: "local"|"remote" }]`, `maxTurn?`. 이미지 능력이 없는 레지스트리
모델을 `imageModel` 로 주면 400 으로 거절되고, 그 version 이 필요로 하는 능력이 없는 카탈로그
`model` 도 마찬가지다 — `agent` project 에는 `tools`, 그 파라미터에는 `structuredOutput` 과
`reasoningTrace`(모델의 `reasoning`)가 필요하다 (카탈로그에 없는 id 는 거절이 아니라 경고
대상이다).
`mcpList`/`skillList`/`subagentList` 항목은 등록된 MCP 서버·skill·agent·project 로 해석돼야
한다 — 대롱거리는 참조는 400 으로 거절된다 — 그리고 애초에 `agent` project 만 이들을 가질 수
있다. 업데이트에서는 *새로 추가된* 항목만 검사하므로, 이미 참조하던 레지스트리 항목이
삭제된 뒤에도 version 은 계속 수정 가능하다. 한 목록에서 같은 서버·skill·agent 를 **두 번**
지정하는 것은 저장된 목록을 그대로 다시 제출하는 업데이트를 포함해 모든 쓰기에서 400 으로
거절된다: 중복 바인딩은 그 서버의 세션을 두 번 열고, 런이 이름으로 키를 잡는 모든 곳에서 둘째
행이 첫째를 조용히 덮어쓴다.

`callerContext` 는 시스템 프롬프트에서 묻는 사람의 이름을 밝힌다. **그런 사람이 있는
표면에서만** 그렇다: 콘솔 chat 과 Playground, 세션으로 인증된 `predict`·`agent`·
`chat/completions` 런, 그리고 Slack (여기서는 호출자의 프로필에서 시간대까지 추가로
제공한다). project **API 토큰**은 호출자를 싣지 않고 — 소유자를 대신해 동작하지만 반대편에는
아무도 없다 — trigger 발화나 인바운드 A2A 도 마찬가지다. image project 는 영향을 받지 않는다:
그 프롬프트는 렌더링된 템플릿이고, 그 블록이 들어갈 시스템 프롬프트가 없다.
`POST /api/projects/{name}/preview` 는 그 페이지에서 시작한 런이 그 블록을 실을 때에만 정확히
그것을 보여 준다. 호출자는 **transfer 사슬을 타고 간다** — subagent 는 자기 부모와 같은 사람에게
답하고 있다 — 그리고 각 version 자신의 opt-in 이 자기 프롬프트를 결정한다: 호출자를 밝히지 않는
부모가 자기가 transfer 하는 project 에 대해 무언가를 말하는 것은 아니다.

`POST /api/projects/{name}/preview` 는 선택적인 `message` 를 받는다 — 무엇을 기준으로
미리 볼지, 최대 8,000자다. 이것을 읽는 것은 discovery 뿐이지만 (agent 런의 사용자 턴은 대화에서
온다), 런이 *어떤* 능력을 찾아내는지는 무엇을 요청받았는지에 달려 있다. 그래서 이것이 없으면
미리보기는 특정한 런의 모습이 아니라 모든 런이 출발하는 바닥을 보여 준다.

`dynamicCapabilities` 는 런이 이 version 이 한 번도 바인딩하지 않은 skill·MCP 서버·agent 에
닿게 해 준다. version 의 시스템 프롬프트와 지금 답하고 있는 요청으로 전역 카탈로그를 검색해
찾는다. 이것은 **덧붙이는 것이다**: 위의 바인딩이 먼저 온전히 해석되고, 검색이 찾은 어떤 것도
그것을 밀어내거나 잘라낼 수 없다. 자기 OAuth 연결이 필요한 MCP 서버는 그 project 가 이미
인가해 둔 경우에만 추가되고, 그렇지 않으면 런이 그렇다고 말한다. *찾아낸* 것은 warning 이
아니다 — 런은 그것을 로그에 남기고, `POST /api/projects/{name}/preview` 는 `warnings` 와 분리해
`discovered` 로 돌려준다. `VECTOR_BUCKET` 이 없으면 플래그는 저장되고 런이 그 사실도 말한다.
검색이 아무것도 못 찾은 것처럼 굴지 않는다. [design/capabilities.md](design/capabilities.md#케이퍼빌리티-카탈로그)
를 보라.

`memoryRecall` 은 런이 첫 토큰 전에 자기 메모리에 묻게 한다: `recall` 도구를 제공하는 모든
바인딩된 MCP 서버(mcp-memory)를 가장 최근 사용자 턴으로 호출하고, 돌아온 것을 시스템 프롬프트에
**What you remember** 블록으로 넣는다 — 지시가 아니라 배경으로 틀 지어서 — 그래서 모델은 물어볼
생각을 해내야 하는 대신 project 가 이미 아는 것에서 출발한다. 도구는 이전처럼 계속 제공된다.
이것은 읽기를 더하는 것이다. 런당 한 번 호출하며 한계가 있다 (가장 최근 턴을 최대 2,000자까지
보내고, 최대 4,000자를 보관하며, 첫 토큰은 최대 10초까지 기다린다). 실패한 서버는 런의
`warning` 이 되고 런은 그것 없이 계속 간다. 이것을 켰지만 `recall` 을 제공하는 바인딩된 서버가
없는 version 은 메모리 없이 시작했다고 경고한다. `POST /api/projects/{name}/preview` 는 그
블록을 보여 줄 수 없고 — 무엇이 회상되는지는 요청에 달려 있다 — 그 사실을 warning 으로 말한다.
`dynamicCapabilities` 와 마찬가지로 요청 텍스트는 엔진의 PII 필터가 만들어지기 전에 서버에
닿는다. [SECURITY.md](SECURITY.md#pii-필터링-그리고-그것이-멈추는-곳) 를 보라.

#### MCP 바인딩과 version 별 헤더 오버라이드

각 `mcpList` 항목은 그 version 을 레지스트리의 MCP 서버에 바인딩한다. URL 은 언제나
레지스트리의 것이고 헤더만 재정의할 수 있다. 그래서 같은 서버를 두 번 등록하지 않고도 서로 다른
project 에서 서로 다른 인증 정보로 호출할 수 있다. `tools` 는 그 서버의 도구 중 런이 제공할
것을 좁힌다 (없거나 비어 있으면 = 전부).

```json
"mcpList": [
  { "name": "shared-mcp",
    "tools": ["search", "fetch"],
    "headers": { "Authorization": "Bearer project-token", "X-Tenant": "acme", "X-Shared": null } }
]
```

- 문자열 값은 레지스트리 기본값을 대체하거나 새 헤더를 더한다. `null` 은 이 version 에 한해
  레지스트리 기본값을 제거한다. HTTP 헤더 이름이 그렇듯 매칭은 대소문자를 가리지 않는다.
- `X-Tenant-Id` 와 `X-Conversation-Id` 는 **예약돼 있다**. 둘 중 어느 것이든 모든 표기가
  병합 후에 버려진다. 첫째 자리에는 호출하는 project 의 이름이, 둘째 자리에는 — 런이 대화를
  가질 때 — 그 런의 대화 키가 찍힌다. 그래서 어떤 바인딩도 다른 project 의 tenant 나 다른
  대화를 지칭할 수 없다.
  [SECURITY.md](SECURITY.md#mcp-서버가-호출자에-대해-듣는-것) 를 보라.
- `headers` 를 생략하면 (또는 `{}` 를 보내면) 레지스트리 헤더를 그대로 쓴다.
- 벌거벗은 문자열 항목 — `"mcpList": ["shared-mcp"]`, 오버라이드가 생기기 전의 형태 — 도
  여전히 받아들여지고 `{ "name": "shared-mcp" }` 로 정규화된다.
- 오버라이드 값은 저장 시 AES 로 암호화되고 마스킹돼 돌아온다 (레지스트리 헤더와 같은 규칙).
  업데이트 때 마스킹된 값이나 빈 값은 저장된 secret 을 보존하고, 저장된 짝이 없는 헤더 아래의
  마스킹된 값은 버려진다. `null` 표식은 그대로 돌아온다 — 제거는 secret 이 아니다.
- 오버라이드 편집은 다른 모든 version 쓰기와 마찬가지로 소유자와 admin 으로 제한된다.

한 런은 통틀어 최대 120개의 MCP 도구를 선언하고, 빼놓아야 했던 것을 `warning` chunk 로
보고한다.

### 프롬프트 미리보기

```
POST /api/projects/{name}/preview
  { …an unsaved version body…, "variables": { "topic": "otters" }? }
→ 200 { messages: [ { role, content } ], … }
```

에디터 안의 초안이 **보냈을** 것을 조립한다 — 시스템 프롬프트, skill 표, 연결된 MCP 서버 표,
렌더링된 템플릿 — 실행하지는 않고.

소유자 게이트가 아니라 member 게이트다 (`withMemberAuth`): 조립된 텍스트는 해석된 skill 과
MCP 서버의 이름을 담는다 — `guest` 가 거절당하는 바로 그 레지스트리다 — 그래서 세션만이 아니라
그 단 뒤에 놓인다. 초안의 MCP 바인딩은 등록된 서버에 선택한 헤더를 붙일 수 있지만, 그것은 이
게이트가 따로 챙길 수 있는 권한이 아니다 — 어떤 member 든 자기 project 에서 같은 레지스트리
서버를 같은 헤더로 바인딩한다. 마스킹된 헤더는 같은 서버 이름에 대한 이 project 의 저장된
바인딩에 대해서만 해석되므로, 소유자가 아닌 사람의 미리보기는 그가 이미 시작할 수 있는 런이
보내지 않을 것을 아무것도 보내지 않는다. 그리고 조립된 텍스트는 `GET /versions` 가 세션만으로도
이미 답하는 것으로 구성된다. URL 은 언제나 레지스트리에서 오므로 SSRF 표면은 런의 것이다.

## 앱 설정

```
GET /api/settings → 200 { fields: { <key>: { value, source, secret } },
                          llmProviders: { source, items: [ { name, baseUrl, apiKey, keepModelPrefix, auth } ] },
                          updatedAt? }
PUT /api/settings → 200 {…same shape…} | 400
```

- 두 동사 모두 admin 전용이다. 키: `adminEmails`, `allowedEmailDomains`, `llmBaseUrl`,
  `llmApiKey`, `pluginsRepo`, `pluginsRepoBranch`, `githubToken`, `a2aApiKey`,
  `publicBaseUrl`, `artifactAccessMode` (`authenticated` | `public` | `""`),
  `unknownModelPolicy` (`allow` | `refuse` | `""`) — 이 둘은 enum 으로 검증된다.
  `pluginsRepo` 는 자기만의 형태를 가진 나머지 하나의 키다 — `owner/repo`, 또는 비우면
  지운다. 나머지는 길이가 제한된 문자열이다.

```
POST /api/settings/a2a-key        → 200 { key, view }   (raw key)
POST /api/settings/a2a-key/reveal → 200 { key }         (raw key)
```

- admin 전용. 앱 전역 A2A 키(`asa_` + 랜덤 32바이트)를 새로 발급해 설정 오버라이드로 저장하고,
  갱신된 (마스킹된) 설정 뷰와 함께 돌려준다. 재발급은 이전 키를 즉시 무효화한다.
  `PUT /api/settings` 로 손수 붙여 넣은 키도 여전히 동작한다 — 이 엔드포인트는 키를 지어내는
  수고를 덜어 줄 뿐이다.
- `/reveal` 은 *유효한* 키를 평문으로 돌려준다 — 저장된 오버라이드를 복호화한 것, 또는
  오버라이드가 없으면 env 값 — 아무것도 설정돼 있지 않으면 `404` 다. 읽기인데도 POST 인 이유는
  project 토큰과 같다: 본문이 살아 있는 인증 정보다. 모든 reveal 은 감사 행과, 호출자를 밝히는
  서버 측 로그 한 줄을 남긴다.
- PUT 의 `llmProviders` 는 전체 교체 목록이다 (프로바이더별 LLM 채널). 빈 배열은 오버라이드를
  제거한다 (`LLM_PROVIDER_*` env 로 폴백). 마스킹된 `apiKey` 는 그 프로바이더 이름에 대해
  지금 유효한 키를 유지한다. 프로바이더 `name` 은
  `openai | anthropic | google | xai | bedrock | openrouter | selfhosted` (`SUPPORTED_PROVIDERS`) 중
  하나여야 하고, `auth` 는 `bearer` (기본) 또는 `sigv4` 이며, 목록은 최대 50개까지고, 같은
  이름이 두 번 나오면 `400` 이다.
- PUT 의 `enabledModels` 도 전체 교체 목록이다 — `/api/models` 가 제공해도 되는 모델 id 들로,
  정렬·중복 제거해 저장된다. 빈 배열은 오버라이드를 제거한다 (보이는 모델 전부가 제공된다 —
  env 폴백은 없다). 레지스트리에 없는 id 는 `400` 이다. 이것은 GET 뷰에 자리가 없다.
  다시 읽는 곳은 `/api/models/catalog` 다.
- PUT 의 `selfHostedModels` 도 전체 교체 목록이다 — 이 배포가 직접 서빙하는 모델의 선언
  (`{ family, displayName, maker?, contextWindow, maxTokens, capabilities }`, 최대 50개).
  저장 시 레지스트리 로더의 검증을 그대로 지나 (통과 못 하면 `400` 에 이유가 담긴다) 이
  프로세스의 오버레이에 즉시 설치되고, 다른 인스턴스는 카탈로그 refresh 틱에 따라온다. 빈
  배열은 전부 제거. env 폴백은 없다 — 선언은 설정이 아니라 데이터다. 다시 읽는 곳은
  `GET /api/models/selfhosted` 의 `declarations` 이고, 관리 UI 는 `/models` 콘솔의
  Self-hosted 섹션이다.
- `source` 는 `override` (DB) | `env` | `default` | `unset` 이다. secret 값은 언제나 마스킹된다
  (길이 보존. 9–20자는 양끝 2자씩, 21자 이상은 4자씩 드러낸다). PUT 의 마스킹된 값은 저장된
  secret 을 유지하고, 빈 문자열은 오버라이드를 제거한다 (env 폴백). 호출자를 제외하는 목록으로
  `adminEmails` 를 설정하는 것은 `400` 으로 거절된다. 비어 있지는 않은데 파싱하면 항목이 하나도
  없는 `adminEmails`·`allowedEmailDomains` 값(`","`)도 마찬가지다: 오버라이드 제거는 빈 문자열이
  하는 일이고, 저것을 같은 것으로 읽으면 배포가 게이트 없이 남는다.

## 감사 기록

```
GET /api/audit?from=2026-08-01&to=2026-08-03
  → 200 { events: [ { eventId, actorEmail, action, target, detail?, createdAt } ] }
```

- admin 전용이다: 행들이 사람의 이름을 담는다. `from` 의 기본값은 오늘, `to` 의 기본값은
  `from` 이며 둘 다 UTC 일(`YYYY-MM-DD`)이다. 범위는 최대 **31일**이다 — 행은 하루에 파티션
  하나로 저장되고 같은 방식으로 읽히므로, 폭이 곧 쿼리 수다. 잘못된 형식의 날짜, 달력에 없는
  날짜(`2026-02-31`, `2026-13-01`), 뒤집힌 범위, 또는 그보다 넓은 범위는 `400` 이다. 폭은
  범위를 열거해서가 아니라 날짜에서 바로 거절하므로, 터무니없는 폭도 다른 거절과 같은 비용이다.
- 최신순이다. `action` 은 `secret.reveal` | `secret.rotate` | `secret.revoke` |
  `project.admin-override` | `settings.update` | `project.delete` | `registry.delete` |
  `registry.adopt` (plugins sync 가 다른 출처가 만든 항목을 넘겨받는 것) |
  `artifact.delete` (다른 사람의 artifact) | `member.set-tier` 중 하나다. `target` 은
  `kind:name` 이다.
- **구조상 읽기 전용이다.** 여기에도 다른 어디에도 쓰기 동사는 없다 — 행은 행위 자체가 덧붙이고
  TTL(`AUDIT_RETENTION_DAYS`)로 만료된다. `detail` 은 인증 정보를 절대 싣지 않는다: 설정 쓰기는
  어떤 키가 움직였는지를 기록하고 그 값은 절대 기록하지 않는다.

## 뷰어

```
GET /api/me → 200 { email, isAdmin, isConfiguredAdmin, tier }
```

`tier` 는 그 멤버의 tier 이고, 그래서 콘솔은 tier 범위의 행동(project 생성)을 라우트가 강제하는
것과 같은 `tierMay*` 술어로 게이트한다. 두 플래그를 다 보내는 이유는 서로 다른 질문에 답하고
콘솔이 둘 다 필요로 하기 때문이다:
`isAdmin` (공유 레지스트리와 앱 설정을 변경해도 되는가 — 빈 `ADMIN_EMAILS` 는 *제한 없음*을
뜻한다) 과 `isConfiguredAdmin` (남이 소유한 project 를 써도 되는가 — 빈 목록은 *아무도 안 됨*을
뜻한다). 둘 다 브라우저에서 유도할 수 없고, 하나를 다른 하나에서 추론한 것이 한때 로그인한 모든
사용자에게 저장 시 403 이 나는 편집 폼을 내주었던 원인이다.
[SECURITY.md](SECURITY.md#isadminemail-vs-isconfiguredadmin) 를 보라.

```
GET /api/me/profile
  → 200 { member: { id, name, email, image, tier, joinedAt, lastLoginAt },
          monthToDateUsd }

GET /api/me/usage?from=2026-08-01&to=2026-08-13
  → 200 { items: [ { email, date, calls, inputTokens, outputTokens, cachedTokens, costUsd } ] }
```

로그인한 사용자 자신의 행과 지출이다 — 언제나 세션 사용자이므로 둘 다 이메일을 받지 않고 둘 다
추가 게이트가 필요 없다. `monthToDateUsd` 는 tier 상한이 한계 짓는 값(UTC 월 1일 이후의 지출)이며,
서버 측에서 계산된다. 그래서 페이지의 선택기가 어떤 범위로 맞춰져 있든 가드가 동의하지 않을 총액을
보고할 수 없다.

`/api/me/usage` 는 프로필의 차트와 표 뒤에 있는 범위 읽기다: UTC 일마다 *project 별* 한 행,
지표는 모델별 맵, 그리고 사용량 요약이 쓰는 것과 같은 범위 검증(`from`/`to` 필수, 최대 184일)이다.
행에 project 가 있으므로 프로필은 한 사람 자신의 지출을 project·모델·프로바이더별로 묶을 수 있다 —
개요와 project 의 사용량 탭이 갖는 것과 같은 컨트롤이다. 여기 세는 지출은 그 멤버 자신의 콘솔
런(`user:` actor)이다 — project 토큰 런은 이 예산이 아니라 자기 project 에 지출한다. tier 가
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

Chat 은 소유자에게만 비공개이고, agent project 에 대해서만 실행된다.

```
GET    /api/chats?limit=                     → { chats, hasMore }
POST   /api/chats                            { projectName, firstMessage, images?, documents? } → SSE
GET    /api/chats/{chatId}?sinceSeq=         → { chat, messages, activeRun? }
DELETE /api/chats/{chatId}                   → 204
POST   /api/chats/{chatId}/messages          { content, images?, documents? } → SSE
GET    /api/chats/{chatId}/runs/{runId}/stream → SSE
GET    /api/chats/{chatId}/runs/{runId}      → { active }
DELETE /api/chats/{chatId}/runs/{runId}      → { cancelled }
```

두 목록 읽기 모두 범위를 좁힐 수 있고, 사이드바와 스레드가 실제로 그렇게 읽는다. `limit` 은
최신 순으로 몇 개인지이며 기본값과 상한은 `CHAT_PAGE` / `MAX_CHAT_PAGE`
(`src/domain/chat/repository.ts`) 가 정한다 — `hasMore` 가 참이면 더 큰 `limit` 으로 다시
묻고, 상한에 닿으면 거짓이 되어 멈춘다(커서가 아닌 이유는 [design/chat.md](design/chat.md#사이드바와-스레드가-읽는-범위)).
`sinceSeq` 는 그 시퀀스 *다음* 부터의 메시지만 돌려준다 — 런이 끝났을 때 스레드가 묻는 것이고,
없으면 전체 기록을 읽고 그 안의 이미지·파일 주소를 매번 다시 서명한다. `sinceSeq=0` 은 "없음"이
아니라 유효한 경계다(첫 메시지의 시퀀스가 0 이다).

두 런 스트림 모두 head 프레임으로 시작하고 — `{ chat?, runId, userSeq }`, 새로 만들 때는 새
`chatId` 를 싣는다 — `{ "ended": true }` 로 닫힌다. 끝난 런과 끊긴 연결을 구별해 주는 것은 그
마지막 프레임뿐이다. 그냥 멈춘 본문은 둘이 똑같아 보인다. head 프레임은 런이 무언가를 내놓기
전에 나가므로 응답은 즉시 `200 text/event-stream` 으로 확정된다: 모델의 첫 토큰이 1분 뒤에
나오더라도 클라이언트는 언제나 `chatId`/`runId` 를 알게 되고, 런 자신이 일으킨 거절(일일 비용
가드, 동시성 가드)은 `429` 가 아니라 그 스트림의 `{error}` 프레임으로 도착한다. 그 밖에는
스트림은 표준 SSE framing 을 쓰고 사용자·어시스턴트·도구·이미지 표시 데이터를 저장한다.
publish 된 version 도 실행 가능한 초안도 없는 project 는 `400` 으로 거절된다.

**런은 자신을 시작한 연결보다 오래 산다.** 끊는 것은 읽는 사람이 떠났다는 뜻이지 멈추라는 뜻이
아니다: 어느 쪽이든 런은 끝까지 가고 저장된다. `GET /api/chats/{chatId}` 는 런이 진행 중인
동안 `activeRun: { runId }` 를 알려 주고,
`GET /api/chats/{chatId}/runs/{runId}/stream` 은 그 런이 지금까지 내놓은 전부를 재생한 뒤
실시간으로 따라간다 — 언제나 처음부터이므로 유지할 커서가 없다. 다만 읽는 사람이 붙어 있는
동안 런은 아무것도 기록하지 않으므로, 같은 런의 *두 번째* 관람자는 첫 번째가 연결을 끊을 때까지
아무 내용도 보지 못한다. 스트림은 멈춘 것처럼 보이는 대신 그렇다고 말해 준다.

`GET /api/chats/{chatId}/runs/{runId}` 는 `{ active }` 로 답한다 — 그 런이 아직 그 chat 을
쥐고 있는지다. 스트림이 `{ "ended": true }` 프레임 없이 끝난 뒤 읽는 사람이 묻는 것이 이것이다:
다시 연결할지, 아니면 대화에서 답을 가져올지. `GET /api/chats/{chatId}` 도 `activeRun` 으로 같은
질문에 답하지만 스레드 전체를 실어 보내며 그 안의 모든 이미지에 서명까지 한다. 이미 나쁘다고
알려진 연결에서 id 하나를 비교하려고 보내기엔 너무 많다.

`DELETE /api/chats/{chatId}/runs/{runId}` 는 런을 일찍 끝내는 유일한 방법이다. 요청을 기록하고
`{ cancelled: true }` 로 답한다. `{ cancelled: false }` 는 런이 이미 끝나 있었다는 뜻이고, 그것은
에러가 아니다. 두 런 라우트 모두 UUID 가 아닌 `runId` 는 `400` 으로 거절한다. 중단된 런은 끝난
런처럼 마무리된다 — 스트리밍된 것은 저장되고, 스트림은 `{ "ended": true }` 로 닫히며, 읽는
사람은 `error` 가 아니라 `warning` 프레임을 받는다.

`images` 는 사용자의 첨부를 인라인 바이트로 담은 것이다 — `[ { b64, mimeType } ]`, 턴당 최대
4개, 각각 5MB, `image/png|jpeg|gif|webp`. 모델에는 content part 로 닿고, (오브젝트 스토리지가
설정돼 있으면) 사용자 메시지에 **object key** 로 저장된다. 읽기는 그 응답을 위해 서명된 URL 로
답하며, 그 뒤로도 계속 동작하는 URL 은 절대 아니다. 주소를 만들 수 없는 이미지는 깨진 채로
돌아오는 대신 메시지에서 빠진다.

`documents` 는 보는 것이 아니라 읽는 파일이다 — `[ { b64, mimeType, name } ]`, 턴당 최대 4개,
각각 10MB: PDF 와 텍스트, Markdown, CSV/TSV, JSON, YAML, XML, HTML 이다. `name` 은 필수이고,
`mimeType` 이 `application/octet-stream` 일 때 — 업로드는 흔히 이렇게 도착한다 — 판단을 떠맡는다.
읽을 수 없는 타입은 `400` 으로 거절된다. 서버는 **텍스트**를 추출하고 — PDF 의 텍스트 레이어,
텍스트 파일의 내용 — 턴은 그것을 싣는다. 파일 자체는 절대 저장되지 않는다. 저장되는 것은 추출된
텍스트이며, 사용자 메시지의 `documents: [ { name, text, note? } ]` 로 들어간다. 후속 질문이
여전히 그 문서를 갖고 있게 해 주는 것이 이것이다. 문서당 최대 20,000자, 한 턴 통틀어 40,000자를
보관한다. 빠진 것은 `warning` 으로 보고되고, 아예 읽을 수 없었던 문서(텍스트 레이어가 없는 스캔,
암호로 보호된 PDF)도 마찬가지다.

한 턴에는 텍스트나 두 종류 중 하나의 첨부가 최소 하나는 있어야 한다 (전부 비면 → `400`). 턴을
싣는 모든 라우트 — chat 라우트 둘, `predict`, `agent`, `chat/completions`, A2A — 는 요청 본문을
정당한 턴이 가질 수 있는 최대치(모든 첨부가 각자의 한도에 산문이 들어갈 여유를 더한 것)로
제한하고 그것을 넘으면 `413` 으로 답한다. 본문이 메모리에 올라온 뒤가 아니라 선언된 길이로 미리
검사한다. 레지스트리와 version 편집은 skill 의 전체 파일 묶음 무게에 맞춰 훨씬 더 빡빡하게
제한된다.

chat 읽기(`GET /api/chats/{chatId}`)는 각 문서의 `name` 과 `note` 를 돌려주고 `text` 는 비운다:
추출된 텍스트는 *나중 턴*이 재생하는 것이고 서버 측에서 읽히므로, 그것을 브라우저로 보내면 둘 중
아무것도 렌더링하지 않는 화면을 위해 턴당 수만 자를 선로에 올리게 된다.

## 레지스트리·연동 오퍼레이션

이 엔드포인트들은 리소스 CRUD 외에 콘솔의 운영 행동을 뒷받침한다:

```
GET  /api/plugins
→ [ { name, version?, description?, repo, rootPath, commitSha,
      skills: ["name"], mcpServers: ["name"], syncedAt, createdAt, updatedAt } ]

GET  /api/plugins/{name}
→ 200 { …one of the above… } | 404 | 400   ({name} follows the Agent Plugins name rule,
                                            which allows periods — not the registry slug)

GET  /api/plugins/sync
→ { configured, repo, branch,
    last: { repo, report, actorEmail, finishedAt } | null }   (the persisted last report)

POST /api/plugins/sync
→ the sync report described below | 400 (malformed removal selection; each list holds at
  most 500 names) | 409 (a sync is already running) | 503 (not configured)

POST /api/plugins/sync/scan          (X-Scan-Token: SCHEDULE_SCAN_TOKEN)
→ 202 { started } | 200 { upToDate } | 401 | 503
```

`/sync/scan` 은 CronJob 의 tick 이다: 브랜치 head 를 마지막 리포트와 비교해, 머지된 것이 없으면
스냅샷 비용을 치르지 않고 `upToDate` 로 답한다 (그 리포트가 `write-failed` skip 을 싣고 있었다면
예외다 — 그것은 다시 돌려야만 복구된다). tick 은 `scheduler` 로서 sync 하고, 절대 삭제하지
않으며 (제거 선택은 콘솔에만 있다), schedule ticker 의 토큰을 공유한다 — 배포당 CronJob 인증
정보는 하나다.

```

POST /api/mcps/{name}/tools
→ { tools } | 502 (connection failure)

POST /api/agents/{name}/message   { "message": "hello" }
→ { text } | 502 (remote failure)

GET /api/projects/{name}/a2a
→ { enabled, published, cardUrl, card }
```

`card` 는 그 project 가 publish 하는 Agent Card 이고, publish 된 version 이 없는 동안에는
`null` 이다.

sync 엔드포인트는 `GET` 은 member 에게 답하고 `POST` 는 admin 권한을 요구한다. 레지스트리 테스트
오퍼레이션은 `member` tier 를 요구하고, 등록과 dispatch 때 쓰는 것과 같은 SSRF 가드를 적용한다.
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

- **created** — 저장소에는 있고 레지스트리에는 없다. `source: "github:<repo>#<plugin>"` 과 함께
  그대로 가져온다.
- **overwritten** — 양쪽에 있고 서로 다르다. **자동으로** 저장소의 것으로 맞추며, `fields` 가
  무엇이 움직였는지를 밝힌다. 그중 `source` 는 입양(adoption)이다: 다른 출처가 만든 항목(퇴역한
  skills/tools 저장소, 다른 plugin) — 또는 source 가 아예 없이 손으로 만든 항목 — 의 손이 바뀐
  것이고, 이것은 `registry.adopt` 감사 행도 남긴다. repo 가 선언하는 이름에 가한 콘솔 편집은
  다음 sync 에서 대체된다 — repo 가 진실의 출처다. 어떤 plugin 도 선언하지 않는 이름으로 손수
  등록된 항목은 절대 건드리지 않는다. **인증 정보는 주소를 따라가지 않는다**: URL 이 옮겨지면
  저장소가 지금 가리키는 곳 어디로든 옛 호스트의 secret 을 보내는 대신, 그 항목의 저장된 헤더와
  OAuth 블록을 버린다 (`credentials-reset` 으로 보고된다).
- **unchanged** — 양쪽에 있고 이미 일치한다. 아무것도 쓰지 않았으므로 `updatedAt` 도 움직이지
  않는다.
- **orphaned** — 이 저장소의 sync 가 만들었고 그 안의 어떤 plugin 도 더 이상 선언하지 않는 것.
  자기 source 가 지목하는 plugin 에 귀속되며 (완전히 사라진 plugin 을 위해서는 섹션이
  합성된다), `boundTo` 는 대롱거리게 될 `project/version` 바인딩을 나열한다. 이름이 대응하는
  `remove` 목록에 있지 않는 한 **아무것도 삭제되지 않는다** — MCP 항목은 인증 정보를 쥐고 있고,
  파일이 브랜치에서 사라졌다는 것은 그것을 파괴할 충분한 이유가 아니다. 읽을 수 없는
  `plugin.json`/`mcp.json` 은 아무것도 orphan 으로 만들지 않는다: 그 plugin 은 파일이 다시
  파싱될 때까지 마지막으로 정상이던 상태에 얼어붙는다. managed 항목의 삭제는 managed use case 를
  거치므로 컨테이너가 행과 함께 멈춘다. 삭제는 콘솔에서와 똑같이, 요청한 admin 의 이름을 담은
  `registry.delete` 감사 행을 남긴다.
- **skipped** — `[{ name, reason, detail? }]` 이고 `reason` 은 다음 중 하나다: `bad-name`,
  `invalid-url` (아웃바운드 가드의 메시지가 `detail` 에 담긴다), `managed-url` (managed MCP
  항목의 주소는 프로비저너가 주므로 문서의 주소는 무시하고 나머지 필드는 적용했다),
  `conflict` (sync 도중의 경합, 어느 방향이든), `attachment` (skill 은 sync 됐지만 그 파일 중
  하나가 안 됐다), `invalid-manifest` (쓸 수 없는 `mcp.json`, 또는 그 안의 쓸 수 없는 서버
  항목), `invalid-skill` (Agent Skills 스펙을 벗어난 SKILL.md),
  `unsupported-transport` (`stdio`/`sse` — 보고만 하고 절대 실행하지 않는다),
  `headers-dropped` (서버는 sync 됐지만 mcp.json 이 선언한 헤더는 가져오지 않았다. `detail` 은
  그 이름만 나열한다), `duplicate-name` (두 plugin 이 그 이름을 주장한다. 주장한 쪽 모두
  건너뛴다), `credentials-reset` (위 참조), `write-failed` (쓰기 하나가 차단됐다. sync 의 나머지는
  계속됐고 다음 실행이 수렴시킨다).

최상위 `skipped` 는 어떤 plugin 도 소유하지 않는 것을 싣는다 — 쓸 수 없는 `plugin.json`, 다른
plugin 루트 안에 중첩된 plugin 루트, 두 루트가 주장하는 plugin 이름. `orphanedPlugins` 는 저장소가
더 이상 갖고 있지 않은 plugin 행을 나열한다. 그중 하나를 제거하면 (`remove.plugins` 로) 그 행만
지워진다 — 구성 요소는 각각 orphan 으로 따로 드러나며, 저마다 별개의 결정이다.

쓰기는 문서가 소유한 것만 대체한다 — skill 의 description·content·첨부, MCP 항목의 `url`,
`description`, `content` (plugin 의 `org.opspresso.agent-studio/mcp/<name>.md` 확장 문서에서
온다), `source`. 암호화된 헤더, 발견된 OAuth 블록, managed 항목의 프로비저닝된 주소는 절대
건드리지 않고, 문서가 싣지 않은 필드는 저장된 것을 그대로 둔다. MCP 항목의 주소를 옮기면 옛
주소에서 읽었던 OAuth 블록이 버려지므로 Discover 를 다시 돌려야 한다.

상류 실패(GitHub 도달 불가, 잘린 트리)는 다른 모든 라우트와 마찬가지로 `apiError` 를 통해
`502` 로 답한다. `PLUGINS_REPO` 나 `GITHUB_TOKEN` 이 없으면 `503` 이다.

project 별 Slack 설정은 이 엔드포인트들을 쓴다:

```
GET    /api/projects/{name}/slack
PUT    /api/projects/{name}/slack   { botToken?, signingSecret?, enabled?, suggestedPrompts?, channelKeywords? }
DELETE /api/projects/{name}/slack
POST   /api/projects/{name}/slack/test
GET    /api/projects/{name}/slack/channels
```

`suggestedPrompts` 는 `{ title, message }[]` 이고 최대 4개다. `title` 은 80자, `message` 는
500자로 제한된다. 빈 행은 버려지고, 한쪽만 채운 행이나 어느 한도든 넘긴 행은 400 이다. 두 인증
정보와 달리 이것은 secret 이 아니라서 저장된 그대로 돌아온다.
`channelKeywords` 는 `string[]` 이다 — 멘션 없이도 채널 메시지를 봇의 것으로 만드는 단어들이다
([design/slack.md](design/slack.md#어떤-이벤트가-봇에게-온-것인가) 참조): 최대 20개, 저장 시 각각
공백을 정리하고 소문자로 바꾸며, 2–50자다. 빈 값과 중복은 버려지고, 그 길이를 벗어난 키워드는
400 이다. `PUT` 에서 이 필드를 생략하면 저장된 목록을 유지한다.

Slack 읽기는 마스킹된 인증 정보 상태와 함께 `configured`, `eventsPath`, `eventsUrl`,
`suggestedPrompts`, `channelKeywords`, 그리고 생성된 앱 manifest 를 돌려준다 — 모든 동사가 그
같은 뷰로 답한다.
다섯 엔드포인트 모두 소유자와 설정된 admin 으로 제한된다 (그 외에는 403) — 마스킹된 뷰도 봇
토큰 / signing secret 의 양끝은 드러내기 때문이다. 마스킹되거나 생략된 secret 은 업데이트에서
보존되고, agent 가 아닌 project 에 대한 `PUT` 은 400 이다 — Slack 봇은 agent project 에만
붙는다. 저장된 것도 보낸 것도 없는 상태에서 봇 토큰과 signing secret 없이 `enabled: true` 를
보내는 `PUT` 도 마찬가지다: 켤 것이 없다.
테스트 엔드포인트는 `{ ok: true, team, botUser }` 를 돌려주고, 그 project 에 Slack 이 설정되지
않았거나 꺼져 있으면 `400`, Slack API 실패면 `502` 다.
채널 엔드포인트는 `{ channels: [{ id, name, isPrivate?, isMember? }] }` 를 돌려준다. 설정되고
활성화된 project bot의 token으로 읽으며, 보고서를 실제로 쓸 수 있도록 bot이 참가한 채널만
이름순으로 제공한다.

project 별 Telegram 설정은 이 엔드포인트들을 쓴다:

```
GET    /api/projects/{name}/telegram
GET    /api/projects/{name}/telegram/chats
PUT    /api/projects/{name}/telegram          { botToken?, enabled? }
DELETE /api/projects/{name}/telegram
POST   /api/projects/{name}/telegram/test
POST   /api/projects/{name}/telegram/webhook
```

설정의 다섯 동사는 같은 뷰로 답한다: `enabled`, `configured`, 마스킹된 `botToken`, 봇의
`botUsername` (토큰을 저장할 때 알아낸 것. secret 이 아니다), `webhookPath`, `webhookUrl`.
여섯 endpoint 모두 소유자와 설정된 admin 으로 제한된다. `PUT` 의 *새* 토큰은 저장하기 전에
Telegram(`getMe`)으로 확인하고, Telegram 이 거부하면 400 이다. 마스킹되거나 빈 토큰은 저장된
것을 유지한다. webhook secret 은 첫 토큰과 함께 이 플랫폼이 발행하며 절대 돌려주지 않는다 —
그것이 필요한 쪽은 Telegram 뿐이다. **webhook 은 `PUT` 이 스위치를 따라 관리한다**: `enabled`
가 켜지면 이 배포의 URL 에 등록하고, 꺼지면 삭제하며, 토큰이 바뀌면 이전 봇의 webhook 을 물리고
secret 을 새로 발행한 뒤 켜져 있으면 새 봇을 등록한다. 그 Telegram 호출이 실패하면 저장은 그대로
되고 응답에 `warnings: string[]` 로 말한다. `POST …/telegram/webhook` 은 같은 등록을 명시적으로
다시 하는 것이고(`PUBLIC_BASE_URL` 이 바뀐 뒤 옮길 때) `{ ok: true, url }` 로 답한다. `DELETE`
는 Telegram 에 webhook 을 없애라고 최선을 다해 알리고, 어느 쪽이든 인증 정보는 잊는다. project
를 지울 때도 행이 사라지기 전에 webhook 을 물린다. Slack 처럼
agent 가 아닌 project 에 대한 `PUT` 은 400 이고, 저장되거나 전달된 토큰 없이 켜는 것도
마찬가지다. `test` 는 `{ ok: true, botId, botUsername }` 을 돌려주고, Telegram 이 설정되지
않았거나 꺼져 있으면 `400`, Bot API 실패면 `502` 다. `webhook` 도 같은 방식으로 답한다.
`chats` 는 현재 설정된 봇이 실제로 응답 대상으로 받은 chat 과 포럼 topic 을 최근에 본 순서로
`{ chats: [{ chatId, chatType, title, threadId?, lastSeenAt }] }` 에 담아 돌려준다. Telegram Bot API
에는 봇의 chat 목록을 조회하는 호출이 없으므로, 아직 이 봇과 대화하지 않은 목적지는 나타나지
않는다. 토큰을 바꾸면 새 봇의 목록만 보인다.

이벤트 엔드포인트 자체인 `POST /api/telegram/webhook/{project}` 는 Telegram 이 호출하는 것이다
(사람이 아니다): 본문이 1MB 를 넘으면 413, `X-Telegram-Bot-Api-Secret-Token` 이 틀리거나 없으면
401, 봇이 무시하는 업데이트는 아무것도 claim 하지 않은 `{ ok: true }`, 재전송은
`{ ok: true, duplicate: true }`, 그 밖의 것은 `{ ok: true }` 이고 런은 ack 이후에 처리된다
([design/telegram.md](design/telegram.md) 참조).

프로젝트별 Teams 설정은 이 엔드포인트들을 쓴다:

```
GET    /api/projects/{name}/teams
PUT    /api/projects/{name}/teams          { appId?, appPassword?, tenantId?, enabled? }
DELETE /api/projects/{name}/teams
POST   /api/projects/{name}/teams/test
```

모든 동사가 같은 뷰로 답한다: `enabled`, `configured`, `appId`(secret 이 아니다 — 모든 토큰의
audience 다), 마스킹된 `appPassword`, `tenantId`, `messagingPath`, `messagingUrl` — Azure Bot 의
messaging endpoint 로 붙여 넣을 주소다. 넷 모두 소유자와 설정된 admin 으로 제한된다. `PUT` 은
App ID 와 테넌트 id 가 GUID 인지만 확인하고 Microsoft 에는 아무것도 묻지 않는다 — 한 쌍이
동작한다는 증거는 `test` 가 저장된 자격 증명으로 토큰을 받아 보는 것이고(`{ ok: true, appId,
expiresInSeconds }`, 설정되지 않았거나 꺼져 있으면 `400`, Microsoft 가 거절하면 `502`), 저장이
아니라 운영자가 요청하는 네트워크 호출이다. 마스킹되거나 빈 secret 은 저장된 것을 유지하고,
agent 가 아닌 project 에 대한 `PUT` 과 자격 증명 없이 켜는 것은 400 이다. `DELETE` 는 등록을
잊는다 — Azure 쪽 endpoint 는 운영자가 지운다.

messaging 엔드포인트 자체인 `POST /api/teams/messages/{project}` 는 Bot Framework 가 호출하는
것이다: 본문이 1MB 를 넘으면 413, bearer 토큰이 서비스의 키로 검증되지 않거나 이 App ID 를
audience 로 하지 않거나 activity 의 `serviceUrl` 을 위해 발급된 것이 아니면 401, 봇이 무시하는
activity 는 아무것도 claim 하지 않은 빈 200, 재전송은 빈 200, 그 밖의 것은 빈 202 이고 런은 ack
이후에 처리된다 ([design/teams.md](design/teams.md)).

## 관리형 MCP 서버

managed 서버는 이 배포가 SSM Run Command 로 자기 호스트에서 직접 띄우고 loopback 으로 닿는
컨테이너다. 네 엔드포인트 모두 **admin 전용**이고, `MANAGED_MCP_INSTANCE_ID` /
`MANAGED_MCP_REGISTRY` 가 설정돼 있지 않으면 넷 다
`503 { "error": "This deployment is not configured to run managed MCP servers." }` 로 답한다 —
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
{ "name": "my-tool", "image": "…/my-mcp:1.4.0", "containerPort": 8080,
  "args": ["--port", "{{PORT}}"]?, "endpointPath": "/mcp"?,
  "environment": { "LOG_LEVEL": "info" }?, "envRefs": ["/agent-studio/my-tool/API_KEY"]?,
  "description": ""?, "content": ""?, "headers": {}? }
```

- `name` 은 slug (`^[a-z0-9][a-z0-9-]{0,62}$`) 다. 컨테이너의 이름이기도 하기 때문이다.
- `args` 는 셸 명령이 아니라 **argv 배열**이다. 최대 64개, 각각 1024자 이하이며 제어 문자가
  없어야 한다. 인자 안의 `{{PORT}}` 는 실제 listen 포트로 치환된다. `PORT` 환경변수를 존중하지
  않는 이미지를 위한 것이다.
- `environment` 값은 레지스트리 행에서 암호화되고, 읽을 때 마스킹되며, 워크로드 스펙을 만들 때만
  복호화된다. `PORT` 는 거절된다 — 그것은 런타임이 소유한다. 값이 Parameter Store 에 남아 있어야
  하면 대신 `envRefs` 를 쓰라. 키는 `^[A-Za-z_][A-Za-z0-9_]*$` 이고 값은 16,384자까지 간다.
- `endpointPath` 의 기본값은 `/mcp` 이고, query·fragment·공백이 없는 절대 경로여야 한다
  (`^\/(?!\/)[^\s?#]*$`). 그 밖의 것은 `400` 이다.
- `PUT`/`DELETE` 의 `403` 은 모든 레지스트리 라우트가 답하는 repo 소유 거절이다: sync 된 항목의
  `description` 과 `content` 는 저장소의 것이고, 워크로드 필드(`image`, 포트, env)는 여기서 계속
  수정할 수 있다.
- `image` 는 호스트가 pull 할 수 있는 어떤 레지스트리에서 와도 된다. `MANAGED_MCP_REGISTRY` 는
  `docker login` 이 인증하는 그 하나이고, 그 밖의 것에는 로그인을 건너뛴다.
- `containerPort` 는 요청이지 보장이 아니다: 포트 매핑을 게시하는 어댑터만이 그것을 존중할 수
  있다. 배포된 어댑터는 대신 네트워크 네임스페이스를 공유하므로, 컨테이너에 어느 포트로 bind 할지
  (`PORT`) 알려 주고 저장된 값은 무시한다.

`GET` 은 **실제로 돌고 있는 것**을 보고한다. 저장된 항목만으로는 말할 수 없는 것이다.
`running` 과 `reachable` 이 따로인 것은 일부러 그런 것이다: "돌고 있지만 닿을 수 없음"은 실재하는
상태다 — 재배포로 네트워크 네임스페이스에 고립된 컨테이너는 `docker inspect` 에는 건강해 보이고
아무도 주소로 닿을 수 없다 — 그리고 앞의 것만 보고했던 것이 하나를 반나절 동안 건강해 보이게 둔
원인이다.

`PUT` 은 저장된 설정을 갱신하고, 워크로드 스펙이 바뀌었으면 자동으로 재시작한다.
`DELETE` 는 컨테이너와 항목을 함께 제거한다. 어느 쪽도 다른 쪽보다 오래 남지 않는다.

`POST …/restart` 는 이 앱이 *지금* 가진 네임스페이스에 대고 컨테이너를 다시 만든다 — 재배포가
그것을 고립시킨 뒤의 복구다. **본문 없는 202** 로 답한다: 컨테이너를 띄우는 일은 런타임을 몇 분
동안 폴링하는 것이고 이는 어떤 클라이언트가 기다릴 시간보다도 훨씬 길다. 그래서 결과는 호출자가
`GET` 을 폴링해서 가져간다. 본문이 없는 이유는 저장된 항목이 암호화된 헤더 값을 싣고 있는데
여기는 그것을 마스킹하는 읽기 경로가 아니기 때문이다.

## MCP OAuth

소유자가 서로 다른 두 반쪽이다: **레지스트리 항목**의 authorization-server 메타데이터는 운영자
설정(admin)이고, 그것을 쓰는 **인증 정보**는 project 별(owner)이다 — 그래서 공유된 항목 하나가
project 마다 다른 프로바이더 앱을 뒷받침할 수 있다.

### Discovery (admin)

```
POST   /api/mcps/{name}/auth   { "authorizationServer": "https://…"? }
→ 200 { status: "discovered", auth: {…} }
→ 200 { status: "choose", resource: "…", authorizationServers: ["…", "…"] }
DELETE /api/mcps/{name}/auth   → 204     (return the entry to static-header behaviour)
```

RFC 9728 protected-resource 메타데이터 → RFC 8414 authorization-server 메타데이터 순으로
따라가며, 발견된 모든 엔드포인트를 SSRF 정책으로 다시 검증하고 `https` 일 것을 요구한다.
리소스가 authorization server 를 하나보다 많이 광고하면 이 호출은 `choose` 를 돌려준다.
광고된 값 중 하나를 `authorizationServer` 에 넣어 다시 호출하라.

쓸 만한 문서를 게시하지 않는 서버 — 또는 닿을 수 없는 서버 — 는 시도한 후보 URL 들과 각각이 왜
실패했는지를 담아 **400** 으로 답한다.
[선언된 내부 호스트](SECURITY.md#선언된-내부-호스트) 의 항목에 닿는 것은 런에서와 마찬가지로
여기서도 동작한다.

항목의 **URL** 을 수정하면 `auth` 블록은 그대로 버려진다 — 그것은 옛 주소의 well-known 문서에서
읽어 온 것이었다.

### 연결 (owner)

```
GET    /api/projects/{name}/mcp-connections
→ 200 { connections: [ { serverName, status, clientId, clientSecret?, clientRegistered,
                         scopes, connectedBy?, connectedAt?, expiresAt? } ] }

PUT    /api/projects/{name}/mcp-connections/{server}
       { clientId, clientSecret?, scopes?: [] }        → 200 { …connection view… }
DELETE /api/projects/{name}/mcp-connections/{server}   → 204

POST   /api/projects/{name}/mcp-connections/{server}/authorize
→ 200 { authorizeUrl: "https://provider/authorize?…" }

POST   /api/projects/{name}/mcp-connections/{server}/tools
       { headerOverrides?: { "X-Tenant": "acme", "X-Shared": null } }
→ 200 { tools } | 502 { error }
```

- `status` 는 `needs_auth` | `connected` | `needs_reauth` 다. 연결을 `needs_reauth` 로 옮기는
  것은 **거부된 grant** 뿐이다. 5xx 나 타임아웃은 그대로 둔다.
- `clientSecret` 은 읽을 때 마스킹되고 **토큰은 절대 돌려주지 않는다** — A2A 키나 project API
  토큰과 달리 reveal 경로가 없는데, 토큰은 표시될 이유가 없기 때문이다. 쓰기에서 생략되거나
  마스킹된 값은 저장된 것을 유지한다. **빈** 값은 그것을 지우며, 이것이 confidential 클라이언트에서
  public 클라이언트로 돌아가는 유일한 길이다.
- `clientRegistered` 는 인증 정보가 손으로 입력된 것이 아니라 RFC 7591 동적 등록에서 왔을 때
  `true` 다.
- `/authorize` 는 `3xx` 를 내는 대신 프로바이더 URL 을 **돌려준다**: 호출자는 콘솔의 `fetch` 이고,
  그것은 사용자를 보내는 대신 리다이렉트를 자기가 따라가 버릴 것이기 때문이다.
- `auth` 블록이 없는 레지스트리 항목은 연결할 대상이 없으므로 `PUT` 과 `/authorize` 는 `400` 으로
  답한다. `/authorize` 는 공개 base URL 이 설정되지 않았을 때, 서버가 동적 등록을 제공하지 않고
  손으로 입력한 클라이언트도 없을 때, 그리고 저장된 인증 정보가 지금 그 항목이 지목하는 것과 다른
  issuer 에서 발급됐을 때도 `400` 이다. `DELETE` 는 그 project 가 그 서버에 연결을 갖고 있지
  않으면 `404` 로 답한다. `/tools` 는 실행에 연결이 필요 없고, 그 `404` 는 레지스트리 항목 자체가
  사라졌다는 뜻이다.
- `/tools` 는 **이 project 가 보는 대로** 그 서버의 도구를 나열한다 — project 자신의 연결과 그
  바인딩의 헤더 오버레이를 얹어서. 레지스트리 자신의 `POST /api/mcps/{name}/tools` 프로브와는
  구별된다. 그쪽은 항목의 정적 헤더만 싣기 때문에 OAuth 서버에 대해서는 401 밖에 낼 수 없다.
  소유자 게이트인 이유도 같다: 그 project 의 연결을 소비한다. 그 `502` 는 서버에 아예 닿지 않는
  두 거절도 포함한다 — 아웃바운드 가드가 막는 URL, 그리고 인증 정보를 해석할 수 없는 연결이다.

### 콜백

```
GET /api/mcps/oauth/callback?code=…&state=…&iss=…    (session)
```

authorization server 가 **브라우저**를 여기로 리다이렉트하므로, 이 엔드포인트는 JSON 이 아니라
스스로 닫히는 작은 HTML 페이지로 답한다: 결과를 opener 에게 `postMessage` 하고 닫히며, 평범한
탭에서 열렸더라도 읽을 만하게 보인다. 어느 쪽이든 상태 코드는 `200` 이다 — 상태 코드는 페이지를
서빙한 일을 말하고, 결과는 메시지 안에 있다. 일회성 결과를 싣기 때문에
`Cache-Control: no-store` 다.

콜백은 code 를 교환하기 전에 RFC 9207 `iss` 를 검증하고, 사용자가 프로바이더에 가 있는 동안
바뀔 수 있는 project 소유권을 다시 확인한다. 검사 전체는
[SECURITY.md](SECURITY.md#mcp-oauth) 를 보라.

### Client ID 메타데이터 문서

```
GET /api/mcps/oauth/client-metadata/{project}          (public)
```

그 project 의 OAuth Client ID Metadata Document 다. authorization server 가 URL 인
`client_id` 를 해석하려고 가져간다 (프로토콜 `2026-07-28`. 이 개정은 동적 등록을 deprecate 하지만,
문서를 받아들이지 않는 서버에는 여전히 그것이 폴백이다).
**일부러 비인증이다** — 읽는 쪽이 세션 없이 도착하는 그 서버다 — 그리고 secret 을 싣지 않는다:
배포의 이름과, 받아들이는 단 하나의 redirect URI 뿐이다. slug 가 아닌 이름은 `404`, 공개 base
URL 이 설정되지 않았으면 `503`, 그리고 `Cache-Control: public, max-age=300` 이다.

## Project API 토큰

project 별 토큰은 외부 호출자가 세션 쿠키 대신 `Authorization: Bearer <token>` 으로 실행
엔드포인트에 닿게 해 준다. 토큰은 해시가 아니라 AES-256-GCM 으로 암호화해 저장되므로, 소유자가
요청하면 다시 읽어 볼 수 있다.

```
GET    /api/projects/{name}/token          → { configured, masked?, createdAt?, revealable? }
POST   /api/projects/{name}/token          → { token, masked, createdAt }   (raw token)
POST   /api/projects/{name}/token/reveal   → { token, createdAt }           (raw token)
DELETE /api/projects/{name}/token          → 204
```

토큰은 `ast_` + 랜덤 32바이트(base64url)다. `masked` 는 생성 시점에 기록된 표시용 마스크
(`ast_••••…••wXyZ`)다 — 토큰 자체는 복구 불가능하게 남으므로, 콘솔이 복호화하지 않고 *어느*
토큰이 설정돼 있는지 보여 줄 수 있는 유일한 방법이 이것이다. 마스크를 기록하기 전에 발급된
토큰에는 없다. 검증이 접두사를 보는 일이 없으므로 그런 토큰도 계속 동작한다.

넷 다 소유자와 설정된 admin 으로 제한된다 (그 외에는 403). `POST` 는 토큰을 생성하거나 재생성한다 —
재생성은 이전 토큰을 덮어쓰고, 그 토큰은 즉시 동작을 멈춘다. 토큰은 자기 project 범위로 한정된다
(요청 경로의 `{name}` 에 대해 검증된다).

생성에는 **소유자의 tier** 게이트가 추가로 걸린다: API 토큰을 쓸 수 없는 tier
(`src/domain/member/tiers.ts` 의 `TIER_LIMITS` — 오늘로는 `guest`) 는 admin 을 포함해 누가
요청하든 `403` 으로 답한다. 그 토큰이 그 소유자로서 인증하게 되기 때문이다. 인증 시점의 대응
게이트는 아래 실행 엔드포인트에 있다.

`/reveal` 은 읽기인데도 POST 다: 본문이 살아 있는 인증 정보라서 캐시·히스토리·프리페치 밖에
머물러야 한다. 암호화 저장 이전에 발급된 토큰은 `revealable` 이 `false` 다 — 해시만 존재하므로
`/reveal` 은 재생성하라는 안내와 함께 `400` 으로 답한다. 검증은 두 형태를 모두 받아들인다
(상수 시간 복호화-비교, 또는 레거시 토큰의 해시 비교). 모든 reveal 은 호출자의 이메일과 함께
서버 측에 로그된다.

## 실행

아래 세 엔드포인트는 세션 쿠키 또는 project API 토큰(`Authorization: Bearer <token>`)으로
인증한다. 토큰은 project 소유자로서 인증한다. 유효하지만 그 소유자의 *현재* tier 가 API 토큰을
쓸 수 없는 토큰은 `403` 으로 답한다 (`401` 이 아니다 — 인증 정보는 유효하고 정책이 거절하는
것이다). 그래서 소유자를 강등하면 그의 토큰은 즉시 멈춘다.

셋 다 `MAX_RUN_DURATION_MS` 로 한계 지어지고 (거절이 아니라 런을 스트림 도중에 끊는 벽시계
데드라인이다), 호출자별 동시성 가드와 그 project 의 비용 가드를 거쳐 admit 된다 — 둘 중 어느
쪽이든 `Retry-After` 와 함께 `429` 로 답한다. 세션 런은 호출자의 tier 로도 한계 지어지고
(동시성과 월간 비용 상한. 후자는 세 번째 `429` 다), 토큰 런은 그렇지 않다 — 토큰의 지출은
개인 예산이 아니라 언제나 project 에 속한다.

그 데드라인에 걸린 런은 **`504`** 와 함께 무엇이 자기를 멈췄는지 말한다
(`This run was stopped after 600 seconds, …`). 스트리밍 요청이면 같은 문장이 마지막
`error` 프레임으로 나간다. 호출자가 먼저 떠난 것은 실패가 아니므로 `499` 이고, 이 둘을
가르는 것은 abort 의 *이유* 가 아니라 어느 신호가 끊었는가다.

**`X-Conversation-Id`** (선택, 셋 모두) 는 그 요청이 속한 대화를 지목한다. 이 세 엔드포인트는
자기 스레드가 없으므로 연속성은 호출자가 선언할 몫이다: 한 대화의 후속 질문들에 같은 값을 보내면
런은 그것을 `RunOrigin.conversation` 으로 싣는다 — 그 런이 transfer 하는 A2A subagent 는 첫
질문이 연 원격 대화를 이어 가고, 그 런이 호출하는 모든 MCP 서버는 그 키를 전달받는다
(`X-Conversation-Id: api:{caller}:{value}`). `{caller}` 는 호출하는 actor 를 이 배포 자신의
secret 으로 키잉해 만든 16자리 hex 다이제스트다 — `1` 을 보내는 두 호출자는 두 개의 대화에 있고,
이메일은 전혀 이동하지 않으며, 그 다이제스트는 이 배포 밖에서는 아무 의미가 없다. 값은 필요한
곳에서 퍼센트 인코딩된다 (공백, 제어 문자, 출력 가능한 ASCII 밖의 모든 것, 그리고 `%`). 이는
UUID 나 평범한 키에 대해서는 아무것도 바꾸지 않으면서 서로 다른 두 값을 두 개의 대화로 유지한다.
인코딩 후 최대 495자이고, 그보다 긴 헤더는 자기가 선언한 대화 없이 조용히 실행되는 대신 `400` 으로
답한다. 없으면 각 요청이 저마다의 대화이며, 이는 이 헤더가 생기기 전 모든 요청이 그랬던 것과
같다. 표면이 스레드를 *가진* 곳에서는 플랫폼이 직접 이름을 붙인다: chat 은 `chat:{chatId}`,
Slack 답글은 `slack:{channel}:{threadTs}`, 인바운드 A2A 메시지는 `a2a:{client}:{contextId}` 다.
[design/observability.md](design/observability.md#사용량과-비용-귀속) 를 보라.

### `POST /api/projects/{name}/versions/{version}/predict`

그 version 을 실행한다. `{version}` 은 `published` 여도 된다.

이 엔드포인트는 `chat/completions` 처럼 `projectType` 에 따라 dispatch 한다: `llm` project 는
서버 측 `{{var}}` 템플릿 렌더링과 함께 completion 하나를 실행하고, **`agent` project 는 그
version 의 MCP 도구·skill·subagent 로 멀티턴 도구 루프를 실행한다**. 그래서 agent project 에서는
`variables` 가 무시된다 — agent 런에는 렌더링할 프롬프트 템플릿이 없다.

```json
// request (llm project)
{ "variables": { "topic": "otters" }, "messages": [ … ]?, "stream": false }
// request (agent project)
{ "messages": [ { "role": "user", "content": "hi" } ], "stream": false }
// response
{ "result": "…assistant text…", "model": "openai/gpt-5-mini",
  "usage": { "inputTokens": 12, "outputTokens": 34, … },  // cachedTokens 와 reasoningTokens 는
                                                          // 각각 앞의 두 수의 *부분집합*이며,
                                                          // 프로바이더가 보고했을 때만 실린다
  "finishReason": "completed",  // 런이 끝난 이유: "turn-limit" / "output-limit" 은 부분 답을 뜻한다
  "warnings": [ "Skill 'x' is no longer in the registry; it was not offered." ]?,  // 런이 무언가를 잃었을 때만
  "images": [ { "b64": "…", "mimeType": "image/png" } ]?,  // 런이 무언가를 그렸을 때만
  "files": [ { "name": "report.docx", "mimeType": "…", "byteSize": 2048, "url": "https://…" } ]?  // 툴이 파일을 만들었을 때만
}
```

`files` 는 도구가 만들어 낸 문서다 — 바이트는 artifact 로 보관되고 런의 스트림에서 떼어내지므로,
여기 실리는 것은 파일이 아니라 **서명된 다운로드 주소**다. 서명은 수명이 짧다 (API 응답에는 15분,
링크가 지속되는 기록으로 들어가는 곳 — Slack 스레드, 저장된 A2A task — 에는 7일). artifact 자체는
그 project 의 갤러리에 남는다. 오브젝트 스토리지가 없는 배포에서는 바이트를 떼어내지 않으므로,
raw-chunk 표면은 대신 자기 프레임에 파일을 인라인으로 실어 보낸다. 이 배포가 보관하지 못했거나
서명하지 못한 파일은 나열되는 대신 `warnings` 로 보고된다. 런이 만들어 냈는데 호출자에게 존재조차
알려 주지 않은 문서는 플랫폼이 그것을 잃어버린 것으로 읽히기 때문이다.

`warnings` 는 그 답에 이르는 길에 런이 무엇을 잃었다고 보고했는지다 — 더 이상 레지스트리에 없는
바인딩, 아웃바운드 가드가 막은 MCP 서버, 런당 상한을 넘은 도구들, 잘린 transfer 전사, 빈손으로
돌아온 subagent. 스트리밍된 런은 이런 것들을 그때그때 `warning` 프레임으로 말한다. 모아서 주는
본문에는 나중의 프레임이 없으므로 이것들이 답과 함께 이동한다. 없으면 잃은 것이 없다는 뜻이다.

`image` project 에는 `{ "prompt?", "variables?", "size?", "quality?", "images?" }` 를 보내면 →
`{ imageBase64, mimeType, model, usage, warning? }` 를 받는다. `warning` 은 그림은 그렸는데
보관하지 못했다는 것 — 스트리밍 표면이 `warning` 프레임으로 말하는 것과 같은 손실이다. `prompt` 는 그 version 의
`userPromptTemplate` 을 덮어쓴다. 생략하면 `variables` 로 렌더링한 템플릿이 프롬프트가 되고,
어느 쪽이든 결과가 비면 400 이다. `images` 는 인라인 바이트로 담은 원본 그림이다
(`[ { b64, mimeType } ]`, chat 첨부와 같은 상한). 하나라도 있으면 프롬프트는 그것을 **편집**하고,
없으면 처음부터 그린다. 그 version 의 시스템 프롬프트는 설정돼 있으면 version 의 지속적인 스타일로서
프롬프트 앞에 붙는다. `stream` 은 image project 에 적용되지 않고 — 그림 하나에 본문 하나다 —
거기서는 무시된다.

그 밖의 모든 project 타입에서 `"stream": true` 는 위의 JSON 본문 대신 SSE `EngineChunk` 프레임으로
답한다 (아래 `/agent` 가 문서화하는 것과 같은 계약이고, file 프레임도 같은 방식으로 주소가 붙는다).

이 엔드포인트가 끝내지 못한 런은 프로바이더가 뭐라고 했는지와 어느 모델에 요청한 것인지를 담아
`502` 로 답한다 — `Image generation failed for xai/grok-imagine-image: 404 The requested
resource was not found.` 모아서 주는 본문은 그것을 실어 나를 `error` 프레임이 없는 유일한 실행
표면이라, 이렇게 명시하기 전에는 같은 실패가 `500 Internal server error` 로 도착했고 프로바이더가
서빙하지 않는 모델을 지목한 version 은 크래시와 구별되지 않았다. 답이 나오기 전에 연결을 닫은
호출자는 아무것도 받지 못하고 그것은 `502` 가 아니다: 런은 취소되고, 로그는 프로바이더가 실패했다고가
아니라 호출자가 떠났다고 말한다. 기다림을 감안하라 — xAI 에서 이미지 하나는 1분쯤 걸린다.

### `POST /api/projects/{name}/versions/{version}/chat/completions`

OpenAI Chat Completions 호환이다. `agent` project 는 멀티턴 도구 루프를 실행하고, `llm`
project 는 completion 하나를 한다. `image` project 는 `400` 으로 거절된다 — 이미지에는 chat
completion 이 없다. 그것은 `/predict` 로 실행하라.

```json
// request
{ "model": "ignored-routes-by-version", "messages": [ { "role": "user", "content": "hi" } ],
  "variables": {}?, "stream": false }
// `temperature`/`max_tokens` 는 받지만 무시한다 — 샘플링은 version 에 저장된
// `parameters` 에서 온다.
// 응답: OpenAI chat.completion 객체 (stream=true 면 chat.completion.chunk SSE)
```

**이미지 입력.** 메시지 본문은 문자열 대신 OpenAI content part 여도 된다. 이미지 바이트는
`data:image/…;base64,…` url 로 인라인 이동한다. 원격 이미지는 `https://` 여야 한다. 페이로드
하나는 10MB 로 제한되고, 그 version 의 모델은 `imageInput` 능력을 가져야 한다 — 아니면 `400`
이며, 이미지를 읽을 수 없는 `fallbackModel` 은 그 요청에서 건너뛴다.

```json
{ "messages": [ { "role": "user", "content": [
    { "type": "text", "text": "what is in this picture?" },
    { "type": "image_url", "image_url": { "url": "data:image/png;base64,iVBORw0…", "detail": "auto" } }
] } ] }
```

**이미지 출력.** 런이 만들어 낸 이미지(`GenerateImage` / `EditImage` 빌트인, 또는 `image`
subagent)는 OpenAI 스키마에 자리가 없으므로 확장으로 함께 실려 간다: completion 객체의
`images: [ { b64, mimeType, prompt? } ]`, 그리고 스트림에서는 `choices[0].delta.images`
프레임이다. 이 필드를 모르는 클라이언트는 그냥 무시한다.

**파일 출력.** 같은 취급을 다시 하되 중요한 차이가 하나 있다: 문서는 그려지는 것이 아니라
*가져가는* 것이므로 주소로 이동한다 — completion 객체의 `files: [ { name, mimeType,
byteSize?, url } ]` 와 스트림의 `choices[0].delta.files` 프레임이다. 그 주소가 무엇이고 얼마나
사는지는 위 `/predict` 를 보라.

**런이 잃은 것.** 같은 취급, 같은 이유다: completion 객체의 `warnings: [ "…" ]` 와 스트림의
`choices[0].delta.warnings` 프레임이다. 런이 진행하면서 보고하는 손실이며 (위 `/predict` 참조),
이것이 없으면 이 표면에서는 성능이 깎인 런과 깨끗한 런이 같은 응답이 된다.

### `POST /api/projects/{name}/versions/{version}/agent`

Agent SSE 스트림이다. 본문은 `{ "messages": [ … ] }`. `EngineChunk` 프레임을 내보낸다
(`delta.content`, `toolResult`, `warning`, `image`, `file`, subagent 턴에는 `author`,
`error`, 그리고 런이 왜 끝났는지를 밝히는 종단 `done: true` 또는 `finishReason`). 그다음
`data: [DONE]` 이다. 필드 계약 전체는
[ARCHITECTURE.md](ARCHITECTURE.md#enginechunk-계약) 에 있다.

`file` 프레임은 이 엔드포인트를 **주소가 붙은 채로** 떠난다: 런 브래킷이 붙여 둔 object key 와
artifact id 는 수명이 짧은 서명 `url` 로 대체된다. 그 둘은 플랫폼 자신의 장부이고 호출자가 그것을
쥐어 봐야 할 수 있는 일이 없기 때문이다. 서명할 수 없었던 파일은, 아무것도 가져올 수 없는 문서를
지목하는 `file` 프레임 대신 `warning` 프레임으로 도착한다.

**agent project 만** — 그 밖의 타입은 400 이다. 도구 루프에는 `llm` project 의
`userPromptTemplate` 을 놓을 자리가 없고, `image` project 의 모델은 completion 을 서빙하지
않는다. 둘 다 `/predict` 를 쓰라.

이미 현재 transfer 사슬에 있는 project 로의 transfer, 또는 5단계 중첩을 넘는 transfer 는 재귀하는
대신 author 가 붙은 error chunk 로 거절된다.

## 사용량

```
GET /api/usages/summary?from=2026-01-01&to=2026-01-31[&project=my-bot]
→ 200 { "items": [ { projectName, date, calls, inputTokens, outputTokens, cachedTokens,
                     costUsd }, … ] }
      (every metric is a per-model map: { "provider/model": number })
→ 400 { "error": "…" }   (bad/oversized range: max 184 days, from ≤ to)
```

`cachedTokens` 는 `inputTokens` 중 프로바이더가 자기 프롬프트 캐시에서 서빙한 부분이며, 이미
캐시 단가로 값이 매겨져 있다. 이 필드가 존재하기 전에 기록된 날과 `prompt_tokens_details` 를
보고하지 않는 채널에 대해서는 `{}` 다 — 콘솔이 `0%` 가 아니라 빈칸을 렌더링하는 이유가 이것이다:
아무도 보고하지 않는 캐시는 차가운 캐시가 아니다.

### 호출자별 지출

```
GET /api/projects/{name}/usage/actors?from=2026-07-01&to=2026-07-31
→ 200 { "items": [ { projectName, date, actor, calls, inputTokens, outputTokens, cachedTokens,
                     costUsd, display?: { name, avatarUrl? } }, … ] }
```

`actor` 는 `{kind}:{id}` 다 — `user:a@example.com`, `project-token:owner@example.com` (토큰은
자기 소유자로서 인증하므로, 기계의 지출을 그 사람 자신의 런과 갈라 두는 것이 kind 다 — 그리고
개인 tier 예산에 계산되는 것은 `user:` 행뿐이다),
`slack:U123`, `telegram:123456`, `teams:{Entra object id}`, `a2a:shared-key`, 그리고 trigger 발화에는
`webhook:{project}:{triggerId}` 또는 `schedule:{project}:{triggerId}` 다. 지표 필드는 위 요약과
정확히 같이 모델별 맵이다.

`display` 는 `slack:` 행에 얼굴을 붙여 준다. 그 project 자신의 봇 토큰으로 해석한다. 장식이며
어떤 이유로든 없을 수 있다 — Slack 봇 없음, 회수된 토큰, 비활성화된 사용자, Slack 장애 — 그리고
어느 경우에도 `actor` 는 그대로다. 두 호출자를 구별하는 키가 그것이기 때문이다. `telegram:` 행은
`display` 를 싣지 않는다: Bot API 는 사용자 id 로 프로필을 조회하는 방법을 제공하지 않으므로 있는
것은 id 뿐이다.

트레이스와 같은 이유로 소유자/admin 전용이다: project *총계*는 카탈로그가 공유되므로 로그인한
사용자 누구에게나 열려 있지만, 호출자별 분해는 개인의 이름을 담는다. 범위 검증은
`/api/usages/summary` 와 같다 (두 날짜 모두 필수, `from ≤ to`, 184일 이하). 다만 여기의 거절은
`/api/usages/summary` 가 싣는 `issues` 배열이 아니라 벌거벗은 `{ error }` 다. subagent transfer 는
transfer 해 들어간 project 가 아니라 런을 시작한 사람에게 귀속된다.

## Triggers

한 project 는 project 이름만으로 주소가 정해지는 **webhook 하나**와, 각각 이름을 가진 임의 개수의
**schedule** 을 갖는다. 둘 다 trigger 행이고 아래 내용을 전부 공유한다. webhook 은 예약된 id
`webhook` (`PROJECT_WEBHOOK_ID`) 아래 저장되고, `create` 는 그 양쪽을 400 으로 강제한다 —
webhook 은 다른 id 를 가질 수 없고, schedule 은 이 id 를 가질 수 없다. 앞의 것은 발행된 secret 이
그것을 쓸 주소도 없이 존재하는 일을 막아 준다. `/api/webhook/{project}` 가 해석하는 것은 그 id
하나뿐이기 때문이다. 콘솔에 "webhook 만들기" 단계가 없는 것도 같은 이유다: Settings → Webhook 은
스위치이고, 그것을 처음 켜는 것이 그 행을 쓴다.

설정 (owner/admin):

```
GET    /api/projects/{name}/triggers                     → 200 { triggers: [ … ] }
POST   /api/projects/{name}/triggers                     → 201 { …, secret? }  | 409
PUT    /api/projects/{name}/triggers/{trigger}           → 200 { … }           | 404
DELETE /api/projects/{name}/triggers/{trigger}           → 204                 | 404
POST   /api/projects/{name}/triggers/{trigger}/reveal    → 200 { secret, createdAt }
GET    /api/projects/{name}/triggers/{trigger}/runs?limit=20 → 200 { runs: [ … ] }   (1–100)
```

생성 본문: `{ triggerId (slug), kind?, description?, enabled?, variables?, payloadMode?,
allowConcurrent?, cron?, timezone?, message?, deliveries? }`. `kind` 의 기본값은 `webhook` 이다. `schedule` 은
`cron` (다섯 필드) 과 `timezone` (IANA) 을 요구하고, 각 kind 는 상대의 필드를 무시하는 대신 400
으로 거절한다 — `rotateSecret`/`payloadMode` 는 webhook 의 것이고,
`cron`/`timezone`/`message`/`deliveries` 는 schedule 의 것이다. `deliveries` 는 최대 3개이고
플랫폼을 중복할 수 없는 tagged union 이다: `{ kind: "slack", channelId }`,
`{ kind: "telegram", chatId, threadId? }`, `{ kind: "teams", conversationId }`. `triggerId` 는 project 이름과 같은 규칙
(`^[a-z0-9-]+$`) 을 따른다. 콘솔은 입력한 것을 project 폼이 쓰는 것과 같은 `toSlug` 헬퍼로
정규화하고, API 는 클라이언트가 무엇이든 그 밖의 것을 거절한다.

평범한 읽기는 `secretMasked` 만 돌려준다 (webhook 에 한한다. schedule 에는 secret 이 없다).
secret 은 해시가 아니라 AES 로 암호화해 저장되므로 — project API 토큰과 정확히 같이 —
`POST …/reveal` 로 **다시 읽을 수 있다** (본문이 살아 있는 인증 정보라서 POST 다. 소유자/admin
전용이고, 모든 reveal 은 호출자의 이메일과 함께 로그된다). `rotateSecret: true` 를 담은 `PUT` 은
그것을 재발급하고 새 것을 돌려준다. 이전 secret 은 즉시 동작을 멈춘다.

전달 (세션 없음 — secret 이 인증이다):

```
POST /api/webhook/{project}
  X-Trigger-Secret: asw_…
  Idempotency-Key: <optional>
  { "any": "json payload" }
→ 202 { ok: true, status: "accepted", runId }
→ 202 { ok: true, status: "duplicate" | "disabled" | "busy" | "no-published-version" }
→ 401 (wrong or missing secret) | 404 (no webhook on this project) | 400 (bad JSON) | 413 (>1MB)
```

이것이 **유일한** 전달 주소다. `admitDelivery` 는 project 이름 자체에서 그 행을 해석하고 trigger
id 를 받지 않으므로, 바깥의 무엇도 전달이 어느 webhook 에 떨어질지 지목할 수 없다.

호출자가 재시도로 고칠 수 없는 거절에도 `202` 다: 전달은 받아들여졌고 그 결과가 기록됐으며,
운영자가 보는 곳이 거기다. 런을 시작하는 것은 `accepted` 뿐이다.

이 엔드포인트는 즉시 답하고 배경에서 실행한다 — 런은 10분까지 갈 수 있고 그만큼 기다리는 webhook
발신자는 없으므로, 결과는 응답이 아니라 그 전달의 이력 행에 있다. trigger 는 언제나 그 project 의
**publish 된** version 을 실행한다. `succeeded` 행도 `warning` 을 실을 수 있다 — 런이 실패하지
않고 보고한 것(부딪힌 턴·예산 한계, 쓸 수 없었던 바인딩)이다: 발화는 지켜보는 사람이 없고, 그
행이 그것을 위한 유일한 통로다.

`payloadMode: "message"` (기본값) 는 페이로드를 사용자 턴으로 직렬화한다 — agent project 가 읽는
것이다. `"variables"` 는 프롬프트 템플릿을 위해 페이로드의 최상위 스칼라 필드를 trigger 의 고정
`variables` 위에 펼친다. 스칼라가 아닌 필드는 `[object Object]` 로 렌더링되는 대신 버려진다.

`allowConcurrent` 의 기본값은 false 다: 하나가 아직 돌고 있는 동안 온 두 번째 전달은 런을 쌓아
올리는 대신 `skipped` 로 기록된다.

스케줄러 tick (세션 없음 — 공유 토큰이 인증이다):

```
POST /api/triggers/scan
  X-Scan-Token: <SCHEDULE_SCAN_TOKEN>
→ 200 { checked, fired, alreadyClaimed, skipped, repaired, invalid, errors }
→ 401 (wrong or missing token) | 503 (SCHEDULE_SCAN_TOKEN not configured)
```

Kubernetes CronJob 이 1분에 한 번 호출하는 것이다. ticker 는 상태를 쥐지 않는다: 어느 발생분이
도래했는지와 각각을 누가 차지하는지는 조건부 쓰기로 발생분마다 서버 측에서 결정된다 — 그래서 두 번
ticking 하든, 여러 곳에서 하든, 늦게 하든 절대 이중 발화하지 않는다. admit 된 발화는 webhook 전달과
정확히 같이 배경에서 실행되고, 그 결과는 그 trigger 의 이력 행에 남는다 (`scheduledFor` 가 발생분을
싣는다). 목적지가 설정된 schedule 은 성공한 텍스트 답을 각 플랫폼으로 전송하고, 이력의
`deliveryResults` 에 플랫폼별 `sent`/`failed` 를 남긴다. 전송 실패는 성공한 런을 실패로 바꾸지
않고 `warning` 에도 기록된다. `alreadyClaimed` 는 다른 tick 이 이미 차지한 발생분의 수다 — 겹치는 창에서 나오는 예상된
잡음이지 이상 징후가 아니다. 같은 요약이 매 tick 마다 서버 측에 로그되며, 운영자가 알림을 거는 것이
그것이다.

카탈로그 reindex (같은 공유 토큰, 별도 CronJob):

```
POST /api/catalog/reindex
  X-Scan-Token: <SCHEDULE_SCAN_TOKEN>
→ 200 { started: true }
→ 401 (wrong or missing token)
→ 503 (SCHEDULE_SCAN_TOKEN not configured — answered before the token is compared, so a
       deployment missing it gets this rather than a 401) | 503 (VECTOR_BUCKET not configured)
```

전역 capability 인덱스를 레지스트리에서 다시 만든다 — 모든 skill, 모든 MCP 서버와 그것이 제공하는
도구, 모든 외부 agent — 그리고 이제 그들에게 없는 것은 지운다. 작업은 배경에서 돌아가므로 결과는
응답 본문이 아니라 로그 한 줄(`indexed`, `removed`, `undiscovered`)이다. 두 번 ticking 해도
안전하다: 키가 항목에서 유도되므로 두 번째 패스는 같은 레코드를 쓴다. 시간당 한 번이면 충분하다 —
더 빠른 tick 은 모든 MCP 서버를 더 자주 찔러 볼 뿐이다.
[OPERATIONS.md](OPERATIONS.md#카탈로그-재색인) 를 보라.

## Artifacts

런이 만들어 낸 것 — 이미지와 문서 — 을 각각의 주소와 함께 담는다. `S3_BUCKET_NAME` 이 설정돼
있을 때만 존재한다. 그렇지 않으면 아래 모든 라우트가 빈 목록이 아니라 `404 {error}` 로 답하는데,
"당신은 만든 것이 없다"와 "애초에 아무것도 보관되고 있지 않았다"는 서로 다른 주장이기 때문이다.

```
GET /api/artifacts?[kind=image|document][&source=generated|attachment][&limit=24][&before=…][&from=2026-08-01&to=2026-08-12]
→ 200 { artifacts: [ … ], nextBefore?: "2026-08-11T22:03:00.000Z#8f0c…" } | 400 | 404
GET /api/projects/{name}/artifacts?…same query…
→ 200 { artifacts: [ … ], nextBefore?: … } | 400 | 403 | 404
DELETE /api/artifacts/{artifactId}
→ 204 | 403 | 404
GET /api/artifacts/{artifactId}/view
→ 200 text/html | 400 | 403 | 404
```

`/view` 는 주소가 아니라 **바이트로** 답하는 유일한 라우트다. 받는 것은 `SAVABLE_TYPES` —
런이 사람에게 읽히려고 쓰는 타입들 — 뿐이고 나머지는 400 이다. 목록의 기준은 표시할 수
있느냐가 아니라 **독자가 여는 것이냐 보관하는 것이냐**다. 브라우저가 알아서 그리는 PDF 는
sandbox 가 필요 없고, 다운로드는 애초에 신뢰를 요구하지 않는다.

응답은 어느 쪽이든 `text/html; charset=utf-8` 이고, **파일 타입마다 그것답게** 나간다.

| 저장된 타입 | 어떻게 보이는가 |
|---|---|
| `text/html` | 쓰인 그대로 |
| `text/markdown` | 채팅 스레드와 같은 렌더러로 렌더 |
| `text/csv` | 첫 행을 머리행으로 삼은 표 (RFC 4180 파싱, 2,000행 상한) |
| `application/json` | 다시 들여쓴 텍스트. 파싱되지 않으면 원문 그대로 + 그 사실을 말한다 |
| `image/svg+xml` | `<img>` 안의 그림 |
| `text/plain` | 원문 그대로 |

그래서 CSP 도 둘로 갈린다 — `text/html` 만 `sandbox allow-scripts` 이고(표 정렬·목차 추적이
다운로드 대신 그것을 여는 이유다), 나머지는 그냥 `sandbox` 다. 나머지는 전부 앱이 바이트에서
만든 페이지라 실행할 스크립트가 애초에 없고, 그 보장을 이스케이프가 아니라 브라우저가 하게
둔다. 모두 `default-src 'none'` 으로 불투명 오리진에 놓이므로 그 페이지는 콘솔의
쿠키·스토리지·DOM 에 닿지 못하고 서브리소스를 하나도 불러오지 못한다. `text/html` 만은
스스로 다른 주소로 *이동*할 수 있다 — 자기 스크립트를 돌려주는 일에 딸린 값이다
([SECURITY.md](SECURITY.md#저장된-시크릿) 의 artifact 항목).

서명된 오브젝트 URL 로는 그 헤더를 실을 수 없고, 건네진 주소는 그것을 연 사람의 권한보다
오래 산다 — public 모드에서는 영구다. 그래서 페이지만은 앱을 통해 나간다. 읽기 상한은
2 MB 이고, 권한 술어는 삭제와 같다.

각 행은 `artifactId`, `kind`, `source`, `key` (object key), `mimeType`,
`byteSize`, `filename?`, `projectName`, `versionName`, `actor?`, `ownerEmail?` (Slack 런의
출력이 누구 앞으로 정리되는지. 물어본 사람에서 해석한다), `ancestry?` (transfer 사슬. 바깥쪽이
먼저), `producedBy?`, `model?` (그린 모델. 이름을 댈 수 있는 생산자만 — MCP 도구·원격 A2A 의
그림, 렌더링된 문서, 첨부는 비어 있다), `runId?`, `prompt?`, `createdAt`, 그리고 서명된 `url` (15분. 문서의 것은
자기 이름으로 내려받도록 서명된다) 을 싣는다. URL 은 타일마다 가져오는 대신 인라인으로 들어간다 —
사전 서명은 로컬 서명이라 한 페이지치가 비용이 들지 않는 반면, 각각 왕복하면 갤러리가 N+1 이 된다.
주소를 만들 수 없으면 없으며, UI 는 그것을 깨진 이미지가 아니라 사용 불가로 렌더링한다.

**두 목록은 한 집합의 두 가지 뷰가 아니다.** `/api/artifacts` 는 소유자 인덱스를 읽는데, 여기에는
actor 가 이메일을 지목하는 행만 들어 있다 — Slack·A2A·webhook·schedule 런은 그렇지 않다. 그런
것들은 자기 project 를 통해서만 닿을 수 있고, 그래서 지울 수 있는 곳도 거기뿐이다. `from`/`to` 는
실재하는 날짜로 검증되는 UTC 일이고, `before` 는 이전 페이지의 `nextBefore` 다.

삭제는 생성자, 그 project 의 소유자, 그리고 설정된 admin 에게 허용된다. 남의 출력을 지우면
`artifact.delete` 감사 행이 기록되고, 자기 것을 지우면 그렇지 않다. chat 메시지는 object key 의
사본을 자기가 갖고 있으므로, 여기서 지운 이미지는 그것을 보여 주던 전사에서 사용 불가로 렌더링된다
— 확인 절차가 그렇게 되기 전에 그 사실을 말해 준다.

## 트레이스

```
GET /api/projects/{name}/traces?limit=50[&from=2026-07-01&to=2026-07-31]
→ 200 { traces: [ … ] } | 400
GET /api/projects/{name}/traces/{traceId}
→ 200 { …the trace itself, unwrapped… } | 404
```

`from`/`to` (YYYY-MM-DD, 양끝 포함) 는 GSI1 날짜 키로 목록을 트레이스 날짜로 거른다. 잘못된
형식의 날짜나 뒤집힌 범위는 `400` 이다. `limit` 의 기본값은 50 이고 1–100 으로 제한된다.
다른 project 에 속한 `traceId` 는 남의 트레이스가 아니라 `404` 다.

두 엔드포인트 모두 소유자와 설정된 admin 으로 제한된다 (그 외에는 403) — 트레이스는 다른 사용자의
런타임 입력/출력을 담고 있다. agent 런은 언제나 트레이싱된다. 텍스트와 이미지 predict 런은
`TRACE_SAMPLE_RATE` (0–1, 기본 `0.1`) 에 따라 샘플링된다. 트레이스 span 은 모델 토큰/비용 요약,
도구 입출력 크기, 로컬 subagent 트레이스 링크, 그리고 첫 토큰 이전 준비 단계(`prepare`)가
무엇을 들고 돌아왔는지 — 개수들과, discovery 가 그 요청에 더한 케이퍼빌리티 이름 최대 20개 —
를 담는다. 원본 프롬프트와 도구 결과는 저장되지
않는다. 각 트레이스는 `actor` — 그 런을 일으킨 사람 — 도 싣고, subagent 의 트레이스는 자기에게
닿은 top-level 런의 actor 를 싣는다. 그 transfer 는 두 번째 사람의 결정이 아니었기 때문이다.
대화 안에 있던 런의 트레이스는 그 런의 대화 키인 `conversation` 을 싣는다 (`chat:{id}`,
`slack:{channel}:{thread}`, …). 상관 분석을 위해 기록될 뿐 아직 인덱싱되거나 필터할 수 있는 것은
아니다.

## Models

`GET /api/models` → `{ "models": [ { id, provider, displayName, pricing, capabilities, … } ] }`
(`src/domain/llm/models.ts` 의 레지스트리이고, 숨김 항목은 제외한다). 프로바이더별 LLM 채널이
설정돼 있으면 (설정 오버라이드 또는 `LLM_PROVIDER_*` env) 그 프로바이더들의 모델만 나열되고,
아무것도 설정돼 있지 않으면 모든 모델이 나열된다. 그다음 `enabledModels` 설정 오버라이드 (콘솔의
`/models` 페이지에서 관리한다) 가 목록을 그것이 지목하는 id 들로 좁힌다. enabled 는 선택 시점의
필터일 뿐이다: 이미 비활성 모델을 쥐고 있는 version 은 계속 실행된다.

```
GET  /api/models/catalog → 200 { providers: [ { name, available, dedicated } ],
                                 models: [ { …model, enabled } ],
                                 makers: { <makerId>: label },
                                 updatedAt,
                                 source: "override" | "default" }
POST /api/models/test    → 200 { ok, latencyMs, error? } | 400
POST /api/models/refresh → 200 { refreshed, updatedAt }
GET  /api/models/selfhosted → 200 { served: [ { name, contextWindow?, vision? } ] | null,
                                    servedError?,
                                    declarations: [ <selfHostedModel> ],
                                    installed: [ <id> ] } | 400
```

- `catalog` 는 `member` 등급부터 읽을 수 있고 (`withMemberAuth` — Intelligence 섹션의 다른
  레지스트리들과 같은 계단이다: 이 배포가 닿을 수 있는 것의 목록이다), `test`·`refresh`·
  `selfhosted` 는 admin 전용이다.
  `makers` 와 `updatedAt` 은 로드된 카탈로그의 것이다 — maker 라벨과 카탈로그 내용이 마지막으로
  바뀐 시각으로, 레지스트리가 런타임 로드로 바뀐 뒤 클라이언트가 상수에서 가져올 수 없게 된
  값들이다. `catalog` 는 `/models` 뒤의 걸러지지 않은 그림이다: 보이는 모든 모델과 그 enabled 플래그
  (`/api/models` 가 숨기는 것을 정확히 나열한다 — member 는 꺼진 모델을 볼 수는 있어도 고를 수는
  없다), 그리고 프로바이더별로 이 배포가 거기로 dispatch 할 수 있는지다 — `dedicated` 는
  프로바이더별 채널이 설정돼 있다는 뜻이다. 하나도 없으면 모든 프로바이더가 기본 채널을 통해
  `available` 이다. 선택을 바꾸는 것(`PUT /api/settings` 의 `enabledModels`)은 admin 의 일로 남는다.
- `test` 는 진짜 채널로 아주 작은 completion 하나를 보낸다 (`maxTokens` 16, 15초 타임아웃) —
  프로바이더 해석, base URL, API 키, wire-id 치환까지 포함해서다. 실패한 프로브는 `5xx` 가 아니라
  `200` 본문이다 (`ok: false` 와 상류 에러). 레지스트리에 없는 id 만 `400` 이다. 프로브는 런
  브래킷 밖에서 돌아가므로 사용량 행을 기록하지 않는다.
- `refresh` 는 발행된 카탈로그를 시간별 틱을 기다리지 않고 지금 당겨온다 — agent-models 가 방금
  발행한 것을 콘솔에서 바로 보기 위한 것이다. `refreshed: false` 는 "이미 최신"과 "가져오기 실패"
  둘 다를 덮는다 (이유는 서버 로그에 있고, 어느 쪽이든 레지스트리는 그대로다). `test` 처럼
  설치한 것이 없는 갱신은 실패가 아니라 결과라서 `5xx` 를 돌려주지 않는다.
- `selfhosted` 는 `/models` 콘솔 Self-hosted 섹션의 전체 그림이다: **저장된** 선언
  (`declarations` — 편집의 기준이다: 레지스트리가 설치를 거부한 선언도 여기 보여야 다음
  full-replace 저장이 그것을 조용히 지우지 않는다), 그중 설치된 id(`installed`), 그리고
  채널이 *지금* 서빙하는 목록(`served` — 채널의 `/v1/models` 를 채널의 자격증명으로 읽고,
  LM Studio 네이티브 카탈로그가 있으면 컨텍스트 길이·vision 을 보강하며 임베딩 모델을
  걸러낸다). `served` 는 best-effort 다 — 채널이 답하지 않으면 뷰를 실패시키는 대신
  `servedError` 로 실린다: 서빙 스택이 죽어 있어도 선언은 admin 이 편집할 수 있어야 한다.
  채널이 아예 설정돼 있지 않으면 `400`. 선언 자체는 `PUT /api/settings` 의
  `selfHostedModels` 로 한다.

## A2A (인바운드)

`A2A_API_KEY` 로 켜지거나, 공유 키가 아예 없어도 이름 붙은 클라이언트 키가 하나 이상 있으면
켜진다. 그러면 publish 된 version 을 가진 각 project 가 공개 Agent Card 와 JSON-RPC 엔드포인트를
서빙한다.

```
GET  /api/a2a                                           (session) → { enabled, projects }
GET  /api/a2a/{project}/.well-known/agent-card.json     (public)
POST /api/a2a/{project}     X-A2A-Key: <key>            (A2A 1.0 JSON-RPC: SendMessage,
                            A2A-Version: 1.0             SendStreamingMessage, GetTask,
                                                         CancelTask, ResubscribeTask, ListTasks)
```

`GET /api/a2a` 는 A2A 로 노출된 publish 된 project 들을 나열한다: `enabled` 는 그 표면이 켜져
있는지를 알려 주고 — 공유 `A2A_API_KEY` 또는 이름 붙은 클라이언트 키 하나 이상 — 각 project
항목은 `{ name, displayName, description, cardUrl }` 을 싣는다.

`503` (설정되지 않음) 은 표면이 완전히 꺼져 있을 때만 답한다: 공유 키도 없고 **그리고** 클라이언트
키도 없을 때다. 켜져 있는 표면에서 키가 틀리거나 없으면 `401` 이다 — 공유 키는 상수 시간으로
비교하고, 클라이언트 키는 해시로 해석한다. 그 401 은 `WWW-Authenticate: ApiKey realm="a2a",
header="X-A2A-Key"` 를 싣고, Agent Card 는 같은 스킴을
`securitySchemes`/`securityRequirements` 로 선언한다 — 표준 클라이언트가 이 요구사항을 읽어
자격 증명을 고른다.

메시지는 A2A 1.0 `Part` 의 `text`, 또는 `image/*` 인 `raw`/https `url` 을 실을 수 있다. 단 image
project 는 편집 원본을 바이트로 받아야 하므로 `raw` 만 받는다. `data`, 다른 media type, 지원하지
않는 URL part 는 `ContentTypeNotSupported` (`-32005`) 로 거절된다. `taskId` 로 아직 working 인 task 를 이어 가는
메시지는 `-32602` 로 거절된다: 이 agent 는 메시지마다 자기 task 를 돌리고 `input-required` 에
들어가지 않으므로, 대화를 잇는 것은 `contextId` 다. `SendStreamingMessage` 와 `ResubscribeTask` 가
첫 이벤트 전에 거절되면 JSON-RPC 에러 객체(200)로 답하고, 스트림 도중의 실패는 JSON-RPC 에러
프레임이다. `ResubscribeTask` 는 저장된 task 를 따라간다 — 스냅샷, 그 뒤 도착하는 artifact,
종단 status — 런을 돌리는 인스턴스가 달라도 동작한다. `result` artifact 의 마지막 조각은
비어 있지 않은 실제 artifact 이고 `lastChunk: true` 다. A2A 1.0은 빈 Artifact 를 허용하지 않는다.

제시된 키는 공유 `A2A_API_KEY` (런은 `a2a:shared-key` 에 귀속) 이거나 **이름 붙은 클라이언트
키** (`asc_…`, 런은 `a2a:{client}` 에 귀속 — 클라이언트별 귀속과 동시성 한도) 일 수 있다.
클라이언트 키는 admin 이 관리한다:

```
GET    /api/settings/a2a-keys                  (admin) → { items: [{ name, description?, masked, createdAt }] }
POST   /api/settings/a2a-keys                  (admin) { name, description? } → { key, view }   key shown once
DELETE /api/settings/a2a-keys/{name}           (admin) → { ok: true } | 404                     revoke
POST   /api/settings/a2a-keys/{name}/reveal    (admin) → { key, createdAt }                     audited
```

클라이언트 키의 `name` 은 최대 64자의 slug 이고 `shared-key` 는 앱 전역 키를 위해 예약돼 있다.
각각 어기면 `400` 이다. 이미 발급된 이름은 `409` 다.

Agent Card URL 은 `PUBLIC_BASE_URL` 로 만들어진다. Task 상태(`SendMessage` →
`GetTask`/`CancelTask`/`ListTasks`)는 project·tenant·인증된 client 별로 DynamoDB 에 격리되어
저장되므로 재배포를 넘어 살아남고 인스턴스 간에 공유된다. 종단 상태를 지키는 조건부 쓰기가,
동시에 일어난 complete/cancel 이 끝난 task 를 되돌리는 것을 막는다. 행은
TTL(`A2A_TASK_RETENTION_DAYS`, 기본 1일)로 만료된다. `ListTasks` 는 status timestamp 내림차순이고
같은 timestamp 에서는 task id 로 순서를 고정하며, opaque cursor 를 써서 페이지 사이에 새 task 가
생겨도 앞 페이지의 항목이 중복되지 않는다.

## AG-UI (인바운드)

사용자를 마주하는 앱이 published 된 project 를 임베드하는 표면
([design/agui.md](design/agui.md)). 설정할 것은 없다 — published version 이 있는 모든
project 가 답한다.

```
POST /api/agui/{project}    Authorization: Bearer <project token>  (또는 session)
                            body: RunAgentInput
                            → 200 text/event-stream  (AG-UI 이벤트, data: 프레임 하나에 하나, [DONE] 없음)
                            | 400 (본문 형태, 모델에 넘길 수 없는 content part, 프로바이더가 거절할 tool 이름, 너무 긴 threadId)
                            | 401 | 404 (project 없음 또는 published version 없음) | 429 (Retry-After)
```

요청은 프로토콜의 `RunAgentInput` 이다: `threadId`, `runId`, `parentRunId?`, `messages` (비어
있어도 된다 — `developer` / `system` / `user` / `assistant` / `tool`; `reasoning` 은 뒤따르는
assistant 턴의 `reasoning_content` 가 되고, `activity` 는 받되 버린다), `tools`
(`{ name, description, parameters? }`), `context` (`{ description, value }`), `state` (비어 있지
않으면 읽기 전용 JSON 으로 context 와 함께 system 턴에 실린다 — 갱신은 되지 않고
`STATE_SNAPSHOT` 도 나가지 않는다), 그리고 받아만 두는 `forwardedProps`. `user` 턴의 parts 는
`text`, `image` (`data` 소스 또는 https `url` 소스, 메시지당 `MAX_ATTACHMENTS` 개), `document`
(`data` 소스만, `metadata.name`/`filename` 이 이름, 메시지당 `MAX_DOCUMENTS` 개 — chat 첨부와
같은 추출기로 텍스트가 된다) 이고, audio·video 와 URL 로 온 document 는 400 이다.
interrupt 상태를 이어 가는 구현은 아직 없으므로 `resume` 이 있으면 400 이다. 값을 무시하고 새
런으로 실행하지 않는다.

응답 스트림: `RUN_STARTED` → (`TEXT_MESSAGE_*` | `REASONING_*` | `TOOL_CALL_START/ARGS/END` +
`TOOL_CALL_RESULT` | `STEP_STARTED/FINISHED` | `ACTIVITY_SNAPSHOT` | `CUSTOM`)* → `RUN_FINISHED`
또는 `RUN_ERROR`. 한 턴의 모든 `TOOL_CALL_START` 는 그 턴의 assistant 메시지 id 를
`parentMessageId` 로 싣는다(턴이 말을 하지 않았어도). `RUN_FINISHED` 는
`outcome: { type: "success" }`, `result: { termination, warnings }` (`termination` 은 `completed` /
`turn-limit` / `output-limit`), `usage: [{ inputTokens, outputTokens, totalTokens,
reasoningTokens?, cachedInputTokens? }]` 를 싣는다. usage 는 fallback·subagent 를 포함한 모든
모델 호출의 합계이고, 청크가 실제 모델을 밝히지 않으므로 잘못 귀속하지 않도록 `model` 을 붙이지
않는다. `RUN_ERROR` 의 `code` 는 타입이 있는 실패의
클래스명(`RateLimitedError`, `UpstreamError` 등)이다. 런이 만든 그림과 파일은
`ACTIVITY_SNAPSHOT` — `activityType` 이 `agent-studio.image` (`content: { mimeType, dataUrl,
prompt?, model?, artifactId? }`) 또는 `agent-studio.file` (`content: { name, mimeType, url,
byteSize? }` — 15분 서명 URL) — 로 스레드의 메시지가 되고, 클라이언트가 다음 런 입력에서
제거하므로 바이트는 모델로 돌아가지 않는다. `CUSTOM` 은 `agent-studio.warning` (`{ message }`)
하나다.

토큰은 서버 자격 증명이다 — 브라우저가 아니라 자체 서버(CopilotKit runtime 등)에서 호출한다;
엔드포인트는 CORS 헤더를 보내지 않는다.

`threadId` 는 런의 conversation(`agui:{caller}:{threadId}`)이다 — 한 스레드의 모든 런에 같은
값을 보낸다. `tools` 는 agent project 에 제공되고 클라이언트가 실행한다: 하나를 부른 턴이 런의
마지막이고, 결과는 다음 런의 `messages` 에 `tool` 메시지로 돌아온다. 다른 타입의 project 에
선언된 tool 은 `agent-studio.warning` 으로 보고된다.

## 플랫폼 엔드포인트

```
GET /api/health   → 200 (static)
GET /api/ready    → 200 { ready: true, checks: { db, llm } }
                  | 503 { ready: false, draining: true }          (after SIGTERM)
                  | 503 { ready: false, checks: { db, llm } }     ("ok" | "unreachable" each)
GET /api/metrics  → 200 text/plain; version=0.0.4
```

`/api/health` 는 liveness 다 — "프로세스가 서빙하고 있는가"에 답하는 정적 200 이고, 의존성이
없어서 하류의 순간적인 문제가 재시작을 유발하지 않는다. `/api/ready` 는 readiness 다 — DynamoDB 와
LLM 채널을 찔러 보고 (짧은 타임아웃, 상세는 드러내지 않는다), 하류에 닿을 수 없거나 인스턴스가
SIGTERM 이후 draining 중이면 503 을 돌려준다.

`/api/metrics` 는 Prometheus scrape 이고 `agent_studio_active_runs`,
`agent_studio_oldest_active_run_seconds`, `agent_studio_build_info`,
`agent_studio_runs_{started,finished,failed}_total`, `agent_studio_run_duration_seconds`,
`agent_studio_unknown_model_calls_total`, `agent_studio_unknown_models`,
`agent_studio_draining` 과 Node.js process CPU·메모리·event loop 지표를 노출한다. 어떤 지표에도
project·사용자·모델 라벨은 붙지 않는다. build 정보만 값의 범위가 제한된 `version`·`stage`
라벨을 지닌다.

셋 다 일부러 비인증이고 의존성이 가볍다 — 세션이 없는 인프라가 이것들을 찔러 보기 때문이다.
연결하는 방법은 [OPERATIONS.md](OPERATIONS.md#헬스-프로브) 를 보라.

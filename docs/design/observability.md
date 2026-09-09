# 런이 남기는 기록

읽는 사람이 서로 다른 세 개의 원장(ledger) — 민감한 행위에 대한 audit 행, 무엇을 누가
썼는지에 대한 usage 행, 그리고 한 런이 어떻게 흘러갔는지에 대한 trace.

보존 기간, 샘플링, 그리고 누가 trace 를 읽을 수 있는지는
[OPERATIONS.md](../OPERATIONS.md#행-보존) 다. trace 가 의도적으로 저장하지 *않는*
것은 [SECURITY.md](../SECURITY.md#데이터-노출과-보존) 다.

## Audit 기록

민감한 행위는 로그 한 줄만이 아니라 행(row)을 남기고, 둘을 나란히 두는 이유는 서로 다른
독자에게 답하기 때문이다. 로그 한 줄은 이미 스트림을 지켜보고 있는 사람에게 닿고, 그것을
실어 나르는 것이 무엇이든 그쪽 정책대로 보존되며, "지난 분기에 admin 목록을 누가 바꿨나"에는
답하지 못한다. audit 행은 정확히 그 질문에 답하고 그 외에는 답하지 않는다.

```ts
AuditEvent { eventId, actorEmail,
             action: 'secret.reveal' | 'secret.rotate' | 'secret.revoke'
                   | 'project.admin-override' | 'settings.update'
                   | 'project.delete' | 'registry.delete' | 'registry.adopt'
                   | 'artifact.delete' | 'member.set-tier',
             target,        // `kind:name` — `project:my-bot`, `skill:pdf-reader`
             detail?, createdAt }
```

**작성자는 하나**, `recordAudit` (`src/application/audit/recordAudit.ts`) 이며
`tests/architecture.test.ts` 가 고정한다. 기록되는 모든 행위가 이곳을 지난다. 두 번째
작성자가 생기면 `target` 을 제 나름대로 적을 것이고, reveal 에는 통하던 필터가 deletion 에는
조용히 아무것도 돌려주지 않는다 — 어긋난 audit trail 의 전형적인 실패다. 버그가 아니라
이벤트가 없는 것처럼 보이기 때문이다. 저장소는 `setAdminCheck` 와 같은 이유로 composition
root 가 **밀어 넣는다**: 그것을 넘겨야 하는 호출 지점은 잊을 수 있고, 기록되지 않은 행위
하나는 애초에 일어나지 않은 행위와 구별되지 않는다. `src/instrumentation.ts` 는 composition
root 자신의 import 에 맡기지 않고 **await 되는** 부팅 경로에서 이를 연결한다: 기록하는 모든
라우트가 컨테이너에서 무언가를 필요로 하지는 않고 — A2A 키 reveal 은 아무것도 필요로 하지
않는다 — 그 떠 있는(floating) import 가 resolve 되기 전에 처리된 요청은 자격 증명을 노출하고
아무것도 기록하지 않는다. sink 는 `Symbol.for` 로 이름 붙인 process-wide 슬롯에 있으므로 Next 가
instrumentation 과 route module 을 서로 다른 server bundle 에서 평가해도 같은 저장소를 본다.
project admin 판정 함수도 같은 이유로 process-wide 슬롯을 쓴다.

**쓰기 실패는 로그로 남기고 throw 하지 않는다.** 행위는 이미 일어났다. 뒤늦게 거부하면
저장소의 순간적인 장애가 모든 민감 작업이 한꺼번에 멈추는 장애로 바뀐다. 각 지점에 원래 있던
`log.warn` 줄들은 바로 이 경우를 위해 의도적으로 남겨 뒀다 — audit 저장소 자체가 고장 났을 때
남는 것이 그것이다.

`action` 은 닫힌 집합이라 읽는 쪽이 텍스트 검색이 아니라 필터가 되고, 새로운 종류의 행위를
기록하는 일이 의도적인 편집이 된다. `detail` 은 자격 증명을 절대 담지 않는다: settings 쓰기는
*어떤* 키가 움직였는지를 기록하고 그 값은 절대 기록하지 않으며, 그 키 중 둘은 secret 이다.

행은 그 일이 일어난 **UTC 일자**로 키가 매겨지고 하루씩 읽는다. usage 가 이미 쓰고 있는
모양이며 — 한 배포의 전체 이력이 한 파티션에 계속 덧붙는 것을 막아 준다. 앱 안의 어떤 것도
행을 갱신하거나 삭제하지 않는다. 만료는 `expiresAt` 과 틱의 sweep 이 맡는다. 그 대상이 고칠 수 있는 기록은
기록이 아니고, *삭제된* project 의 소유자에게도 여전히 책임을 물을 수 있게 하는 것이 바로 이
점이다 — 그 사실을 알고 있던 다른 행은 cascade 가 전부 가져가기 때문이다.

## 사용량과 비용 귀속

project 별·model 별 일일 집계다 ([키 맵](../ARCHITECTURE.md#postgresql-아이템-테이블-설계)
참고). 대시보드는 범위에 걸쳐 `USAGEDATE#{date}` GSI 파티션을 읽고 클라이언트 쪽에서
project / provider / model 로 다시 묶는다.

**프롬프트에서 캐시된 비중은 지표 중 하나이고**, 청구서에서 유추하는 값이 아니다.
`calculateCost` 는 입력 가격을 매기려고 늘 `prompt_tokens_details.cached_tokens` 를 읽었고,
그다음 그 수치를 버렸다 — 그래서 캐시가 되지 않게 된 프롬프트는 턴마다 비용이 더 들었는데도
호출 수·토큰·답변은 전과 똑같아 보였다. 이제 그 값은 `UsageInfo` 를 타고(따라서 `usage`
chunk 에도) 일일 행에 `cachedTokens.{model}` 로 들어가고, trace 의 각 model span 에도 실린다.
거기서는 캐시 퇴행이 턴 단위로 읽힌다: 런의 첫 턴은 정의상 cold 이고, 캐시가 깨졌다는 것은
이후의 모든 턴도 cold 라는 뜻이다. 분해 표는 아무것도 보고하지 않은 자리에 **빈 칸**을 그린다
— `0%` 는 그 필드를 아예 보고하지 않는 channel 에 대해 캐시가 cold 라고 주장하는 셈이 된다.

**누가 썼는지는 두 번째 행이지, 첫 행에 붙는 또 하나의 차원이 아니다.** Project 는 공유
카탈로그이고, 공개 project 는 로그인한 누구나 실행하며 private project 도 여러 멤버가 함께
실행할 수 있다. 그래서 project 이름은 지출한 주체를 식별하지 못한다. `RunActor { kind, id }`
(`src/domain/execution/actor.ts`) 가 그 주체를 지목한다:

| Kind | Id | 이유 |
|---|---|---|
| `user` | 이메일 | — |
| `project-token` | **소유자의** 이메일 | 토큰은 그 사람으로 인증한다. 기계의 지출을 그 사람 자신의 런과 떼어 놓는 것은 *kind* 이며 — `user` 행만 채우는 그 사람의 개인 tier 예산에서도 빼 놓는다 |
| `slack` | Slack user id | Slack 은 이메일을 넘겨주지 않고, 매핑을 추측하면 엉뚱한 사람에게 비용을 물린다 |
| `telegram` | Telegram user id | 같은 이유다. Telegram 은 이름과 username 을 넘겨주는데 둘 다 주소가 아니다 |
| `teams` | 보낸 사람의 Entra(Azure AD) object id | 대화마다 달라지는 `from.id` 와 달리 사람을 가로질러 같다. Teams 는 봇에게 email 을 주지 않는다 |
| `a2a` | 상수 `shared-key`, 또는 client key 의 이름 | 공유 키는 아무도 지목하지 못한다. 이름 붙은 client key 는 그 보유자를 지목하므로, 그쪽 런은 client 단위로 귀속되고 한도가 매겨진다 |
| `webhook` | `{project}:{triggerId}` | — |
| `schedule` | `{project}:{triggerId}` | — |

별도의 `ACTOR#{date}#{actor}` 행으로 나눈 것은 의도적이다. `UsageRow` 는 지표마다 model 로
키가 매겨진 맵을 갖는다. 그것을 대신 `actor|model` 로 키를 매기면 서로 다른 호출자 수만큼
행 하나가 커지고, 그 행은 모델 호출마다 행 잠금 아래에서 통째로 다시 쓰인다 — 그러면서
언제나 project 합계만 묻는 대시보드는 매 요청마다 모든 호출자를 읽는 비용을 치른다. 같은
파티션의 별도 행은 두 읽기 모두를 각자의 질문만큼만 넓게 유지하고, project cascade 는 이미
파티션 전체를 삭제한다.

project 합계는 **먼저, 무조건** 쓰고 actor 행이 뒤따른다. 귀속은 덧붙는 것이다 — 호출자를
지목하지 못하는 경로도 자기가 유발한 지출은 그대로 기록한다.

**actor 는 런의 것이지 턴의 것이 아니다.** `createUsageAggregator` 는 그것과 한 번 묶이므로,
subagent transfer 가 다른 project 에서 하는 호출도 여전히 런을 시작한 사람에게 귀속된다.
`RunOrigin { actor?, userEmail?, caller?, conversation?, ancestry }` 가 모든 transfer hop 을 따라
이들을 내려보낸다 — `caller` 는 caller context 를 켠 version 을 위해 actor 가 *말로* 누구인지를 담는
값이다. subagent 는 부모와 같은 사람에게 답하고 같은 사람에게 비용을 물리므로, 값들은 여덟
개의 시그니처를 나란히 꿰고 지나가는 파라미터가 아니라 언제나 하나로 함께 이동한다.

**`conversation` 은 런이 어느 스레드에 있는지다.** `RunConversation { surface, id }` 이고,
`conversationKey` 가 하나의 키로 표기한다 (`src/domain/execution/actor.ts` — 이 파일은
`conversationOf` 도 소유한다. 외부 id 가 헤더와 저장 키를 위해 정규화되는 유일한 자리다).
표면마다 자기 빌더와 자기 표기법을 갖고, firing 에는 없다:

| 표면 | Key | 만드는 곳 |
|---|---|---|
| chat | `chat:{chatId}` | `chatConversation` (`src/domain/chat/conversation.ts`) |
| Slack | `slack:{channel}:{threadTs}` — 루트 메시지를 포함한 그 스레드 | `slackConversation` (`src/domain/slack/conversation.ts`) |
| Telegram | `telegram:{chatId}` 또는 `telegram:{chatId}:{threadId}` — 개인·그룹 chat 과 선택적인 topic | `telegramConversation` (`src/domain/telegram/conversation.ts`) |
| Teams | `teams:{conversationId}` | `teamsConversation` (`src/domain/teams/conversation.ts`) |
| inbound A2A | `a2a:{clientActorId}:{contextId}` — 호출자 아래에 놓인, 호출자의 묶음 | `a2aConversation` (`src/domain/a2a/conversation.ts`) |
| AG-UI | `agui:{callerDigest}:{threadId}` | `aguiConversation` (`src/app/api/projects/_lib/conversation.ts`) |
| `predict` / `chat/completions` / `agent` | `api:{callerDigest}:{X-Conversation-Id}` — opt-in 이며, 이메일을 담지 않고 호출자 범위로 한정된다 | `requestConversation` (`src/app/api/projects/_lib/conversation.ts`) |
| webhook / schedule | — | firing 은 후속 질문을 받지 않으므로, 한 번짜리 대화조차 아니다 |

런 중에 이것을 읽는 소비자는 둘이다: 첫 질문이 연 원격 대화를 이어 가는 outbound A2A transfer
([A2A](agents-a2a.md#a2a)), 그리고 상태를 갖는 서버에 어느 대화가 묻고 있는지 알려 주는 MCP
헤더 ([MCP](mcp.md)). actor(한 사람은 여러 대화에 있다)도 ancestry(턴의 사슬이 아니라 project
의 사슬이다)도 이것을 대신할 수 없고, 그래서 자기 필드로 존재한다. 런 바깥에서는 trace 도 이
키를 기록한다
— trace 하나를 읽을 때 상관 짓기 위해서다. 아직 이것으로 인덱싱하거나 필터링하는 것은 없으니,
"이 스레드의 모든 런"은 오늘 무엇도 답해 주지 못하는 질의다.

`conversationOf` 는 **치환하지 않고 인코딩한다**: 공백, 제어 문자, 출력 가능한 ASCII 를
벗어나는 모든 것, 그리고 `%` 자신이 자기 UTF-8 바이트에 대해 `%XX` 가 된다. 그래서 UUID 든
Slack 주소든 그대로 다시 읽히고, 서로 다른 두 외부 id — A2A `contextId`, 호출자의 헤더 — 가
하나의 대화가 되는 일이 없다. 그것들을 placeholder 로 치환하는 것이 첫 버전이었고, 그 방식은
모든 한국어 단어를 밑줄 두 개로 만들었다: 대화는 둘, 메모리는 하나. 인코딩된 512자를 넘으면
같은 이유로 짧아진 대화가 아니라 대화가 아예 없다. API 표면은 그에 대해 400 을 답하는데,
대화를 선언해 놓고 조용히 대화 없이 실행된 호출자는 그 사실을 알 방법이 없기 때문이다.

## Trace

```ts
Trace     { traceId, projectName, versionName, projectType, actor?, ancestry?, conversation?,
            status: 'completed' | 'turn-limit' | 'output-limit' | 'failed' | 'cancelled',
            spans: TraceSpan[], spansDropped?, warnings?,
            startedAt, endedAt, durationMs, error?, createdAt }
TraceSpan { spanId, kind: 'model' | 'tool' | 'subagent' | 'prepare', name, author?,
            startedAt, endedAt, durationMs, status: 'ok' | 'error', input?, output? }
```

Agent 런은 model/tool/subagent span 을 언제나 저장하고, agent 가 아닌 런과 이미지 predict
런은 샘플링된다. span 은 한도가 정해진 메타데이터만 담는다 — 문자 수, 토큰, 비용, 소요 시간,
subagent trace id. **원문 프롬프트와 tool 결과는 저장하지 않는다.** 보존 기간, 샘플링, 누가
trace 를 읽을 수 있는지는 [OPERATIONS.md](../OPERATIONS.md#트레이싱) 에 있다.

턴 한도와 모델 출력 한도로 끝난 런은 각각 `turn-limit`, `output-limit`로 기록한다.
하위 Agent의 한도 종료는 메인 Trace 상태를 바꾸지 않으며, 오류와 취소가 한도 상태보다 우선한다.

**첫 토큰 이전의 준비 작업은 `prepare` span 이다.** 런이 모델을 부르기 전에 memory recall을 먼저
수행하고, 그다음 version의 도구를 resolve한다. 후자는 바인딩된 MCP 서버를 열고 도구를 나열하며,
discovery를 켠 version은 원래 요청과 관련 기억으로 카탈로그까지 검색한다. 둘 다 네트워크 작업이고
느려질 수 있다.
recorder 는 resolve 보다 먼저 만들어지므로(그래야 resolve 가 던져도 trace 가 남는다) 그 시간이
**첫 model span 안에 들어가 있었다**: MCP 서버 하나가 8초를 잡아먹은 런이 8초짜리 모델로
읽혔고, "왜 첫 토큰이 늦었나" 는 페이지 어디에도 답이 없었다. 이제 각 단계가 자기 span 을
갖고 실행 순서대로 `memory`와 `tools`에 기록되며, 그 끝이 다음 model span 의 시작이다. `output` 은 그 단계가 무엇을
가지고 돌아왔는지다 — skill·subagent·MCP 서버·도구 수, 잃은 것의 수, 그리고 discovery 가
무엇을 더했는지는 **이름으로**(최대 20개, 그 옆의 수는 찾은 총 개수라 목록보다 크면 그만큼이
안 보이는 것이다). 런의 계획 중
요청마다 달라지는 것은 그 목록뿐이라, 이름이 없으면 "왜 저 도구를 불렀나" 는 사후에 답할 수
없다. Rerank를 사용한 tools 단계는 호출 수, 후보 수, 모델, input token, 비용과 vector fallback
수를 함께 기록한다. 원문 query와 capability description은 기록하지 않는다.
단계가 실패해도 런은 실패가 아니다(memory 가 답하지 않아도 런은 기억 없이 계속한다): span 이
`error` 이고 trace 는 그대로다. **무엇이 `error` 인지는 경고 수가 아니라 실제로 물어본 서버가
답하지 않았는지다** — 회상할 서버가 아예 없는 version 은 자기가 하는 모든 런에서 경고하므로,
그것을 실패로 세면 잘못 설정된 version 의 trace 는 전부 빨갛게 된다.

**trace 는 사용자가 보는 것과 같은 chunk 로 조립된다.** `TraceRecorder`
(`src/application/trace/recorder.ts`) 는 루프 곳곳에 흩어진 계측 지점에서 호출되는 대신
`EngineChunk` 스트림을 관찰한다. 그래서 새 tool 이나 builtin 은 아무것도 그것을 기억하지
않아도 trace 에 남는다. 종료는 `runTermination` 을 통해 읽으며, 그것이 자식의 turn limit 이
부모의 trace 에 찍히는 것을 막아 준다.

**`turn-limit` 은 그 자체로 하나의 상태다.** 상한에 도달한 런은 끝난 런이 아니기 때문이다.
이것을 `completed` 로 기록하면 정작 조사할 가치가 있는 그 한 건이 trace 페이지에서 정상으로
읽혔다 — 마지막 턴이 침묵하는 대신 마무리를 짓게 된 지금도 그대로다: 답은 존재하지만, 예산을
다 쓴 채로 그리고 계획이 여전히 쓰고 있던 tool 없이 쓰인 답이다.

**transfer 하나는 어느 깊이까지 갔든 span 하나다.** subagent 항목은 `transferId` 로 구분해
trace 샘플링 여부와 독립적으로 같은 agent 로의 두 transfer 를 두 span 으로 남긴다.
더 깊은 hop 은 그것을 시작한 직계 자식의 transfer 로 합쳐진다. 그러면 사슬은 양방향으로 읽힌다: `ancestry` 로는 위로
top-level 런까지, span 의 subagent trace id 로는 아래로 자식 자신의 trace 까지.

**모든 누적기에는 한도가 있다.** trace 가 행 하나로 쓰이고 행 하나로 읽히기 때문이다 —
상세 페이지는 통째로 받고, 목록은 상위 N 개를 통째로 받는다: span 100 개,
나머지는 사라지는 대신 `spansDropped` 에 세어진다. warning 20 개. 그리고 error 나 warning
문자열 하나당 1,000자.

# 런이 남기는 기록

읽는 사람이 서로 다른 세 개의 원장(ledger) — 민감한 행위에 대한 audit 행, 무엇을 누가
썼는지에 대한 usage 행, 그리고 한 런이 어떻게 흘러갔는지에 대한 trace.

보존 기간과 누가 trace 를 읽을 수 있는지는
[OPERATIONS.md](../OPERATIONS.md#행-보존) 다. trace 가 의도적으로 저장하지 *않는*
것은 [SECURITY.md](../SECURITY.md#데이터-노출과-보존) 다.

## Audit 기록

`recordAudit`는 민감 작업의 행위자·action·target·시각과 제한된 detail을 기록한다.
action의 닫힌 집합은 `domain/audit/types.ts`, HTTP 필드와 조회 범위는
[Audit API](../API.md#감사-기록)가 정본이다. detail에는 바뀐 설정 key 등만 기록하고 credential을 넣지 않는다.

`instrumentation.ts`는 요청 수신 전에 감사 sink를 연결하고 확인한다.
`Symbol.for` process 슬롯을 사용해 서로 다른 Next server bundle도 같은 sink를 읽는다.
직접 container를 조립하는 CLI도 같은 설정을 사용한다.

감사 쓰기 실패는 로그로 보고하고 이미 수행한 작업을 실패로 바꾸지 않는다.
따라서 Audit은 모든 외부효과와 원자적으로 commit되는 원장이 아니다.
행은 UTC 일자별로 저장하고, 사용자 API로 갱신·삭제하지 않으며 보존 sweep이 만료를 정리한다.
Agent 삭제가 그 행위의 감사 기록까지 cascade하지는 않는다.

## 사용량과 비용 귀속

agent 별·model 별 일일 집계다 ([키 맵](../ARCHITECTURE.md#postgresql-아이템-테이블-설계)
참고). 대시보드는 범위에 걸쳐 `USAGEDATE#{date}` GSI 파티션을 읽고 클라이언트 쪽에서
agent / provider / model 로 다시 묶는다.

지표는 모델별 `calls`, `inputTokens`, `outputTokens`, `cachedTokens`, `costUsd`다.
cached token은 입력 토큰의 부분집합이며 reasoning token은 출력 토큰의 부분집합이다.
reasoning 수치는 UsageInfo·Trace에 쓰고 일일 Usage의 독립 과금 축으로 저장하지 않는다.
채널이 보고하지 않은 값과 실제 0을 해석할 때는 해당 provider·저장 경로의 계약을 확인한다.
첫 호출이라고 항상 cache miss이거나 토큰 수만 같으면 같은 비용인 것은 아니다.

텍스트·결정·이미지·전사 모델과 Workspace native 모델은 호출마다 `modelDurationMs`를 측정한다.
공급자 요청 시작부터 최종 응답 수신까지 단조 시계로 경과 시간을 측정한다. 연결·첫 응답·네트워크와
스트림 소비 지연을 포함하고 모델 선택·자격 증명 조회·도구 실행·저장 시간은 제외한다.
소비자가 멈춘 동안에도 공급자가 생성할 수 있으므로 그 시간을 빼서 속도를 높이지 않는다.
이는 관측한 요청 처리량이며, 첫 토큰 뒤의 순수 디코딩 속도가 아니다.

일일 행은 측정된 호출의 `modelDurationMs`, `timedOutputTokens`, `timedCalls`를 함께 합산한다.
토큰/초는 `timedOutputTokens × 1000 / modelDurationMs`다. 호출별 속도의 단순 평균을 쓰지 않는다.
출력 토큰에는 공급자가 보고한 reasoning token이 포함된다. 과거 행·시간 미측정 호출·불완전한
native 응답은 성능 표본에 넣지 않으며 표본이 없으면 알 수 없음으로 표시한다.
텍스트 응답의 토큰 미보고를 SDK가 0으로 정규화하더라도 성능 표본에는 넣지 않는다.
이미지는 양수의 이미지 출력 토큰, 전사는 공급자가 명시한 출력 토큰이 있을 때만 표본에 넣는다.
토큰을 보고하지 않는 이미지·전사와 출력 토큰이 없는 rerank에는 처리량을 만들지 않는다.
출력 토큰 정의가 다른 모델 유형의 속도를 직접 비교하지 않는다.

### 콘솔에서 확인하기

| 화면 | 범위 |
|---|---|
| Overview, Agent → Usage | 현재 Agent의 총계. 모델·프로바이더별 비용·호출·토큰·처리량을 표에서 확인한다 |
| Profile | 로그인한 사용자의 개인 원장 |
| Models → Model usage | 현재 Agent에서 사용한 모델별 총계. 모델 목록의 Usage로 한 모델을 선택할 수 있다 |
| Usage (admin) | 현재 사용자 전체의 개인 원장. Members의 사용자 이름을 누르면 그 사용자로 필터링한다 |

Model usage와 Usage에서 기간·모델을 선택하고 비용·호출·입력 토큰·출력 토큰·출력
토큰/초의 일별 그래프를 전환한다. 관리자는 사용자 필터와 사용자·모델별 그룹도 선택한다.
표의 측정 호출은 `timedCalls / calls`이며 처리량의 표본 범위를 보여준다. 무료 모델은 비용이
0이어도 호출·토큰 그래프에서 확인할 수 있다. 처리량은 그룹끼리 더하지 않으며 Others도 토큰과
시간을 합친 뒤 계산한다. 차트는 상위 8개와 Others, 표는 페이지당 25개를 표시한다.

관리자 조회는 기존 사용자별 인덱스와 100개 단위 계정 페이지를 사용한다. 사용자 원장 조회를
동시에 8개로 제한하고 서버에서 여러 Agent를 사용자·UTC 일자별로 합쳐 응답한다. 사용자가 늘면
원장 조회 수도 늘며, 일부 조회 실패를 0이나 부분 합계로 숨기지 않는다. 삭제된 Agent의 개인
원장은 보존 기간까지 관리자·Profile 총계에 남아 현재 Agent 총계와 다를 수 있다.

### 사용자와 출처 귀속

**누가 썼는지는 두 번째 행이지, 첫 행에 붙는 또 하나의 차원이 아니다.** Agent 는 공유
카탈로그이고, 공개 agent 는 로그인한 누구나 실행하며 private agent 도 여러 멤버가 함께
실행할 수 있다. 그래서 agent 이름은 지출한 주체를 식별하지 못한다. `RunIdentity.user.userId`가 비용과 동시성의 주체이고 `RunActor { kind, id }`는 호출 출처다.
모든 출처는 인증된 Studio 계정을 필수로 운반한다:

| Kind | Id | 이유 |
|---|---|---|
| `user` | 이메일 | — |
| `agent-token` | 발급 사용자의 현재 이메일 | 개인 토큰의 사용자 ID로 인증하고 그 사용자의 개인 예산에 합산한다 |
| `slack` | Slack user id | Slack 은 이메일을 넘겨주지 않고, 매핑을 추측하면 엉뚱한 사람에게 비용을 물린다 |
| `telegram` | Telegram user id | 같은 이유다. Telegram 은 이름과 username 을 넘겨주는데 둘 다 주소가 아니다 |
| `teams` | `from.aadObjectId`, 없으면 `from.id` | Entra object ID를 우선한다. fallback ID는 대화별로 달라질 수 있으며 이메일로 해석하지 않는다 |
| `webhook` | `{agent}:{triggerId}` | — |
| `schedule` | `{agent}:{triggerId}` | — |

별도의 `ACTOR#{date}#{actor}#USER#{userId}` 행으로 나눈 것은 의도적이다. `UsageRow` 는 지표마다 model 로
키가 매겨진 맵을 갖는다. 그것을 대신 `actor|model` 로 키를 매기면 서로 다른 호출자 수만큼
행 하나가 커지고, 그 행은 모델 호출마다 행 잠금 아래에서 통째로 다시 쓰인다 — 그러면서
언제나 agent 합계만 묻는 대시보드는 매 요청마다 모든 호출자를 읽는 비용을 치른다. 같은
파티션의 별도 행은 두 읽기 모두를 각자의 질문만큼만 넓게 유지하고, agent cascade 는 이미
파티션 전체를 삭제한다.

Usage 기록은 Agent·출처별·사용자별 집계를 한 transaction으로 저장한다. 사용자 집계와 receipt는
`USAGEMEMBERID#{userId}`에 보관하며 Agent 삭제 중이나 삭제 뒤에도 이미 발생한 개인 비용은 남긴다.
`idempotencyKey`가 있는 ASR·Native 모델 사용량은 동일 receipt와 집계를 함께 저장하고 같은 결과의
재정산을 막는다. Gateway는 공급자 요청별 사용량을 먼저 영속화하고 worker가 미완료 정산을 복구한다.
일반 Agent aggregator는 종료 시 best-effort로 flush하며 급사 전 미정산량을 자동 복구하지 않는다.
사용량 누락은 무료로 해석하지 않는다. 비용 가드는 외부 청구서의 정확한 예약 장부가 아니다.

**actor 는 런의 것이지 턴의 것이 아니다.** `createUsageAggregator` 는 그것과 한 번 묶이므로,
subagent transfer 가 다른 agent 에서 하는 호출도 여전히 런을 시작한 사람에게 귀속된다.
`RunOrigin { user, actor, executionGrant?, userEmail?, caller?, conversation?, ancestry }` 가 모든 transfer hop 을 따라
이들을 내려보낸다 — `caller` 는 caller context를 켠 Agent를 위해 actor 가 *말로* 누구인지를 담는
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
| `predict` / `chat/completions` / `agent` | `api:{callerDigest}:{X-Conversation-Id}` — opt-in 이며, 이메일을 담지 않고 호출자 범위로 한정된다 | `requestConversation` (`src/app/api/agents/_lib/conversation.ts`) |
| webhook / schedule | — | firing 은 후속 질문을 받지 않으므로, 한 번짜리 대화조차 아니다 |

런은 [MCP](mcp.md) 헤더로 상태를 갖는 서버에 어느 대화가 묻고 있는지 알려 준다. actor(한 사람은 여러 대화에 있다)도 ancestry(턴의 사슬이 아니라 agent
의 사슬이다)도 이것을 대신할 수 없고, 그래서 자기 필드로 존재한다. 런 바깥에서는 trace 도 이
키를 기록한다
— trace 하나를 읽을 때 상관 짓기 위해서다. 아직 이것으로 인덱싱하거나 필터링하는 것은 없으니,
"이 스레드의 모든 런"은 오늘 무엇도 답해 주지 못하는 질의다.

`conversationOf`는 공백·제어 문자·ASCII 밖의 문자와 `%`를 UTF-8 percent encoding한다.
서로 다른 ID를 같은 placeholder로 만들지 않는다. 인코딩 상한을 넘으면 잘라 쓰지 않고 거절하거나
대화 없음으로 처리하며 API는 잘못된 대화 ID에 400으로 응답한다.

## Trace

Agent 런은 항상 기록한다. 앱 Trace는 준비 단계,
SDK native span과 최상위 종료 상태를 한정된 행으로 저장한다.

```ts
Trace { traceId, agentName, user?, actor?, ancestry?, conversation?,
        status: 'completed' | 'awaiting-approval' | 'turn-limit' | 'output-limit' | 'failed' | 'cancelled',
        spans, spansDropped?, warnings?, startedAt, endedAt, durationMs, error?, createdAt }
TraceSpan { spanId, parentSpanId?, kind: 'model' | 'tool' | 'subagent' | 'guardrail' | 'prepare',
            name, author?, startedAt, endedAt, durationMs, status: 'ok' | 'error', input?, output? }
```

`runtime/tracing.ts`는 SDK 기본 exporter를 로컬 processor로 교체한다. Agent, 모델 generation,
function tool, Handoff, MCP 도구 listing과 Guardrail의 native span ID·부모 ID를 보존한다.
동시 위임도 SDK가 만든 계층에 남으며 text 자식마다 별도의 앱 Trace를 만들지 않는다.
이미지 생성·편집도 호출한 이미지 모델의 generation span을 해당 function tool 아래에 남기며,
텍스트 모델과 같은 사용량 필드로 토큰·비용을 기록한다.

모델/도구 입력·출력과 credential은 SDK trace 수집에서 제외한다. 이름, SDK 종류/trace ID,
시간, 상태와 숫자형 사용량만 변환한다. 모델의 실제 비용과 cache/reasoning token을 보존한다.
`TraceRecorder`는 SDK span을 그대로 수집하며 청크에서 model/tool span이나 사용량을 재구성하지 않는다.

SDK 실행 전 `memory`와 `tools` 준비는 앱 `prepare` span이다. 바인딩·발견한 capability
개수와 최대 20개의 이름, 손실과 준비 오류를 기록하며 원문 query/description은 기록하지 않는다.
MCP 준비 실패가 기록되어도 실행이 계속된 경우 Trace 전체를 실패로 처리하지 않는다.

최상위 청크로 전체 종료를 판정하고 경고는 자식의 손실도 수집한다. 하위 Agent의 한도/실패가 부모의 완료를 덮지 않으며,
승인 대기는 `awaiting-approval`이다. 취소와 실패는 한도 상태보다 우선한다. 최대 span 100개,
warning 20개를 저장하고, 생략된 span은 `spansDropped`로 센다. 실행 경고/오류 문구는 최대
1,000자로 제한되며 원문 오류에 민감 정보가 있을 수 있어 Agent 소유자만 읽을 수 있다.

선택적인 OTLP exporter와 보존 설정은 [운영](../OPERATIONS.md#트레이싱)을 따른다.
기본 실행은 공개 OpenAI trace exporter나 외부 tracing 서비스에 의존하지 않는다.

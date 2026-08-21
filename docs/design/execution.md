# 실행

Project 가 무엇이고, Version 이 무엇을 선언하며, 하나가 실행될 때 무슨 일이 일어나는가: 도구
루프, 그림을 그리는 세 경로, 그리고 런이 남기는 것.

이것이 놓여 있는 형태 — 레이어, 진입점, 런 브래킷, `EngineChunk` 계약 — 는
[ARCHITECTURE.md](../ARCHITECTURE.md) 다. 여기서 이름 붙인 상한들은
[CONFIGURATION.md](../CONFIGURATION.md#코드에-고정된-제한) 에 고정돼 있다.

> **루프 자신의 불변식은 코드 옆에 있다.** `src/application/llm/AGENTS.md` 가 `engine.ts`,
> `agentAssembly.ts`, `toolResultBudget.ts`, `pii.ts` 를 고칠 때 무엇이 성립해야 하는지에 대한
> 정본이다. 이 파일은 루프가 왜 그런 모양인지를 말한다.

## Project / Version

```ts
Project { name (slug, immutable id), displayName, description,
          projectType: 'llm' | 'agent' | 'image', ownerEmail, departmentCode?,
          publishedVersion?, slack?, costLimits?, createdAt, updatedAt }

Version { projectName, versionName, systemPrompt, userPromptTemplate, model, fallbackModel?,
          parameters { temperature?, maxTokens?, reasoningEffort?, piiFiltering,
                       callerContext?, structuredOutput?/jsonSchema,
                       imageGeneration?/imageModel?, urlFetch?, slackWorkspace?,
                       dynamicCapabilities?, memoryRecall?, reasoningTrace? },
          mcpList: McpBinding[], skillList: string[],
          subagentList: { name, type: 'local' | 'remote' }[], maxTurn?, createdAt }
```

- `CostLimits { alertThresholdUsd?, blockThresholdUsd?, monthlyAlertThresholdUsd?,
  monthlyBlockThresholdUsd?, alertDestinations? }` — 목적지는 Slack·Telegram·Teams 중 플랫폼마다
  하나씩 선택한다. 창(window)은 둘, **UTC 일**(usage 행이
  키로 삼는 단위)과 **UTC 월**이며, 월의 지출은 그 일별 행들의 합이다 — 한 파티션에 최대
  31개, 한 번의 한정된 query — 그래서 어긋날 별도의 집계값이 존재하지 않는다.
- `McpBinding { name, headers?: Record<string, string | null>, tools?: string[] }` 는 version 을
  registry 의 MCP 서버에 묶는다. `tools` 는 그 서버의 도구 중 런이 제공할 것을 좁힌다.
  **URL 은 언제나 registry 의 것이고**, `headers` 는 dispatch 시점에 서버 자신의 헤더 위로
  겹쳐진다(문자열 = 교체/추가, `null` = 기본값 제거, 대소문자 구분 없이 매칭). 그래서 하나의
  registry 서버가 서로 다른 자격 증명으로 여러 project 를 섬긴다. 오버라이드 값은 registry
  헤더와 같은 AES 암호화/마스킹 수명주기를 따르며 — 이 때문에 version 은 시크릿을 갖는 첫
  엔티티가 된다: API 응답은 `toVersionView` 를 지나고, 실행 경로는 repository 값을 읽어
  dispatch 시점에 복호화한다. 오버라이드가 생기기 전에 쓰인 행은 `mcpList` 를 `string[]` 로
  저장했다. 읽을 때 정규화되고, API 도 여전히 그 형태를 받는다.
- 템플릿 변수 `{{var}}` 는 dispatch 전에 서버 측에서 렌더링된다.
- Version 쓰기는 catalog 모델에 대해 **capability 적합성**을 검증한다(agent project 는
  `capabilities.tools` 를 요구하고, `structuredOutput` 은 그 capability 를 요구한다). 알 수
  없는/커스텀 모델 id 는 경고와 함께 계속 허용되며 — catalog 에 추가되기 전까지는 $0 으로
  가격이 매겨진다.
- Version 쓰기는 `mcpList`/`skillList`/`subagentList` 항목이 **resolve 되는지**(`VersionRefRepos`,
  composition root 가 `versionUseCases` 에 한 번 바인딩한다), 그리고 그 project type 이 실제로
  그것들을 실행할 수 있는지도 검증한다 — `agent` project 만 그러하므로, 다른 type 에 추가된
  binding 은 저장돼 에디터에 표시되고 런타임에는 조용히 무시되는 대신 거부된다. 업데이트
  시에는 *새로 추가된* 항목만 검사하므로, registry 항목을 삭제해도 그것을 이미 참조하던
  version 들이 고립되는 일이 없고, 이 규칙들이 생기기 전에 저장된 설정도 계속 편집하고
  제거할 수 있다.
- **런이 어느 version 을 실행하는가**는 `resolveRunnableVersion`
  (`src/application/project/resolveRunnableVersion.ts`)이 소유한다: published 포인터가 언제나
  이긴다. 대화형 표면(chat)만 최신 draft 로 폴백하는 쪽을 택하고, 외부 표면(Slack, A2A,
  webhook trigger, subagent transfer)은 published 전용이라 draft 가 새어 나가지 않는다.

## LLM engine

`src/application/llm/engine.ts` 는 **모든 것이 주입되는 순수 로직**이다 — channel,
`recordUsage`, `callMcpTool`, `loadSkillContent`, `runSubagent`, `generateImage`, `editImage`,
`fetchUrl`, `readSlack` — 그래서 `tests/fakeChannel.ts` 를 통해 네트워크도 DB 도 없이 테스트된다.

루프는 두 이웃을 두고, **`engine.ts` 가 둘 다 다시 export 하는 파사드**라서, 호출자는 import
경로 하나를 유지하고 그 분리는 내부 사정으로 남는다:

| 모듈 | 소유하는 것 |
|---|---|
| `agentAssembly.ts` | 런이 무엇을 할 수 있다고 듣는가: `assembleAgentRun`, 시스템 프롬프트 빌더들(`buildAgentSystemPrompt`, skill 표와 server 표, 런 시계와 caller 블록), builtin 도구 정의와 `buildAgentTools`, `BUILTIN_TOOL_NAMES`, `ImageRegistry`, 그리고 `MAX_DISPATCH_TASKS` |
| `toolResultBudget.ts` | 결과가 얼마를 써도 되는지와 무엇을 해야 하는지: `createToolResultBudget` 과 `createToolResultEmitter`, `MAX_TOOL_RESULT_CHARS_PER_TURN`, `MIN_KEPT_RESULT_CHARS`, 그리고 truncation 마커 |

> `src/application/llm/AGENTS.md` 가 루프 불변식의 정본이다. `engine.ts`, `agentAssembly.ts`,
> `toolResultBudget.ts`, `pii.ts` 를 고치기 전에 읽어라.

```mermaid
flowchart TB
  start["턴 시작"]
  guard{"턴 ≥ maxTurn?"}
  turnlimit["warning +<br/>finishReason: turn-limit"]
  final{"턴 = maxTurn − 1 이고<br/>이 런에 도구가 있는가?"}
  wrapup["도구를 제공하지 않고,<br/>모델에게 그 이유를 알린다"]
  call["모델 호출 — 스트림<br/>첫 chunk 전의 재시도 가능한 실패:<br/>fallback 으로 한 번 재시도"]
  miderr["스트림 도중 실패:<br/>error chunk, 재시도 없음 — 스트림 종료"]
  hascalls{"tool call 이 있는가?"}
  cut{"provider 가<br/>finish_reason length 라고 했는가?"}
  outputlimit["warning +<br/>finishReason: output-limit"]
  finished["done: true"]
  dispatch["모든 호출을 알린 뒤 dispatch:<br/>builtin 은 호출 순서대로 · MCP + FetchUrl 은 동시에 ≤5<br/>출력이 잘린 턴은 한 번 경고한다. 파싱되지 않은<br/>인자는 error 결과를 받고, 결코 dispatch 되지 않는다"]
  budget["턴당 상한 + 런 컨텍스트 예산<br/>잘린 곳에는 마커가 남고, 런은 한 번 경고한다"]
  append["assistant 메시지 하나 + tool 결과<br/>+ post-context 메시지 — 모두 과금된다"]

  start --> guard
  guard -->|예| turnlimit
  guard -->|아니오| final
  final -->|예| wrapup --> call
  final -->|아니오| call
  call -.-> miderr
  call --> hascalls
  hascalls -->|아니오| cut
  cut -->|예| outputlimit
  cut -->|아니오| finished
  hascalls -->|예| dispatch --> budget --> append -->|"턴 + 1<br/>(transfer 는: + 2)"| start
```

**마무리 턴(wrap-up turn)** 에서는 모든 경로가 `turn-limit` 으로 끝난다: 모델이 쓴 것이
무엇이든 그것이 런의 답이고, 그럼에도 모델이 한 호출은 dispatch 되지 않으며, warning 은 런이
답을 냈는지 아니면 답 없이 멈췄는지를 말한다.

모든 종료는 알려진다 — 정상 종료는 `done`, 상한은 `finishReason`, 실패는 `error` chunk — 그것이
소비자로 하여금 끝을 추론하지 않고 읽게 해 준다.

- 모든 텍스트 생성은 **OpenAI Chat Completions 프로토콜**로 말하며, 모델 id 는
  `provider/model` 이다. 라우팅은
  [CONFIGURATION.md](../CONFIGURATION.md#llm-채널) 에 설명돼 있다.
- `runPrompt(deps, input): Promise<RunResult>` — 단발성이고, 스트리밍은 `runPromptStream` 이다.
- `runAgent(deps, input): AsyncGenerator<EngineChunk>` — 재귀적인 다중 턴 도구 루프.
  제공할 수 있는 것: `Skill`(점진적 skill 로딩), `transfer_to_agent`(subagent transfer —
  로컬 재귀이거나 원격 agent 의 HTTP 호출), `dispatch_agents`(여러 subagent 를 한 번에,
  **top-level 런에만** 제공되어 동시에 도는 자식 수가 transfer 깊이를 따라 늘지 않는다),
  `GenerateImage`, `EditImage`, `FetchUrl`(모델이 고른 URL, `parameters.urlFetch` 뒤에 있다 —
  [SECURITY.md](../SECURITY.md#모델이-고른-url) 참고. 자기 몫의 추출은 갖지 않는다 —
  텍스트·HTML·PDF 는 첨부가 지나는 것과 같은 `DocumentExtractor` 를 지난다), 그리고
  `SaveFile`(런이 쓴 텍스트를 독자가 받는 파일로 남긴다 — 버전이 아니라 **오브젝트 스토리지**가
  게이트다. 앞의 둘은 결정이라 버전이 정한다: 하나는 호출마다 돈을 쓰고 하나는 모델이 말하는
  주소로 요청을 보낸다. 파일을 쓰는 것은 둘 다 아니고, 못 하는 런은 리포트를 채팅창에 붙여
  넣는 수밖에 없다),
  `parameters.slackWorkspace` 뒤의 Slack 읽기 도구 여섯 개
  ([workspace 읽기](slack.md#워크스페이스-읽기) 참고).
  **그 밖의 이름은 모두 MCP 도구이고**, `BUILTIN_TOOL_NAMES` — 열세 개 전부 — 는 alias 할당
  동안 예약되어, MCP 도구가 builtin 이 주장할 수 있는 이름을 다는 일이 없다.

> 루프가 그것들을 어떻게 dispatch 하는지, builtin 이 *제공된다*는 것이 무슨 뜻이고 왜 그것을
> dep 의 존재로 읽지 않는지, 턴 가드와 마무리 턴이 런을 어떻게 끝내는지, transfer 가 무엇을
> 나르고 모든 결과가 무엇에 과금되는지 — 전부 `src/application/llm/AGENTS.md` 의 몫이며,
> 편집에 필요한 만큼의 상세로 적혀 있다.

세 가지 한계는 루프의 메커니즘이라기보다 플랫폼에 대한 결정이고, 각각은 루프가 스스로 물을 수
없는 질문에 답한다:

- **런 전체 컨텍스트 예산**(`src/application/llm/contextBudget.ts`, 단일 소유자)은 모델의
  `contextWindow` 에서 상한을 도출한다. 그래서 window 가 작은 모델에서 도구를 많이 쓰는 런은
  provider 의 `400` 으로 죽는 대신 마커와 `warning` 하나를 남기며 잘린다(추정치와 그 근거는
  [CONFIGURATION.md](../CONFIGURATION.md#런-전체의-컨텍스트-예산) 에 있다). 이 예산은 런이
  *추가하는* 것을 제한한다 — 입력 `messages` 는 호출자의 것으로 남는다: chat 만 히스토리를
  다듬는데, 서버 측 저장소가 유일하게 한계 없는 입력원이기 때문이다. 다른 모든 표면은 호출자가
  구성한 것을 그대로 중계한다. 호출자의 요청을 조용히 다시 쓰는 것이 provider 자신의 overflow
  응답보다 나쁘기 때문이다. 등록되지 않은 모델은 도출할 window 가 없어 예산 없이 실행된다.
- **두 이미지 dep 은 version 이 `parameters.imageGeneration` 으로 옵트인할 때만 주입된다.**
  모델은 `parameters.imageModel` 이 여전히 이미지 가능 모델인 동안에는 그것이고, 아니면
  registry 의 기본값이다. 해석된 모델의 provider 가 *edit* 엔드포인트를 구현하는지는 dispatch
  시점에만 알 수 있으므로, 그 거부는 숨겨진 도구가 아니라 tool-result 에러다.
- **로컬 transfer 는 조상 체인을 나른다**: 이미 체인에 있는 project 로 transfer 하거나 깊이 5
  를 넘겨 중첩하는 것은 author 가 붙은 error chunk 로 거부된다. 턴 회계만으로는 이것이
  제한되지 않는다 — 자식은 부모의 턴 카운터를 이어받고 자신의 `maxTurn` 은 부모의 상한으로
  clamp 된다(`subagentRunner.ts`) — 그래도 순환은 상한이 무언가 말하기 전에 예산 전체를 써
  버릴 것이다.

런이 루프 자체를 넘어 나르는 것:

- **Fallback**: 기본 모델에서 **첫 chunk 전에** 재시도 가능한 에러(429/5xx)가 나면
  `fallbackModel` 로 한 번 재시도한다. 스트림 도중의 실패는 `{error}` chunk 를 내고 재시도하지
  않는다.
- **PII 필터링**(`parameters.piiFiltering`): 밖으로 나가는 메시지와 변수 안의 이메일, 전화번호,
  주민등록번호, Luhn 검증을 통과하는 카드 번호는 dispatch 전에 형식을 보존하면서 되돌릴 수 있는
  `[[PII:…]]` 토큰으로 정규식 마스킹된다(`src/application/llm/pii.ts`). 원본은 응답에서 복원되며
  — 토큰 경계 버퍼링과 함께 스트리밍도 포함한다 — 매핑은 subagent transfer 를 건너 이어진다.
  반면 engine 컨텍스트로 다시 들어오는 도구 인자·결과는 마스킹된 채로 남는다. **밖으로 나가는
  MCP dispatch 는 마스킹되지 않는다** —
  [SECURITY.md](../SECURITY.md#pii-필터링-그리고-그것이-멈추는-곳) 참고. 꺼 두면 필터링하지 않는
  경로와 바이트 단위로 동일하다.
- **비용**은 channel 이 말해 줄 때는 channel 이 청구한 값이고(`usage.cost_usd`, router 가
  보고하며 그것만이 청구서와 일치한다), 아니면 호출 지점에서 계산한 registry 가격이다
  (`src/domain/llm/models.ts` 의 `calculateCost` / `calculateImageCost`). 어느 쪽이든
  `recordUsage` 로 전달되고, 그것이 usage repository 의 원자적 `ADD` 에 넘긴다. 단발성 런은
  호출마다 기록하고, agent 런은 `createUsageAggregator` 에 턴별 usage 를 모아 런이 끝날 때 한 번
  flush 한다.
- **Model registry** `src/domain/llm/models.ts`:
  `ModelConfig { id, provider, family, maker, displayName, pricing { inputPer1M, outputPer1M,
  cachedInputPer1M?, imageInputPer1M?, imageOutputPer1M?, perImage?, perInputImage? },
  capabilities { tools, structuredOutput, imageInput, reasoning, reasoningWithTools?,
  imageGeneration? }, contextWindow, maxTokens, hidden?, wireId? }`. `wireId` 와 drift 검사는
  [CONFIGURATION.md](../CONFIGURATION.md#모델-레지스트리-agent-models-의-카탈로그) 참고.

## Images

세 경로가 그림을 그리고, 그것들은 하나의 use case 가 아니라 하나의 port — `ImageChannel`
(`src/domain/llm/imageChannel.ts`) — 에서 만난다. 각 경로에 도달하는 것이 다르기 때문이다:
라우트, 모델의 tool call, transfer.

| 경로 | 실행되는 곳 | 모델 |
|---|---|---|
| `image` project | `generateImage` (`src/application/image/generateImage.ts`) | version 자신의 `model` |
| agent 런의 `GenerateImage` / `EditImage` builtin | `src/application/execution/imageTool.ts` | `parameters.imageModel` 이 여전히 이미지 가능 모델인 동안에는 그것, 아니면 `defaultImageModel()` — 그 capability 를 가진 첫 *visible* 카탈로그 항목 |
| transfer 를 거쳐 도달한 `image` project | `runImageSubagent` (같은 파일) | 자식 version 자신의 `model` |

**생성과 편집은 하나의 결정이고, 입력에서 읽는다.** 모든 경로는 원본 바이트를 들고 있으면
`editImage` 를, 들고 있지 않으면 `generateImage` 를 호출한다 — Images API 자신이 긋는 구분이다.
그래서 "이제 밤으로 만들어줘"가 사용자가 첨부한 그림에도, 런이 그린 그림에도, transfer 가
`image_ids` 로 이미지 자식에게 넘긴 그림에도 내려앉으며, 그중 어느 것도 별도의 도구를 필요로
하지 않는다.

**Version 의 시스템 프롬프트가 그 스타일이다.** 이미지 provider 에는 system 메시지가 없으므로,
`composeImagePrompt`(`src/application/image/composeImagePrompt.ts`)는 `image` project 의 version
을 실행하는 두 경로에서 모든 주제 프롬프트 — 호출자의 `prompt`, 렌더링된 템플릿, transfer 의
메시지 — 앞에 version 의 시스템 프롬프트를 붙인다. Agent builtin 은 의도된 예외다: agent 의
시스템 프롬프트는 그 행동이지 그림 스타일이 아니므로, builtin 호출은 모델 자신의 프롬프트를
손대지 않고 보낸다. 스타일만으로는 주제가 되지 않는다 — 주제 프롬프트가 빈 런은 여전히
거부된다.

**capability 를 어디서 검사하느냐가 거부의 모양을 정한다.** `generateImage` 는 런 브래킷을 열기
*전에* `capabilities.imageGeneration` 을 검증하고 프롬프트를 렌더링한다. 그래서 잘못 설정된
version 은 슬롯을 써 버린 런이 아니라 `400` 이 된다. Builtin 은 같은 질문에 wiring 시점에
답한다 — `parameters.imageGeneration` 에 옵트인하지 않은 version 에는 애초에 제공되지 않고,
저장된 `imageModel` 이 그 사이 registry 에서 사라졌다면 도구를 조용히 비활성화하는 대신
기본값으로 폴백한다. 이미지 subagent 는 스트림 도중에만 답할 수 있으므로 그렇게 답한다 —
author 가 붙은 `error` chunk 로. 해석된 모델의 provider 가 *edit* 엔드포인트를 구현하는지는
dispatch 전에는 알 수 없고, 그래서 그 거부는 숨겨진 도구가 아니라 tool-result 에러다.

**호출자가 떠난 것은 provider 가 실패한 것이 아니며, 그것을 말해 주는 것은 signal 이다.**
`fetch` 는 런의 signal 이 무엇으로 abort 되었든 *그것*으로 reject 하고, 맨 `abort()` 만이 DOM 의
`AbortError` 다 — Next.js 는 `request.signal` 을 자신의 `ResponseAborted` 로 abort 하는데, 이름이
다르고 메시지도 없는 Error 다. 그래서 `generateImage` 는 취소와 거부(`providerFailure`)를
구분하려고 `signal.aborted` 를 읽는다. 에러 이름으로 판정하던 때에는, 1분 걸리는 xAI 생성 도중
새로고침한 사람이 `502 Image generation failed for …: ` 로, 콜론 뒤에 아무것도 없이 로그에
남았다. 런의 signal 이 밖으로 나가는 호출에 닿는 곳이면 어디서나 같은 규칙이 성립한다: A2A
transfer 는 호출자의 signal 로는 "cancelled" 를, 자신의 idle signal 로는 "timed out" 을
보고하고, 호출자가 취소한 discovery 는 결코 MCP 실패 캐시에 쓰이지 않는다 — 그 캐시는
`url + headers` 단위라서, 새로고침 한 번이 실패 기간 내내 그 project 의 모든 런에 "server
unavailable" 을 되풀이해 재생했을 것이다.

**Port 는 의도를 말하고, adapter 는 각 provider 의 방언을 말한다.** 모든 provider 가 구현하는
사실상의 표준이라 `src/infrastructure/llm/channel.ts` 에는 provider 분기가 아예 없는 Chat
Completions 와 달리, Images API 는 하나의 형태가 *아니다*. Port 의 `size` 와 `quality` 는 도구
스키마가 모델에게 제공하는 어휘이고, 모델은 어느 provider 가 자신을 서빙할지 전혀 모른다.
그것들을 번역하는 일은 `src/infrastructure/llm/imageChannel.ts` 의 몫이며, 이 파일이
`ResolvedTarget.providerName` 의 유일한 독자다. xAI 는 같은 의도를 `aspect_ratio` + `resolution`
이라 부르고, 모르는 인자를 무시하는 대신 **거부하며**(`400 Argument not supported: size`),
`response_format` 의 기본값이 이 adapter 가 쓸 수 없는 URL 이고, 편집은 `application/json` 으로만
받는다 — 그 API 문서가 OpenAI SDK 의 multipart `images.edit()` 를 미지원으로 적어 두었고, 그래서
그 호출 하나는 `fetch` 위에 손으로 짰다.

**OpenRouter 는 어휘가 같고 나머지가 전부 다르다.** `size`(픽셀 또는 티어)는 port 가 말하는 그대로
받아 뒤에 있는 provider 에 맞게 정규화한다. **`quality` 는 정규화하지 않으므로 보내지 않는다** —
그대로 통과시키는데 Gemini 는 무시하고, GPT Image 는 OpenAI 의 네 값을 받고, Grok 은 툴 스키마가
모델에게 허용하는 "high" 에 `400 … quality: not supported. Accepted: low, medium` 으로 답한다.
넷 모두에 안전한 값이 없어서 아무것도 보내지 않고, 각 provider 가 자기 기본 티어로 그린다 —
레지스트리의 `perImage` 가 값을 매긴 그 티어다. 하지만 경로는 `images` 하나뿐이라
`images/generations` 는 404 이고, 편집은
두 번째 경로가 아니라 같은 호출에 `input_references` 를 더한 것이며(mask 는 없어서 xAI 와 같은
이유로 거부한다), 응답은 `mime_type` 이 아니라 `media_type` 으로 답하고 usage 는 Chat Completions
의 이름들(`prompt_tokens`, `completion_tokens_details.image_tokens`)로 답한다. 입력 쪽 text/image
분할은 보고하지 않으므로 참조 이미지의 토큰은 text input 으로 센다 — 이미지 입력이 텍스트보다 비싼
모델(GPT Image 2: $8 대 $5)에서만 그만큼 낮게 잡히고, 분할을 지어내는 것은 아무도 공개하지 않은
숫자다. 그래서 transport 만 xAI 와 공유하고 응답 리더는 각자다.

여기 추가되는 provider 는 방언을 가정하지 말고 확인해야 한다:
`tests/imageChannelAdapter.test.ts` 가 각각의 wire 형태를 고정한다.

**mime type 은 읽는 것이지 결코 가정하는 것이 아니다.** 예전에는 `image/png` 로 하드코딩돼
있었고, 그것은 OpenAI 의 기본 출력 형식이라서만 성립했다. xAI 는 JPEG 로 답한다. 이 값은
겉치레가 아니다 — 불변 캐시 헤더 아래 S3 오브젝트의 확장자와 `Content-Type` 이 되고, *두 번째*
모델에게 돌려주는 바이트의 `data:` 접두사가 되며, Slack 업로드의 파일명과 A2A artifact 의 type
이 된다.

**usage 의 축약은 정확히 한 곳에서 일어난다.** 이미지 모델은 세 가지 토큰 수를 청구하는데 usage
행은 둘을 나른다. `toImageUsageRecord`(`src/domain/llm/models.ts`)가 세 경로 모두에 대해 그
축약을 소유한다. 토큰 수를 전혀 보고하지 않는 provider — xAI 는 이것들을 이미지 단위로 매기고
그것을 `cost_in_usd_ticks` 로 말한다 — 는 0 을 기록하고, `calculateImageCost` 는 registry 의
`perImage` 로 폴백하는데 그것이 실제로 청구되는 값이다. 그것을 기록하는 일은 telemetry 다 —
provider 는 이미 그림을 그렸고 청구했으므로, 쓰기 실패는 결과를 내던지는 500 으로 바꾸는 대신
로그로 남긴다.

**바이트가 어디로 가는지는 소비자의 결정이지 engine 의 결정이 아니다.** 같은 `image` chunk 가
모든 표면에 도달하고 — 하나를 어떻게 읽는지는
[EngineChunk 계약](../ARCHITECTURE.md#enginechunk-계약) 에 있다 — 각자 그것으로 다른 일을
한다: chat 은 런 브래킷이 이미 저장해 둔 **오브젝트 키**를 영속화하고, Slack 은 런이 끝나면
스레드에 업로드하며, OpenAI 호환 표면은 `images` 확장으로 나르고, predict 는 텍스트 옆에 함께
돌려준다. 오브젝트 스토리지가 설정돼 있지 않으면 chat 이미지는 라이브 스트림 동안에만
렌더링되고, 빈자리를 남기는 대신 그렇다고 말한다.

**저장된 이미지는 키이고, 그 주소는 읽을 때마다 해석된다.** 행은 접근 정책을 확정하지 않는다.
`ARTIFACT_ACCESS_MODE=authenticated` 는 키를 시간 제한이 있는 서명 URL 로 해석하고, `public` 은
지역 S3 직접 URL 로 해석한다. 이미지는 *보여지는* 것이라 파일명을 요구하지 않으며 서명 없는
주소로 충분하다. **문서**는 자기 이름을 달고 가져가는 것이고 S3 는 서명된 요청에서만 그것을
받아 주므로, 문서는 어느 모드에서든 미리 서명된다. `resolveImageUrl`
(`src/domain/chat/imageRefs.ts`)이 단 하나의 호환 규칙을 소유한다 — `key` 는 해석하고 레거시
`url` 은 그대로 통과시킨다 — 묻는 독자가 둘이고, 두 번째 표기가 생기는 순간 그중 하나가 조용히
이미지의 절반을 보여 주지 않게 되기 때문이다. 둘 다 매핑 *전에* 해석하며, 그것이
`toEngineMessages` 를 replay 계약이 테스트하는 순수 동기 함수로 유지한다.

authenticated 모드에서 두 수명이 다른 데에는 거꾸로 이해하기 쉬운 이유가 있다: chat 뷰는 이미 그
페이지를 가진 사람이 읽으므로 15분이면 넉넉하지만, **replay** 는 URL 을 모델 *provider* 에게
넘기고, provider 는 `MAX_RUN_DURATION_MS` 만큼 이어질 수 있는 런의 어느 시점에든 그것을
가져간다. 그래서 replay 수명은 적어 두는 대신 런 마감에서 도출한다. 그러지 않으면 마감을 올렸을
때, 사용자가 자기 대화 기록에서 볼 수 있는 이미지에 대해 턴이 조용히 실패하기 시작할 것이다.
세 번째 수명 — SigV4 상한인 7일 — 은 Slack 스레드나 저장된 A2A task 처럼 지속되는 무언가에
적히는 링크를 위한 것이고, 런이 끝나고 한참 뒤에 읽힌다(셋 다
`src/application/artifact/urlTtl.ts` 가 소유한다). 서명할 수 없는 이미지는 메시지에서 빠진다:
replay 경로에서는 가져올 수 없는 URL 이 턴 전체를 실패시킨다.

**chat 은 결코 오브젝트를 삭제하지 않는다.** chat 행은 DynamoDB TTL 로 만료되는데 애플리케이션은
그것을 결코 관측하지 않으므로, cascade 할 수 있는 순간 자체가 없다 — 만료는 버킷의 lifecycle
규칙이고, [OPERATIONS.md](../OPERATIONS.md#새-배포를-위한-운영-체크리스트) 의 배포
체크리스트에 있다.

의도적인 제거는 이 경로가 아니라 artifact 갤러리의 몫이다: artifact 행이 오브젝트를 가리키고,
`artifactUseCases.remove` 는 재시도가 수렴하도록 행보다 오브젝트를 *먼저* 삭제한다
([Artifacts](#artifacts) 참고). chat 메시지는 키의 사본을 따로 갖고 있으므로, 거기서 삭제된
이미지는 대화 기록에서 사용할 수 없음으로 렌더링된다 — 그 사실은 확인 절차에서 미리 말해 준다.
그것을 보여 준 모든 chat 과 Slack 스레드로 되돌아가는 cascade 는 artifact 슬라이스가 그것들을
전부 import 하지 않고는 할 수 없는 일이기 때문이다.

## Artifacts

런이 남긴 것: 저장된 오브젝트당 행 하나. 그래서 바이트를 목록으로 볼 수 있고, 미리 볼 수 있고,
제거할 수 있다. 그 전에는 재고 목록이 아예 없었다 — 생성된 이미지는 무작위 UUID 아래로 S3 에
갔고 그 키는 마침 열려 있던 chat 메시지에 쓰였다. 그래서 무엇도 그것을 열거할 수 없었고, 무엇도
삭제할 수 없었으며, trigger 나 A2A 호출이 그린 그림은 아무 데도 가지 못했다.

**런 브래킷에서 포착한다.** 네 함수가 top-level 런을 admit 하고 그 모두가 바이트를 만들어 낼 수
있으므로, `openRun` 이 런의 정체 — project, version, actor, transfer 체인, correlation id — 를
이미 바인딩한 상태로 recorder 를 만든다. 대신 `generateImage` 에 붙였다면 경우의 4분의 1만
감당했을 것이다: 이미지는 네 생산자로부터 스트림에 도달하고(image project,
`GenerateImage`/`EditImage` builtin, 이미지 subagent, 이미지를 돌려준 MCP 도구) 그중 첫 번째만이
그 use case 다. `captureRunArtifacts` 가 engine 의 스트림을 감싸고, `generateImage` 는 자신의
단일 결과를 직접 기록한다. 다섯 번째 출처는 같은 축을 타지만 포착이 유일하게 건너뛰는 것이다:
`FetchUrl` 이 가져온 그림은 `fetched` 를 달고 전달되며 결코 보관되지 않는다 — 런은 그 바이트를
만든 것이 아니라 읽었고, 그 표시를 붙이는 것은 그 builtin 뿐이다. MCP 도구의 그림은 읽어 온
것일 수도 있지만 그려 낸 것일 수도 있기 때문이다.

| Chunk | 포착이 하는 일 |
|---|---|
| `image` | 바이트를 저장하고 그것을 **유지하며**, `artifactId`/`key` 를 추가한다. 라이브 뷰는 여전히 chunk 에서 렌더링한다. `fetched` 표시가 붙은 것은 저장되지 않은 채 지나간다. |
| `file` | 바이트를 저장하고 그것을 **떼어 내어**, 이름·크기·키만 남긴다. 렌더링된 문서는 그릴 것이 없고, 다운로드 링크 하나 만들자고 SSE 연결로 수 MB 의 base64 를 밀어 내리는 것은 순수한 비용이다. |

파일의 생산자는 둘이다. 파일을 만들어 돌려주는 MCP 도구(문서 렌더러가 그렇다)와 `SaveFile`
빌트인이고, 행의 provenance 가 둘을 갈라 적는다 — `mcp: render_document` 와
`builtin: SaveFile`. 빌트인 쪽은 모델이 쓴 텍스트라 바이트를 만든 것이 모델이지만, 그것을
어디에 둘지는 여전히 브래킷이 정한다: 도구는 결과에 파일을 실어 보낼 뿐이고 저장은
`captureRunArtifacts` 가 한다. 그래서 새 생산자가 저장 경로를 새로 알 필요가 없었다.

**무엇이 그렸는지는 그린 쪽이 말한다.** artifact 행의 `model` 은 chunk 가 실어 온 것이고
(`EngineChunk.image.model`), 브래킷이 version 에서 유추하지 않는다 — 런의 모델은 그림을 그린
모델이 아니기 때문이다. builtin 은 `resolveImageModel` 이 고른 이미지 모델로, 이미지
subagent 는 자기 version 의 모델로 그린다. 브래킷에서 채웠다면 자식의 그림에 부모의 모델
이름이 붙고 아무것도 그 사실을 말하지 않았을 것이다. 이름을 댈 수 있는 생산자는 셋이다: image
project(`generateImage`), `GenerateImage`/`EditImage` builtin(`ImageGenerator`/`ImageEditor` 의
반환이 모델을 *필수로* 담는다), 이미지 subagent. **나머지는 비운다** — MCP 도구의 그림, 원격
A2A 에이전트의 그림, 도구가 렌더링한 문서, 사람이 가져온 첨부. 거기서 빈 값이 참이고, 런의
모델을 fallback 으로 쓰는 것은 추측을 사실처럼 적는 일이다. 갤러리 카드는 이것을
`producedBy` 와 한 줄로 함께 보여 주고, 검색 필터도 이 두 값을 본다.

실패한 쓰기는 결코 런을 실패시키지 않는다: 비싼 부분은 그림이었고, 사본을 잃는 것은 답을 잃는
것보다 엄격히 덜 값어치 있다. 손실은 스트림 **이후에** 런의 진짜 총계로 한 번 보고된다 — 첫
실패에서 경고하면 "파일 하나"라고 말한 뒤 이후의 모든 실패를 같은 일회성 플래그에 흡수해 버릴
것이다.

**독자가 *여는* 것은 주소가 아니라 앱을 통해 나간다.** 다른 모든 읽기는 서명한 오브젝트 URL 이다 — 바이트는
앱을 거치지 않는다. 독자가 *여는* 것만은 그럴 수 없다. 서명된 주소는 sandbox 헤더를 실을 수
없고, 건네진 뒤에는 그것을 연 사람의 권한보다 오래 살며 public 모드에서는 영구다. 그래서
`/api/artifacts/{id}/view` 가 삭제와 같은 술어로 인가한 뒤 바이트로 답하고,
`Content-Security-Policy` 의 `sandbox` 가 문서를 불투명 오리진에 놓는다. 목록이 짧은 것은 표시
가능성이 아니라 **여는 것이냐 보관하는 것이냐**를 묻기 때문이다 — 브라우저가 알아서 그리는 PDF
는 sandbox 가 필요 없고, 다운로드는 애초에 신뢰를 요구하지 않는다.

`inlineViewOf` 가 boolean 이 아니라 **종류**를 돌려주는 것은 답이 하나가 아니기 때문이다.
CSV 를 표로, JSON 을 다시 들여쓴 텍스트로 보여 주는 것이 각 파일을 *그것답게* 보여 주는
것이고, 전부에 `<pre>` 하나를 쓰면 아무도 묻지 않은 질문에 답하는 셈이 된다. `text/html` 만
쓰인 그대로 나가고 — 임의의 마크업을 실행하는 것이 sandbox 의 존재 이유다 — 나머지는 전부
여기서 바이트로부터 만들어진다.

| 종류 | 어떻게 |
|---|---|
| `markdown` | 채팅 스레드와 **같은 렌더러**(`react-markdown` + `remark-gfm`) |
| `csv` | RFC 4180 파싱 후 표. 첫 행이 머리행이고(미디어 타입의 기본값이다), 2,000행에서 끊고 무엇을 뺐는지 말한다 |
| `json` | `JSON.parse` → 2칸 들여쓰기. 파싱되지 않으면 원문 그대로 + 그 사실을 말한다 |
| `svg` | `data:` URL 로 `<img>` 안에 |
| `text` | 원문 그대로 |

markdown 이 같은 렌더러인 것은 의도다: 같은 리포트가 어느 표면에서 읽히느냐에 따라 다르게
보여서는 안 되고, 저장소에 markdown 방언이 둘이면 표·체크리스트·코드 펜스의 edge case 도 두
벌이 된다. 그리고 그 렌더러가 원시 HTML 을 텍스트로 내보내므로 — SVG 가 인라인이 아니라
`<img>` 인 것도 같은 이유다 — `text/html` 을 뺀 모든 view 가 `allow-scripts` 없이 나간다.
보장을 이스케이프가 아니라 브라우저가 한다.

`artifactId` 가 chat 행과 라이브 스트림 프레임에 함께 실리는 것이 이 때문이다. 나머지 표면은
그것을 나르지 않는다: 서명한 주소로 충분하고, 독자가 행 id 로 할 수 있는 일이 없었다. 페이지가
생기고 나서야 그것은 독자가 누를 수 있는 무언가가 됐고, 그래서 페이지에만 붙는다.

**인덱스가 둘인 이유는 각자 상대가 닿지 못하는 행에 닿기 때문이다.**

| | PK | SK | GSI1 | GSI2 (sparse) |
|---|---|---|---|---|
| Artifact | `ARTIFACT#{id}` | `META` | `ARTIFACTPROJECT#{project}` / `{createdAt}#{id}` | `ARTIFACTOWNER#{email}` / `{createdAt}#{id}` |

A2A·webhook·schedule 런은 메일함을 지목하지 않는다 — 그 actor 는 client id 이거나 trigger 다 —
그래서 그 행들은 owner 인덱스에 보이지 않고, project 자신의 탭이 그것들이 목록에 오르거나
삭제되는 유일한 자리다. Slack 런의 actor 는 workspace 사용자 id 라 인덱스가 그것으로도 키를 만들
수 없지만, 그 표면은 질문한 사람의 주소를 알아낼 수 있으므로 그렇게 한다: artifact 는 그것을
요청한 사람 앞으로 정리된다(`ownerEmail` 은 actor 에 접어 넣지 않고 그 옆에 둔다. actor 키가
지출과 한도를 정하기 때문이다). Project 가 공유 카탈로그이므로 그 역도 참이다: 남의 project 를
읽는 것으로 자기 작업을 찾을 수는 없다. `artifactOwnerEmail` 이 정하고, 답이 아무도 아닐 때는
GSI2 속성을 쓰지 않는다.

오브젝트 키는 행 id 에서 도출되며(`artifacts/{kind}/{id}.{ext}`), 그것이 오브젝트와 그 행이
서로를 찾게 해 준다. 레거시 `images/{uuid}` 키는 아무것도 참조하지 않아서, 그 배치 아래의 고아는
다시는 식별할 수 없다. kind 로 나누는 것은 접두사에 적용되는 lifecycle 규칙 때문이다. 스토리지
adapter 는 모든 독자를 런타임 artifact 접근 모드로 해석한다: 비공개 버킷이면 서명 URL, 공개
버킷이면 S3 직접 URL.

**삭제는 오브젝트 먼저다.** 그 순서가 남길 수 있는 것은 미리보기가 깨진 행뿐이고 — 삭제를 다시
누르면 해결된다. S3 는 없는 키에 204 로 답하기 때문이다 — 반대 순서는 어떤 재고 목록도 이름
붙이지 않는, 영영 닿을 수 없는 바이트를 남긴다. 읽기와 삭제는 하나의 술어를 쓴다(생성자, 아니면
`assertProjectWritable`). 각각에 다른 규칙을 두면 삭제 버튼이 403 으로 답하는 행들을 나열하는
갤러리가 나오기 때문이다. 남의 출력을 제거하는 것은 `artifact.delete` 를 기록하고, 자기 것을
정리하는 것은 기록하지 않는다. 삭제마다 행을 남기면 그 감사 기록이 존재하는 이유인 행위들이
묻히기 때문이다.

행은 `ARTIFACT_RETENTION_DAYS` 에 따른 `expiresAt` 을 갖는다. 그 기간과 버킷의 lifecycle 규칙은
앱이 맞출 수 없는 두 개의 독립된 설정이다 — [OPERATIONS.md](../OPERATIONS.md#행-보존)
참고.

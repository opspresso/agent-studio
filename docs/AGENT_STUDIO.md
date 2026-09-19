---
title: Agent Studio 시스템 지식 문서
description: Agent Studio의 제품 경계, 실행 모델, 데이터, 보안, 운영, 코드 구조를 한 파일로 설명하는 RAG용 통합 문서
audience: 개발 에이전트, 운영자, 신규 기여자
tags:
  - agent-studio
  - agent-platform
  - control-plane
  - openai-agents-sdk
  - rag
  - mcp
  - workspace
  - offline
verified_at: 2026-09-19
verified_commit: 717fdc62
---

# Agent Studio 시스템 지식 문서

이 문서는 Agent Studio를 하나의 검색 가능한 지식 단위로 설명한다. 제품의 목적만 소개하지 않고,
요청이 어떤 계층과 저장소를 지나며 어느 정책이 어디에서 결정되는지까지 연결한다. Agent Memory나
다른 RAG 시스템에 넣었을 때 특정 질문만 검색되어도 문맥이 성립하도록 각 절을 독립적으로 서술한다.

이 문서는 탐색용 통합 지도다. 세부 계약이 충돌하면 실제 코드와 다음 권위 문서를 우선한다.

- 전체 구조와 실행 흐름: [ARCHITECTURE.md](ARCHITECTURE.md)
- 단일 소유 결정: [OWNERSHIP.md](OWNERSHIP.md)
- HTTP 계약: [API.md](API.md)
- 환경변수와 제한: [CONFIGURATION.md](CONFIGURATION.md)
- 인증·인가·시크릿·SSRF·PII: [SECURITY.md](SECURITY.md)
- 배포·프로브·보존·스케일링: [OPERATIONS.md](OPERATIONS.md)
- 로컬 개발·검사·CI: [DEVELOPMENT.md](DEVELOPMENT.md)
- 서브시스템 설계: [design/](design/)

## 1. Agent Studio란 무엇인가

Agent Studio는 기업이 자기 네트워크 안에 설치하는 **AI Agent Control Plane이자 AgentOps
플랫폼**이다. 프롬프트와 에이전트를 `Project`로 만들고, 실행 구성을 `Version`으로 관리하고,
하나의 Version을 publish한 뒤 콘솔·API·메신저·자동화·에이전트 프로토콜에서 실행한다.

Agent Studio가 소유하는 것은 다음과 같다.

- Project와 Version의 생명주기, publish 포인터, 접근 권한
- 모델·Skill·MCP·하위 Agent 바인딩과 자격 증명
- 비용·동시성·시간·입력·도구 정책
- Chat, 승인 중단과 재개, Artifact, Trace, Usage, Audit
- Slack·Telegram·Teams·Webhook·Schedule·A2A·AG-UI 같은 실행 표면
- 코드와 파일 작업을 위한 Persistent Workspace와 격리 Sandbox

Agent Studio가 직접 소유하지 않는 것은 모델 추론 알고리즘과 별도의 장기 Memory 저장소다.
기본 Agent Runtime은 **OpenAI Agents SDK**이며, 장기 Memory는 `recall` 같은 도구를 제공하는
외부 MCP 서버가 보관한다. Studio는 이들을 구성하고 정책으로 감싸지만, 별도의 두 번째 Agent
loop나 자체 Memory 데이터베이스를 만들지 않는다.

핵심 배포 전제는 **한 설치 = 한 기업**이다. 멀티테넌시 축은 없다. 한 설치 안에서는 멤버 tier,
Project visibility, 소유권과 관리자 권한으로 접근을 나눈다. 부팅·로그인·실행·콘솔은 공용
인터넷 없이도 동작해야 한다. 외부 모델, GitHub, Slack, Telegram, Teams, 원격 카탈로그, Plugin
sync 같은 연결은 모두 선택 기능이다.

## 2. 제품의 핵심 개념

### 2.1 Project와 Version

`Project`는 사용자가 호출하는 제품 단위다. 불변 식별자는 slug 형태의 `name`이며, 공개 이름,
설명, 유형, 소유자, visibility, publish 포인터, 메신저 연동, 비용 한도를 가진다.

Project 유형은 세 가지다.

| Project 유형 | 의미 | 대표 실행 |
|---|---|---|
| `llm` | 도구 반복이 없는 단발성 프롬프트 실행 | 템플릿 변수와 메시지를 모델에 전달해 한 번 답한다 |
| `agent` | 여러 모델 턴, 도구, MCP, Handoff, Agent-as-Tool을 쓰는 실행 | Chat, Agent SSE, 메신저 봇, 승인 가능한 도구 실행 |
| `image` | 이미지 생성 또는 소스 이미지 편집 | Predict, AG-UI, A2A, Trigger의 이미지 경로 |

`Version`은 Project가 어떻게 실행되는지를 선언한다. 주요 필드는 모델과 fallback 모델, system
prompt, user prompt template, 생성 파라미터, 최대 턴, Skill 목록, MCP binding, 하위 Agent 목록,
구조화 출력, PII 필터링, caller context, 이미지·URL·Slack·Workspace·Memory·dynamic capability
옵션이다. Version 이름은 스냅샷의 식별자지만 수정하면 같은 이름의 저장 내용을 갱신한다.

Publish는 Version 사본을 만들지 않는다. Project의 `publishedVersion` 포인터가 어느 Version을
외부에 내보낼지 가리킨다. 대화형 콘솔 Chat은 publish된 Version이 없으면 최신 draft를 사용할 수
있지만, Slack·Telegram·Teams·Webhook·Schedule·A2A·하위 Agent 호출 같은 외부 표면은 publish된
Version만 실행한다. Version 선택 규칙의 소유자는
[`resolveRunnableVersion.ts`](../src/application/project/resolveRunnableVersion.ts)다.

### 2.2 Skill, Tool, MCP, Agent, Memory, Session

이 개념들은 비슷해 보이지만 역할과 수명이 다르다.

| 개념 | 역할 | 누가 저장하는가 |
|---|---|---|
| Skill | 모델이 필요할 때 읽는 Markdown 지침과 참고 파일 | Studio의 Skill registry |
| Tool | 실행 가능한 함수. 입력 schema와 결과를 가진다 | Studio runtime 또는 연결된 시스템 |
| MCP | 외부 도구와 리소스를 연결하는 프로토콜 | Studio는 연결·정책·credential을, 서버는 기능을 소유 |
| Agent | 로컬 Project 또는 외부 OpenAI 호환/A2A 실행 대상 | Studio registry와 해당 실행 시스템 |
| Memory | 한 run보다 오래 남는 결정·관례·사실 | 연결된 Memory MCP 서버 |
| Session | 특정 Chat의 정확한 모델·도구 이력과 승인 상태 | Studio의 암호화된 `runtime_sessions` |
| Workspace checkpoint | 파일·Git·native CLI 작업의 복구 상태 | Workspace 저장소와 worker |

Memory를 Chat history와 혼동하면 안 된다. Memory는 장기 지식을 주제나 사용자 범위로 검색하는
외부 capability다. Session은 한 대화에서 모델에게 다시 보낼 정확한 wire 이력이다. 화면에 보이는
Chat 메시지도 Session이 아니다. 화면 메시지는 사용자 경험과 Artifact 참조를 위한 별도 projection이다.

### 2.3 Actor와 caller

모든 run에는 비용·동시성·감사 귀속을 위한 `actor`가 있다. Actor는 사용자, Project token,
Slack workspace, Telegram bot, Teams bot, Webhook, Schedule, A2A 같은 실행 주체를 구분한다.
`caller`는 모델에게 설명할 수 있는 사람 정보이며 `parameters.callerContext`를 켠 Version에만
전달된다. email은 caller context로 모델에 전달하지 않는다.

`ownerEmail`은 또 다른 축이다. 예를 들어 Slack actor는 workspace ID지만 생성 Artifact는 실제
사용자 갤러리에 귀속될 수 있다. 이때 actor를 email로 바꾸지 않고 별도의 `ownerEmail`을 쓴다.
Actor 정의는 [`actor.ts`](../src/domain/execution/actor.ts), 전달 규칙은
[`deps.ts`](../src/application/execution/deps.ts)가 소유한다.

## 3. 실행 아키텍처

### 3.1 전체 실행 흐름

대부분의 요청은 다음 흐름을 따른다.

```text
실행 표면
  → 인증·Project 접근·요청 검증
  → 실행할 Project와 Version 결정
  → runProject facade에서 Project 유형 dispatch
  → run bracket에서 모델 정책·비용·동시성·metric·Artifact 범위 설정
  → Memory recall
  → Skill·MCP·하위 Agent·builtin·dynamic capability 해석
  → OpenAI Agents SDK Agent + Runner
  → EngineChunk stream
  → 표면별 변환·저장·응답
  → Usage flush, Trace 종료, slot 해제, 비용 임계값 settle
```

실행 파사드는 [`runProject.ts`](../src/application/execution/runProject.ts)다. 새 실행 표면은 Project
유형을 직접 다시 판정하지 않고 다음 계약 중 맞는 것을 호출해야 한다.

- `streamProjectRun`: 이미지까지 포함해 모든 Project 유형을 chunk로 소비하는 표면
- `executeProjectStream` / `executeProject`: completion을 소비하며 image Project를 거절하는 표면
- `executeAgent`: agent Project만 허용하는 표면
- `generateImage`: image Project 전용 경로
- `executeWorkspaceTask`: Workspace worker용 별도 task 경로

### 3.2 run bracket

[`runBracket.ts`](../src/application/run/runBracket.ts)는 모든 최상위 run을 감싸는 정책 경계다.
admission 순서는 의미가 있으므로 바꾸면 사용자에게 보이는 오류와 기록이 달라진다.

1. 알 수 없는 모델 정책을 확인한다. 설정 읽기 실패는 기본 정책인 allow로 fail-open한다.
2. Project의 일간·월간 비용 한도를 확인한다. 저장소 장애는 fail-open한다.
3. 사용자 actor이면 member tier의 월간 비용 상한을 확인한다.
4. actor별 동시성 slot을 데이터베이스 lease로 획득한다. 저장소 장애는 fail-closed한다.
5. in-flight metric과 run correlation ID를 연다.
6. 최상위 run이면 Artifact recorder를 Project·Version·Actor·run ID에 묶는다.
7. 실행이 끝나면 Usage가 먼저 flush된다.
8. metric을 닫고 slot을 해제한 뒤 최신 Usage를 기준으로 비용 알림·차단 임계값을 settle한다.

거부된 run은 실행 metric, Usage, Trace를 남기지 않는다. 비용 가드는 이미 시작한 동시 run의
미정산 비용을 볼 수 없으므로 hard cap이 아니라 다음 admission을 막는 backstop이다. 반면 동시성
가드는 데이터베이스 장애 때 부하를 더하지 않도록 fail-closed한다.

### 3.3 OpenAI Agents SDK runtime

Studio는 Agent와 Tool loop를 직접 구현하지 않는다. [`src/application/runtime/`](../src/application/runtime/)
가 OpenAI Agents SDK의 `Agent`, `Runner`, `Session`, `RunState`, native tool event를 사용한다.

Studio가 runtime 전에 준비하는 것은 Version 설정, provider endpoint와 credential, 입력 guardrail,
PII mapping, 도구 schema validator, Skill과 MCP, 하위 Agent, 예산, Artifact recorder, local trace다.
SDK가 담당하는 것은 모델 턴, function tool 호출, MCP tool 호출, Handoff, Agent-as-Tool, 승인 중단과
재개다. SDK의 기본 public trace exporter는 사용하지 않으며, tracing은 로컬 DB 또는 명시적으로
설정한 OpenTelemetry exporter로만 나간다.

`llm` Project도 같은 SDK `Agent`/`Runner`를 단발성으로 사용한다. `agent` Project만 반복되는
도구 loop와 하위 Agent를 제공한다. 마지막 허용 턴에는 새 도구를 제공하지 않고 현재 정보로 답하게
하며, SDK의 `maxTurns`도 함께 적용한다.

모델 요청은 OpenAI Chat Completions 호환 프로토콜로 나간다. 모델 ID는 `provider/model` 형태다.
기본 채널 또는 provider별 채널이 endpoint, bearer credential, AWS SigV4 credential을 해석한다.
숨은 HTTP 재시도는 없다. 첫 출력 전에 발생한 재시도 가능한 429/5xx만 설정된 fallback 모델로
한 번 전환하며, 출력이 시작된 뒤에는 같은 요청을 반복하지 않는다.

공개 모델의 capability·가격·alias·수명 정보는 외부 `opspresso/agent-models` 카탈로그가 정본이다.
Studio는 loader shape와 지원 provider를 소유하고, 마지막으로 동기화한
[`catalog.json`](../src/domain/llm/catalog.json)을 폐쇄망 fallback으로 commit한다. 부팅 시 선택적인
원격 catalog와 admin이 업로드한 catalog 문서를 읽으며, 배포가 선언한 self-hosted model을 overlay한다.
Version 저장 검증, 모델 선택 UI, fallback 적합성, Usage 가격 계산은 이 동일한 registry view를 쓴다.

### 3.4 EngineChunk와 스트리밍

`EngineChunk`는 runtime과 표면 사이의 공통 stream 계약이다. 텍스트 delta, reasoning delta,
tool call과 result, usage, warning, error, termination, image, file, 승인 대기, 하위 Agent author와
transfer chain을 표현한다. 정의는 [`types.ts`](../src/domain/llm/types.ts)에 있다.

중요한 규칙은 다음과 같다.

- 최상위 chunk에는 `author`가 없고 하위 Agent chunk에만 `author`/`authorPath`가 있다.
- reasoning은 provider 재생 이력에는 항상 남지만 `reasoningTrace`가 켜진 Version만 독자에게 보낸다.
- image와 file은 서로 다른 출력 축이다. 소비자는 둘을 모두 확인해야 한다.
- file bytes는 모델 context에 다시 들어가지 않으며 저장 후 stream에서 제거된다.
- 손실은 warning이다. 예: 끊긴 transcript, 사용할 수 없는 binding, 저장 실패, 잘린 tool result.
- capability를 새로 발견한 것은 손실이 아니므로 warning이 아니라 log와 preview 정보다.
- 종료 이유는 `completed`, `turn-limit`, `output-limit`, `cancelled`, `error`로 구분한다.

SSE는 [`createSseResponse`](../src/app/api/_lib/sse.ts)가 첫 chunk를 짧게 기다린 뒤 응답을 시작한다.
이 grace 구간 덕분에 stream을 열기 전에 발생한 인증·검증·upstream 오류를 올바른 HTTP 상태로
응답할 수 있다.

### 3.5 실행 표면별 차이

| 실행 표면 | Version 선택 | 주요 출력 | 사용자 Workspace / Chat 승인 |
|---|---|---|---|
| 콘솔 Chat | published, 없으면 최신 draft 허용 | 영속 Chat stream | 지원 |
| Playground·Predict | 요청한 Project/Version 계약 | stream 또는 JSON | 사용자면 Workspace tool 가능, 영속 Chat 승인은 없음 |
| OpenAI `chat/completions` | API 계약의 Version | OpenAI 호환 stream/JSON | 없음 |
| Agent SSE | agent Version | raw `EngineChunk` SSE | 영속 Chat이 아니면 승인 UI 없음 |
| Project API token | URL에 명시한 Version | API 응답 | Workspace와 Chat 승인 미제공 |
| Slack·Telegram·Teams | published 전용 | 플랫폼 메시지 | 미제공 |
| Webhook·Schedule | published 전용 | Trigger run 기록 | 미제공 |
| A2A | 노출된 published Project | A2A task/event | 미제공 |
| AG-UI | 지정 Project | AG-UI event stream | frontend tool 지원, Studio Chat과는 별개 |
| Audio 후처리 | job 접수 시 고정한 Version | Artifact와 job 상태 | background task라 외부효과 도구 제한 |
| Workspace worker | Project 정책과 runtime 선택 | event·checkpoint·Git approval | 자체 승인 흐름, 연결된 원래 Chat 재개 가능 |

같은 Version을 실행해도 표면의 actor, credential, history, 승인 UI가 다르다. Skill이나 prompt로
이 경계를 넓힐 수 없다.

## 4. Capability, 검색, RAG, Memory

### 4.1 Skill의 progressive disclosure

Skill은 Markdown 지침과 선택적 참고 파일이다. 시스템 prompt에는 모든 Skill 본문을 넣지 않고
이름과 설명 표만 넣는다. 모델이 builtin `Skill` tool을 호출하면 `SKILL.md` 또는 `file_path`로
선택한 첨부를 읽는다. 이 progressive disclosure는 context를 줄이고 필요한 지침만 로드한다.

Skill 참고 파일은 허용 확장자, 파일 수, 파일별 크기와 Skill 전체 크기 제한을 따른다. 절대 경로,
`..`, 다른 Skill 디렉터리 접근, symlink는 거절한다. Skill과 관련 계약은
[`design/capabilities.md`](design/capabilities.md)와
[`src/domain/skill/`](../src/domain/skill/)가 소유한다.

### 4.2 MCP registry와 binding

MCP 서버는 전역 registry에 한 번 등록하고 여러 Version에서 bind한다. Version의 `McpBinding`은
다음 두 가지를 좁힐 수 있다.

- `tools`: 해당 서버에서 이 Version에 노출할 도구 목록
- `headers`: registry 기본 header 위에 덮어쓸 Project/Version별 값. 문자열은 추가·교체하고
  `null`은 기본값을 제거한다.

서버 URL은 항상 registry가 소유한다. Version별 secret header는 registry URL fingerprint와 함께
암호화되어, 같은 이름의 서버 URL이 바뀌었을 때 예전 credential이 새 endpoint로 전달되지 않는다.
MCP OAuth는 registry 항목을 공유하면서도 Project마다 별도 연결과 token을 가진다. Managed MCP는
선택적으로 Docker container를 띄우고 loopback으로 연결한다.

MCP의 network 요청은 등록과 dispatch 모두 URL policy를 통과한다. 공개 URL은 DNS resolution과
연결 대상을 고정해 SSRF와 DNS rebinding을 막는다. 내부 host는 배포가 명시적으로 선언한 suffix
또는 managed loopback provenance만 예외다.

### 4.3 Plugin sync

Agent Plugins 저장소나 업로드한 tar snapshot에서 `plugin.json`, `skills/*/SKILL.md`, `mcp.json`을
읽어 Plugin·Skill·MCP registry를 갱신할 수 있다. Plugin source는 provenance를 기록한다.

Sync는 저장소가 선언한 동일 이름의 항목을 갱신하지만 **삭제를 소유하지 않는다**. 사라진 항목은
orphan으로 보고하고, 실제 삭제는 사용자가 선택한 뒤 각 유스케이스의 권한·SSRF 검증을 거친다.
자동 sync가 레지스트리 참조를 조용히 끊지 않게 하기 위한 규칙이다.

### 4.4 글로벌 capability catalog와 dynamic discovery

선택 기능인 capability catalog는 모든 Skill, MCP server, MCP tool, 외부 Agent를 PostgreSQL의
`catalog_vectors`에 embedding한다. Project별 인덱스가 아니라 설치 전역 인덱스다. 실제 run이
사용할 수 있는 것은 Version binding과 Project의 OAuth 연결, tool cap, 정책을 dispatch 때 다시
적용해 결정한다.

검색 query는 Version의 system prompt와 최근 사용자 발화들이다. Memory가 회상된 경우 최신 요청과
관련 Memory를 함께 query 문맥으로 쓸 수 있다. Embedding 검색은 cosine similarity를 사용하고,
선택적으로 reranker가 후보를 재정렬한다. catalog를 재색인하는 동안 generation이 바뀐 검색 결과는
버려 서로 다른 embedding 공간을 섞지 않는다.

`parameters.dynamicCapabilities`가 켜진 Version만 catalog를 검색한다. 검색 결과는 명시적 binding을
대체하거나 밀어내지 않고 **추가만** 한다. OAuth 서버는 해당 Project가 이미 연결한 경우에만 자동
추가할 수 있다. catalog 장애는 run을 실패시키지 않고 명시적 binding만으로 계속하며 warning을 남긴다.

### 4.5 Agent Studio의 Memory recall

Agent Studio 내부의 장기 Memory 저장소는 없다. Memory는 `recall(query)` 도구를 제공하는 명시적으로
bind된 MCP 서버가 소유한다. `parameters.memoryRecall`이 켜진 agent run은 첫 모델 token 전에 다음을
수행한다.

1. Version에 명시적으로 bind된 MCP 서버 중 `recall` 도구를 제공할 수 있는 서버만 고른다.
2. 최신 사용자 텍스트를 최대 2,000자 query로 만들어 대상 서버를 병렬 호출한다.
3. 호출 하나가 10초를 넘으면 해당 Memory 없이 계속한다.
4. 성공 결과를 합치고 전체 최대 4,000자로 제한한다.
5. 회상 결과를 system prompt의 별도 Memory 블록으로 넣는다.
6. 같은 회상 결과를 dynamic capability discovery query에도 반영할 수 있다.

자동 recall은 dynamic discovery로 우연히 찾은 서버가 아니라 저자가 Version에 명시적으로 bind한
서버만 호출한다. `blockedTools` 또는 `approvalTools` 정책에 걸린 `recall`은 자동 실행하지 않는다.
background task도 개인 Memory를 자동 recall하지 않는다. 서버 실패, 빈 query, recall 대상 부재는
run 실패가 아니라 warning이다. 사용자가 run을 취소한 경우만 즉시 cancellation으로 전파한다.

Memory recall의 단일 소유자는
[`memoryRecall.ts`](../src/application/execution/memoryRecall.ts)이며, tool 이름 `recall`은
[`memoryRecall.ts`](../src/domain/project/memoryRecall.ts)가 소유한다.

## 5. Chat, Session, 승인, 재연결

Studio Chat은 소유자별 비공개 대화다. 다른 사용자가 존재 여부를 추측하지 못하도록 비소유자에게
404로 응답한다. 한 Chat에는 서로 다른 목적의 저장이 함께 존재한다.

- Chat row: 제목, Project, 선택된 Workspace, 활성 run lease, message sequence
- Chat message row: 화면에 보일 사용자·assistant·tool 기록과 Artifact 참조
- `runtime_sessions`: SDK가 다음 턴에 재생할 정확한 모델·도구 이력과 pending `RunState`
- run log: 연결이 끊긴 클라이언트가 짧은 기간 동안 따라잡는 bounded replay buffer

화면용 Chat message를 다시 조립해 모델 history로 사용하지 않는다. native SDK Session이 유일한
모델 replay 원본이다. reasoning도 화면용 합쳐진 텍스트를 모델 턴으로 재구성하지 않고 원래 SDK
model turn에 유지한다.

Session payload는 압축 후 context-bound AES 암호화하여 `runtime_sessions`에 저장한다. history와
pending approval checkpoint는 owner-scoped revision compare-and-swap으로 함께 commit한다. 승인
재개는 정확한 revision과 decision ID를 확인하고 checkpoint를 먼저 claim한 뒤 side effect를 실행한다.
claim 후 process가 죽으면 결과가 불확실하므로 자동 재생하지 않는다.

Chat run은 시작한 HTTP 연결보다 오래 산다. 브라우저가 떠나도 server run을 abort하지 않고 stream을
run log로 drain하며, reconnect한 클라이언트가 replay한 뒤 live tail을 따른다. 명시적 Stop은
영속 cancellation으로 기록하고 실행 측이 model chunk가 없는 동안에도 polling한다.

run 종료 순서는 **메시지 persist → terminal log entry → run lease release**다. lease 해제는
[`runLog.ts`](../src/application/chat/runLog.ts)만 수행한다. Chat 계약은
[`src/application/chat/AGENTS.md`](../src/application/chat/AGENTS.md)와
[`design/chat.md`](design/chat.md)에 있다.

## 6. 문서, 이미지, 파일, Artifact

### 6.1 입력 첨부

이미지는 지원 MIME과 크기·개수 제한을 확인한 뒤 inline data URL로 모델에 전달한다. remote URL을
provider가 직접 가져오게 하지 않는다. 이미지 입력을 지원하지 않는 모델에는 조용히 버리지 않고
요청을 거절한다.

문서 첨부는 `DocumentExtractor`가 텍스트만 추출한다. 추출문은 파일명과 경계를 표시하는 frame으로
감싸며, 문서 내용을 지시가 아니라 신뢰하지 않는 데이터로 취급하라고 모델에 알린다. 이는 prompt
injection의 완전한 해결이 아니므로, 첨부를 읽는 Agent에는 낯선 사용자가 행사하면 안 되는 권한을
주지 않아야 한다. HTML 첨부는 script나 외부 resource를 실행하지 않고 텍스트로 읽는다.

### 6.2 출력 파일

Agent는 builtin `File` 도구로 보관된 파일을 읽고 검사하며 DOCX·PDF·HWPX·PPTX·XLSX를 생성할 수
있다. 지원되는 원본 편집은 기존 파일을 덮지 않고 새 파일을 만든다. Markdown·CSV·JSON·HTML·SVG
같은 text 기반 파일은 `SaveFile` 경로를 사용한다. 문서 worker는 제한된 child process로 실행된다.

`EngineChunk.image`와 `EngineChunk.file`은 별개다. run bracket의 Artifact recorder가 최상위에서
모든 producer의 bytes를 캡처한다. 파일 bytes는 모델 context에 넣지 않으며, 저장 후 주소 가능한
참조만 소비자에게 남긴다. object store가 없거나 저장에 실패하면 live bytes는 응답할 수 있어도
영속 다운로드가 없다는 warning을 남긴다.

### 6.3 Artifact 보관과 읽기

Artifact metadata는 PostgreSQL에, bytes는 선택적 S3 호환 object store에 둔다. 기본 설치형 접근은
`proxied`이며 앱이 HMAC token이 있는 제한 시간 URL을 발급한다. `authenticated`는 S3 pre-signed
URL, `public`은 명시적으로 공개한 bucket의 직접 URL이다.

사람이 읽는 HTML·SVG·text를 일반 콘솔 origin에서 그대로 실행하지 않는다. `/view`는 매 요청을
인가하고 CSP sandbox가 적용된 opaque origin 문서로 응답한다. HTML 실행 preview도 격리 iframe에서
실행하며 console cookie, storage, DOM, 외부 network와 privileged API를 주지 않는다. 정적 view는
script를 실행하지 않는다.

Artifact metadata TTL과 object lifecycle은 서로 다른 운영 주체다. 운영자는 `artifacts/image/`,
`artifacts/document/`, legacy `images/` prefix의 lifecycle을 retention과 맞춰야 한다. private
source file은 일반 object URL 경로로 읽을 수 없고 전용 소유권 검사를 거친다.

상세 계약은 [`design/documents.md`](design/documents.md),
[`design/execution.md`](design/execution.md), [`SECURITY.md`](SECURITY.md)에 있다.

### 6.4 Audio pipeline

Audio는 긴 파일 가져오기·전사·후처리를 web request나 Agent run 안에서 끝내지 않고 영속 job으로
처리한다. Agent가 `ImportFile`, `TranscribeAudio`, `AudioJob` builtin으로 작업을 접수하면 별도
Audio worker가 PostgreSQL queue를 claim해 원본 import, 선택한 transcription model 호출, 선택적
Agent 후처리, 결과 저장, cleanup을 이어간다. Project별 queue는 접수 순서대로 한 건씩 실행하며,
lease·heartbeat·checkpoint·retry를 통해 worker 재시작 뒤에도 이미 끝난 단계를 재사용한다.

원본과 전사·요약·대화·구조화 결과는 S3 호환 store의 private `source-files/` 영역과 Artifact
metadata에 보관한다. 일반 Artifact URL로 private source bytes를 읽을 수 없고, 소유자·Project
접근·파일 상태·만료를 매번 확인한다. 파생 파일의 보존 기한은 원본보다 늦을 수 없다. 만료 뒤에는
자동 재다운로드하지 않으며, 외부 sink 저장 receipt와 완료 claim은 남겨 중복 side effect를 막는다.

후처리는 job 접수 때 실제 Version snapshot을 고정해 `streamProjectRun`과 공통 run bracket을
사용한다. background task에는 새 Audio job 생성, MCP write, dynamic discovery, 사전 Memory recall,
하위 Agent 같은 재귀·외부효과 capability를 제공하지 않는다. Agent Memory Documents나 장기 Memory에
개인 결과를 쓰는 작업은 검증된 email과 기존 MCP 인증을 사용하고, 사용자가 요청한 경우에만 수행한다.
Audio 전체 계약은 [`design/audio-processing-spec.md`](design/audio-processing-spec.md)에 있다.

## 7. Workspace와 Sandbox

Workspace는 코드·파일·데이터·자동화 작업의 **영속 상태**이고, Sandbox는 작업을 실행하는
**일시적 격리 자원**이다. Workspace는 command, Codex, Claude, OpenCode 같은 runtime과 native
Session, 파일 checkpoint, Git 상태, 작업 event를 보관한다. 별도 worker가 DB queue를 polling해
작업을 실행하므로 `pnpm dev`만으로는 Workspace 작업이 실행되지 않는다.

Agent Version에서 `parameters.workspaceTools`를 켜도 모든 actor가 Workspace를 얻는 것은 아니다.
로그인한 member/admin의 Agent 실행에서만 현재 Project 접근과 멤버 권한을 다시 확인해 builtin을
제공한다. Project API token, 메신저, Webhook, Schedule, background task에는 제공하지 않는다.

Project별 Workspace 정책은 허용 repository, owner 범위, 기본 runtime, idle 시간, 검사 명령,
배포 workflow를 관리한다. GitHub MCP 연결과 Workspace server의 Git credential은 별개다. Project
정책은 권한을 늘리지 않으며 실제 GitHub 계정이 접근할 수 있는 범위 안에서만 동작한다.

Git side effect는 단계별 승인 대상이다.

- commit
- push
- commit과 push
- pull request 생성 또는 상태 전환
- main fast-forward push
- pull request merge
- 허용된 deployment workflow 실행

승인 화면의 잘린 diff가 아니라 전체 Git tree와 HEAD fingerprint를 다시 확인한다. 응답 유실처럼
외부 효과 결과를 모르는 경우 `uncertain`으로 남기고 자동 재실행하지 않는다. 한 승인으로 다음
단계까지 묶어 승인하지 않는다.

Workspace에서 시작된 승인이 원래 Chat과 연결되어 있으면 결과를 같은 Chat에 영속적으로 알리고,
원래 SDK Session으로 Agent를 재개할 수 있다. 새 사용자 메시지를 만들거나 Git 동작을 다시 실행하지
않는다. CI가 pending이면 정확한 PR head를 제한 시간 동안 polling한 뒤 결과를 다시 전달한다.

Workspace의 전체 계약은 [`design/workspaces.md`](design/workspaces.md)에 있다.

## 8. 외부 실행과 통합

### 8.1 Project API

Project별 bearer token은 그 Project 실행으로만 범위가 한정된다. token은 Project 소유자로서
인증하지만 브라우저 Session, Workspace 권한, Chat 승인 UI는 제공하지 않는다. 소유자의 현재 member
tier가 API token을 허용하는지 매 요청 다시 확인한다.

주요 실행 endpoint는 Predict, OpenAI 호환 Chat Completions, raw Agent SSE다. 이미지 Project는
Predict에서 생성·편집할 수 있지만 Chat Completions에는 이미지 completion 형태가 없어 거절된다.

### 8.2 Slack, Telegram, Teams

각 agent Project는 자기 bot credential과 endpoint를 가진다. 공통 messaging pipeline은 입력을
claim하고 빠르게 ack한 뒤 background에서 Agent를 실행하고, 한 메시지를 편집하거나 native stream으로
답하며 결과를 settle한다.

- Slack은 thread history를 읽고 native streaming을 사용할 수 있다. private Project는 sender의
  Slack email을 접근 판정에만 사용하며 prompt로 보내지 않는다.
- Telegram은 private chat의 모든 메시지, group의 mention과 reply에 답한다. 플랫폼 history가
  없으므로 Studio가 bounded transcript를 보관한다.
- Teams는 Bot Framework token의 signature, issuer, audience, tenant와 `serviceUrl`을 검증한다.
  Telegram과 마찬가지로 bounded transcript를 보관한다.

메신저 delivery dedup은 중복 실행을 막지만, process가 background run 중 급사했을 때 비멱등 run을
자동 재생하지 않는다.

### 8.3 Webhook과 Schedule

Webhook trigger는 secret, request body limit, `Idempotency-Key`를 검증하고 즉시 202로 응답한 뒤
published Version을 background에서 실행한다. GitHub webhook은 HMAC signature와 delivery ID를
사용한다. Schedule trigger는 외부 ticker가 scan endpoint를 호출해야 발화한다.

Schedule occurrence는 조건부 claim으로 중복에 안전하다. scan은 최대 10분의 missed window를
복구하고 한 tick에서 동시 발화를 제한한다. Webhook과 Schedule actor는 사용자 Session이 아니며
Workspace 권한을 얻지 않는다.

### 8.4 A2A와 AG-UI

A2A는 Project를 다른 Agent가 호출할 수 있는 Agent Card와 task/event 인터페이스로 노출하고,
외부 Agent도 Studio의 하위 Agent registry에 연결한다. private Project의 unauthenticated Agent
Card는 404로 숨긴다. A2A client key는 tenant/client 범위와 task 목록을 분리한다.

AG-UI는 Studio run의 `EngineChunk`를 AG-UI event로 변환한다. frontend tool은 calling app이
실행하고 결과를 다음 run의 tool message로 돌려준다. frontend tool 호출이 있는 턴은 Studio run을
끝내며 하위 Agent에는 frontend tool을 전달하지 않는다.

## 9. 데이터와 영속성

### 9.1 PostgreSQL 하나가 기본 영속 인프라다

Agent Studio의 필수 영속 인프라는 pgvector extension이 있는 PostgreSQL 하나다. 부팅 시
[`migrations.ts`](../src/infrastructure/db/migrations.ts)가 advisory lock 아래에서 멱등 migration을
적용한다. 주요 저장 영역은 네 가지다.

| 저장 영역 | 내용 |
|---|---|
| `items` | Project, Version, registry, Chat display, Usage, Trace, Trigger, Workspace metadata 등 |
| Better Auth tables | `user`, `session`, `account`, `verification` |
| `catalog_vectors` | capability embedding과 metadata |
| `runtime_sessions` | 암호화된 SDK Session history와 approval checkpoint |

선택적 S3 호환 object store는 Artifact, 첨부 원본, private source file을 보관한다. Workspace와
Audio는 별도 worker가 필요하지만 상태 원장은 같은 PostgreSQL에 둔다.

### 9.2 items의 단일 테이블 패턴

`items`는 `pk`, `sk`, JSONB `data`와 JSONB에서 파생한 GSI column, `expires_at`을 쓴다. Project와
자식 Version·Trigger·연결은 같은 partition, Chat과 message·run log는 같은 partition에 둔다.
종류별 목록, 소유자별 목록, 시간순 sweep은 희소 GSI를 쓴다.

모든 row key 문자열은 [`keys.ts`](../src/infrastructure/db/keys.ts)가 만든다. repository는
[`store.ts`](../src/infrastructure/db/store.ts)의 key-addressed store를 사용하며 `items`에 raw SQL을
쓰지 않는다. 조건부 write는 row lock 아래 평가하고, 여러 row transaction은 key 순서로 잠가
deadlock을 막는다.

예외적으로 전용 table을 쓰는 이유는 명확하다. Better Auth는 자기 schema와 unique constraint를
소유하고, vector는 pgvector 연산이 필요하며, SDK Session은 item row보다 큰 inline image 상태와
history/checkpoint 원자성이 필요하다.

### 9.3 보존과 삭제

증가하는 row는 `expiresAt`을 가진다. PostgreSQL native TTL이 아니라 schedule scan tick에 붙은
`sweepExpiredRows`가 삭제한다. 읽는 쪽도 만료 row를 filter하므로 sweep 지연이 사용자에게 보이지
않는다. `SCHEDULE_SCAN_TOKEN`과 ticker가 없으면 만료 row는 자동 삭제되지 않는다.

Project 삭제는 먼저 live row를 `deletingAt` 상태로 바꿔 새 자식 write를 막고, 관련 partition과
index를 정리한 뒤 이름 tombstone을 남긴다. Artifact와 Chat처럼 Project보다 오래 사는 데이터가
이름으로 연결되므로 삭제한 Project 이름을 재사용하지 않는다.

## 10. 보안 모델

### 10.1 인증과 멤버 tier

인증은 Better Auth 위에서 Keycloak, 표준 OIDC, Google, email/password 중 배포가 켠 방법을 쓴다.
`alpha`와 `prod`는 로그인 수단과 `ADMIN_EMAILS`가 없으면 부팅을 거부한다. password 가입 폼은 없고
bootstrap admin과 관리자가 만든 계정만 사용한다.

멤버 tier는 `admin`, `member`, `guest`다. 기본 tier는 `guest`다. 현재 기본 정책에서 guest는
Project 생성과 API token 사용이 금지되고 동시 run 1개, UTC 월 $2 상한을 가진다. member는 월 $20
상한을 가지며 배포 전역 동시성 한도를 사용한다. admin은 tier 자체의 비용 상한이 없다. 이 값과
capability 판정은 [`tiers.ts`](../src/domain/member/tiers.ts)가 단독 소유한다.

페이지 gate와 API gate는 분리되어 있다. [`proxy.ts`](../src/proxy.ts)는 비로그인 페이지 접근을
login으로 redirect하고, 실제 API는 `withAuth`, `withMemberAuth`, `withAdminAuth`와 각 resource
유스케이스가 401·403·404를 결정한다. UI에서 링크를 숨기는 것은 인가가 아니다.

### 10.2 Project visibility와 쓰기 권한

public Project는 로그인한 사용자가 읽고 실행하고 clone할 수 있다. private Project는 소유자,
초대된 `memberEmails`, configured admin만 접근한다. 쓰기는 visibility와 무관하게 소유자 또는
configured admin만 가능하다. 접근 판정의 정본은
[`access.ts`](../src/domain/project/access.ts)와 Project 유스케이스다.

`isAdminEmail`과 `isConfiguredAdmin`은 다르다. `ADMIN_EMAILS`가 비어 있는 local 설치에서 전자는
공유 registry와 설정 변경을 fail-open하지만, 후자는 다른 사람 Project 쓰기를 누구에게도 허용하지
않는다. Project 소유권 검사에 전자를 사용하면 안 된다.

### 10.3 시크릿

MCP·외부 Agent header, OAuth token과 client secret, 메신저 bot credential, Project token,
Trigger secret, A2A key, 민감한 runtime setting은 `AES_ENCRYPTION_KEY`로 AES-256-GCM 암호화한다.
새 암호문은 row와 field identity를 AAD로 묶어 다른 위치로 옮기면 인증에 실패한다.

API read는 secret을 mask한다. masked 또는 빈 update는 기존 값을 보존하며, 저장된 counterpart가
없는 mask는 secret을 만들지 않는다. reveal endpoint는 더 좁은 권한과 audit를 요구한다. 유출된
secret은 코드로 고쳐 쓰지 않고 rotate한다.

### 10.4 아웃바운드 네트워크와 PII

운영자가 등록한 URL과 모델이 선택한 URL 모두 outbound guard를 거친다. `FetchUrl`은 Version별
opt-in이며 private·loopback·link-local·metadata 주소, 위험한 redirect, DNS rebinding을 거절한다.
MCP나 provider처럼 운영자가 명시한 내부 host만 별도 선언으로 허용한다.

PII filtering은 Version opt-in이다. model request에서 email, 전화번호, 한국 주민등록번호, 카드
번호를 placeholder로 mask하고 tool dispatch와 사용자 표시 경계에서 복원한다. 사람 이름 전체를
해결하는 DLP가 아니며, 저장되는 Chat content와 reasoning, Artifact prompt excerpt를 익명화하는
기능도 아니다. reasoning trace와 첨부 문서는 민감 정보가 남을 수 있으므로 별도 보존 위험으로
다뤄야 한다.

## 11. 관측성, 비용, 감사

### 11.1 Usage와 비용

Usage는 모델 호출별 input/output/cached/reasoning token과 cost를 모아 Project·actor·member의 UTC
일 단위 row에 기록한다. provider가 실제 청구 비용을 주면 그것을 보존하고, 없으면 model catalog
가격으로 계산한다. 알 수 없는 모델은 정책에 따라 실행 허용 또는 거절할 수 있으며, 허용된 경우
catalog에 가격이 생기기 전까지 $0으로 집계될 수 있다.

Project 비용 정책은 UTC 일간·월간 warning과 blocking threshold를 독립적으로 가진다. threshold
알림은 Project의 Slack·Telegram·Teams destination으로 한 번만 보낸다. 알림 destination이 없어도
blocking은 계속 적용된다.

### 11.2 Trace

Trace는 run과 준비 단계, SDK span, 하위 Agent 관계, token, 비용, latency, warning과 error를
기록한다. 원본 prompt와 tool result 전체를 Trace에 저장하지 않는다. sampling은 run 시작에서
결정하며, child trace는 transfer 관계로 연결한다. Trace가 꺼져도 run ID와 tool call scope는
독립적으로 유지된다.

### 11.3 Audit, log, metric

Audit은 관리자 override, secret reveal, member tier 변경, registry와 설정 변경 같은 보안상 중요한
행위를 영속 row로 기록한다. process-wide audit sink는 서버가 요청을 받기 전에
[`instrumentation.ts`](../src/instrumentation.ts)에서 await하여 연결한다.

일반 log는 [`logger.ts`](../src/shared/logger.ts)를 통하고 run correlation ID를 포함한다. prompt
본문은 log에 넣지 않는다. `/api/metrics`의 label은 cardinality가 제한되어 Project, 사용자, 모델을
직접 label로 쓰지 않는다.

## 12. 부팅, 오프라인, 운영

### 12.1 필수와 선택 의존성

실제 서버 부팅에 필요한 핵심 값은 `DATABASE_URL`, `LLM_BASE_URL`, `LLM_API_KEY`, 32-byte base64
`AES_ENCRYPTION_KEY`다. production은 `STAGE`를 명시해야 한다. `alpha`·`prod`는 `ADMIN_EMAILS`와
로그인 방법 하나도 필요하다.

필수 경로는 다음 내부 대체물을 사용할 수 있다.

| 경로 | 폐쇄망 구성 |
|---|---|
| 데이터 | 사내 PostgreSQL + pgvector |
| 로그인 | 사내 Keycloak/OIDC 또는 local password 계정 |
| 모델 실행 | 사내 OpenAI 호환 gateway, vLLM, Ollama, LM Studio |
| Artifact | 사내 MinIO, Ceph RGW 또는 생략 |
| Skill/MCP 배포 | 업로드한 Plugin tar, 내부 MCP server, managed MCP |
| embedding/rerank/transcription | 내부 OpenAI 호환 endpoint 또는 기능 비활성 |

새 필수 기능이 public host를 직접 호출하면 제품 정체성을 위반한다. 외부 기능은 port 뒤의 선택
adapter로 두고, 설정되지 않았을 때 어떤 기능만 꺼지는지 명시해야 한다.

### 12.2 부팅 순서

Node runtime의 [`instrumentation.ts`](../src/instrumentation.ts)는 요청 수신 전에 다음을 수행한다.

1. 필수 환경과 접근 제어 설정을 검증한다.
2. graceful shutdown signal handler를 등록한다.
3. advisory lock 아래 DB migration을 적용한다.
4. 필요한 경우 bootstrap admin을 만든다.
5. audit sink를 연결하고 실제 연결 여부를 확인한다.
6. 저장된 문서와 선택적 원격 source에서 model catalog를 갱신하고 refresher를 시작한다.
7. composition root를 비동기로 로드해 managed MCP reachability를 복구한다.

managed MCP reconcile은 image pull과 restart에 오래 걸릴 수 있으므로 listen을 막지 않는다. catalog
원격 갱신 실패도 committed offline snapshot을 유지하고 부팅을 막지 않는다.

### 12.3 health, ready, shutdown

`/api/health`는 process liveness를 답하고, `/api/ready`는 DB와 필요한 downstream readiness를
확인한다. 배포 health check는 liveness를 사용해야 하며, traffic 수신 판단은 readiness를 사용한다.
shutdown 시 새 run admission을 막고 진행 중인 작업이 drain될 시간을 준다.

### 12.4 ticker와 worker

운영에는 별도 반복 호출과 worker가 필요하다.

- 최대 1분 간격 schedule scan: schedule 발화, TTL sweep, 일부 stuck trigger repair
- 주기적 catalog reindex: registry를 `catalog_vectors`와 동기화
- Plugin sync scan: repository head 변경을 registry에 반영
- Audio worker: source download, transcription, postprocess, Artifact 저장
- Workspace worker: Sandbox lifecycle, native operation, checkpoint, approval continuation, CI watch

ticker와 worker는 web process의 우연한 background timer로 대체하지 않는다. 여러 instance가 같은
DB를 공유할 수 있지만 managed MCP는 host loopback port를 공유하므로 host당 app instance 하나를
전제로 한다.

## 13. 코드 구조와 의존 방향

Agent Studio는 Next.js 16 App Router, React 19, TypeScript strict, Mantine, Node.js 24, pnpm 11을
사용하는 단일 full-stack application이다. 핵심 의존 방향은 다음과 같다.

```text
app → application → domain ← infrastructure
               ↓
          dependency-free shared

lib = config, auth, runtime settings, composition root 같은 server glue
```

### 13.1 계층별 책임

| 경로 | 책임 | 금지 사항 |
|---|---|---|
| `src/domain/` | entity, value rule, repository port, 단일 소유 상수 | framework, AWS, infrastructure, shared import |
| `src/application/` | use case, orchestration, execution facade, runtime policy | composition root와 infrastructure import |
| `src/infrastructure/` | PostgreSQL, object store, LLM, MCP, network, crypto, GitHub adapter | app/application import, 직접 `process.env` 읽기 |
| `src/app/` | page, route handler, UI, HTTP/SSE framing | infrastructure 직접 import, route에서 repository 선택 |
| `src/lib/` | config, auth, session, runtime setting, wiring | application이 composition root를 import하는 것 |
| `src/shared/` | 의존성 없는 범용 helper | `@/` 내부 import |

`"use client"` 파일은 application 또는 infrastructure runtime value를 import하지 않는다. type-only
import는 허용된다. Console 번역은 `en.ts`가 key source이고 `ko.ts`가 typed catalog다.

### 13.2 composition site

주요 composition root는 [`container.ts`](../src/lib/container.ts)다. repository, cipher, URL policy,
LLM·image channel, MCP session, registry use case, 실행 deps, Chat deps, Trigger deps, Workspace deps를
조립한다. 실행 표면의 요구가 달라 다음 site도 제한적으로 wiring한다.

- `src/app/api/chats/_deps.ts`
- `src/app/api/slack/events/_lib/`
- `src/app/api/telegram/webhook/_lib/`
- `src/app/api/teams/messages/_lib/`
- `src/app/api/a2a/[name]/route.ts`
- `src/instrumentation.ts`

의존 규칙과 wiring site 목록은 [`architecture.test.ts`](../tests/architecture.test.ts)가 강제한다.
실패했을 때 allowlist를 넓혀 통과시키지 말고 import와 소유 위치를 고쳐야 한다.

### 13.3 중요한 코드 진입점

| 질문 | 먼저 볼 코드 |
|---|---|
| Project 유형별 실행은 어디서 갈리는가 | `src/application/execution/runProject.ts` |
| Agent/Tool/SDK event는 어디서 처리하는가 | `src/application/runtime/` |
| run 공통 정책은 어디에 있는가 | `src/application/run/runBracket.ts` |
| Version이 실행 입력으로 어떻게 변환되는가 | `src/application/execution/deps.ts` |
| Skill·MCP·Agent binding과 discovery는 어디서 해석하는가 | `src/application/execution/bindings.ts` |
| 자동 Memory recall은 어디서 하는가 | `src/application/execution/memoryRecall.ts` |
| Chat run과 저장은 어디서 조율하는가 | `src/application/chat/run.ts` |
| SDK Session과 approval checkpoint는 어디서 관리하는가 | `src/application/runtime/session.ts` |
| Project 접근 판정은 어디에 있는가 | `src/domain/project/access.ts`, `src/application/project/projectUseCases.ts` |
| DB row key와 condition write는 어디에 있는가 | `src/infrastructure/db/keys.ts`, `store.ts` |
| 앱 전체 dependency wiring은 어디에 있는가 | `src/lib/container.ts` |
| 환경변수 파싱과 boot guard는 어디에 있는가 | `src/lib/config.ts`, `src/instrumentation.ts` |
| SSRF 방어는 어디에 있는가 | `src/domain/security/`, `src/infrastructure/net/` |
| Artifact 주소와 view 격리는 어디에 있는가 | `src/infrastructure/storage/`, `src/app/api/artifacts/` |
| Workspace 상태와 worker는 어디에 있는가 | `src/application/workspace/`, `src/infrastructure/workspace/`, `scripts/workspace-worker.ts` |
| HTTP 요청/응답 계약은 어디에 있는가 | `src/app/api/`, `docs/API.md` |

## 14. 개발과 검증

기본 개발 명령은 다음과 같다.

```bash
pnpm dev
pnpm typecheck
pnpm test
pnpm test:integration
pnpm build
```

lint 단계는 없다. `tsconfig.json`의 strict 설정과 `noUncheckedIndexedAccess`, unused 검사,
implicit return, override, switch fallthrough, `verbatimModuleSyntax`가 정적 품질 gate 역할을 한다.

단위 테스트는 Vitest를 사용하고 실제 network, clock, timer, randomness를 경계에서 mock한다.
repository 통합은 이름이 `_test`로 끝나는 전용 PostgreSQL에서만 실행한다. route signature와
instrumentation, production bundling이 바뀔 수 있으면 `build`가 필요하다. 문서 worker, HTML
preview, Audio, Workspace, Sandbox, Git 승인에는 각각 실제 child process·Chromium·Docker·MinIO를
사용하는 별도 검사가 있다.

현재 GitHub Actions의 `verify` job은 pull request와 release tag에서 다음 순서로 실행된다.

```text
dependency install → typecheck → unit test → PostgreSQL integration
```

tag release는 이 검증 뒤 Dockerfile로 `pnpm build`를 실행해 standalone app·문서 worker·Audio
worker·Workspace worker가 포함된 application image와 별도 Workspace Sandbox image를 빌드하고,
ECR·GHCR에 게시한 뒤 GitOps repository에 배포 event를 보낸다. 로컬에서 route signature,
instrumentation, production bundle까지 확인하려면 `pnpm build`를 별도로 실행해야 한다.

새 기능과 bug fix에는 focused regression test를 추가한다. `tests/architecture.test.ts` 실패는 구조
회귀이므로 규칙을 느슨하게 하지 않는다.

## 15. 설계상 의도적인 비목표와 주의점

- 멀티테넌시를 제공하지 않는다. 설치 단위가 기업 경계다.
- 자체 장기 Memory 저장소를 만들지 않는다. Memory는 MCP 서버의 책임이다.
- OpenAI Agents SDK와 경쟁하는 두 번째 Agent loop를 만들지 않는다.
- public internet을 필수 경로로 만들지 않는다.
- Plugin sync가 registry 삭제를 자동 수행하지 않는다.
- Slack·Telegram·Teams background run의 급사 후 자동 재실행을 제공하지 않는다. run이 비멱등이기
  때문에 중복 side effect보다 사용자에게 보이는 실패를 택한다.
- 설정과 member tier의 instance 간 즉시 invalidation을 제공하지 않는다. cache TTL만큼 전파가
  지연될 수 있다.
- Project 비용 guard는 이미 진행 중인 동시 run까지 합친 hard spending cap이 아니다.
- PII filtering은 저장 데이터 전체의 익명화나 범용 DLP가 아니다.
- 공개되었던 object URL을 metadata 변경만으로 소급 비공개화할 수 없다. bucket policy가 소유한다.
- API token이나 메신저 actor에게 브라우저 사용자 Workspace 권한을 암묵적으로 부여하지 않는다.

## 16. 용어 사전

| 용어 | 뜻 |
|---|---|
| Control Plane | Version, 정책, binding, credential, 비용, 저장을 준비하는 Studio 영역 |
| Runtime | SDK가 Agent turn과 Tool 실행을 실제로 진행하는 영역 |
| Project | 사용자가 만들고 호출하는 Agent Studio의 제품 단위 |
| Version | Project의 실행 구성. prompt, model, policy, capability binding의 묶음 |
| Publish | Project의 `publishedVersion` 포인터를 특정 Version에 연결하는 행위 |
| Binding | Version이 registry capability를 사용하도록 명시적으로 연결한 설정 |
| Dynamic discovery | 전역 vector catalog에서 현재 요청에 맞는 capability를 run 시점에 추가 검색하는 기능 |
| Memory recall | bind된 MCP의 `recall`을 첫 token 전에 호출해 장기 지식을 prompt에 넣는 기능 |
| SDK Session | Chat의 정확한 model/tool replay history와 approval state |
| Display message | UI에 보이는 Chat projection. SDK Session의 대체물이 아님 |
| Run bracket | 모든 최상위 run의 모델 정책, 비용, 동시성, metric, Artifact 경계 |
| EngineChunk | runtime이 모든 표면에 전달하는 공통 streaming unit |
| Artifact | run이 생성했거나 사용자가 첨부해 metadata와 object로 보관하는 결과물 |
| Workspace | 파일·Session·Git 상태를 보존하는 영속 작업 공간 |
| Sandbox | Workspace task를 실행하는 일시적 격리 환경 |
| Actor | 비용·동시성·감사에서 run을 귀속하는 실행 주체 |
| Caller | Version이 opt-in했을 때만 모델에게 설명하는 실제 요청자 문맥 |
| Wiring site | application use case와 infrastructure adapter를 실제 instance로 조립하는 제한된 위치 |

## 17. 변경 전 확인 질문

Agent Studio를 수정하는 에이전트는 다음 질문으로 변경 위치와 위험을 좁힌다.

1. 이 변경은 `domain`, `application`, `infrastructure`, `app`, `lib`, `shared` 중 어디의 결정인가?
2. 같은 상수, wire shape, key, cap, formatter, error identity가 이미 `OWNERSHIP.md`에 있는가?
3. 새 실행 진입점이 `runProject` facade와 run bracket을 통과하는가?
4. Project 유형, published/draft 선택, actor, caller, ownerEmail을 올바르게 보존하는가?
5. 새로운 외부 연결이 필수 오프라인 경로를 깨는가? 설정되지 않았을 때 손실을 보고하는가?
6. list가 무한히 자랄 수 있다면 `limit`, cursor, expiry pre-filter가 있는가?
7. secret은 identity-bound encryption, mask-preserving update, reveal audit를 따르는가?
8. URL은 등록과 dispatch 모두 SSRF guard를 통과하는가?
9. Chat display, SDK Session, Memory, Workspace checkpoint를 서로 대체하고 있지 않은가?
10. image와 file, top-level과 child chunk, reasoning emission과 provider replay를 모두 구분하는가?
11. side effect 결과가 불확실할 때 자동 replay하지 않는가?
12. focused regression, typecheck, unit test, 필요하면 integration과 build를 실행했는가?

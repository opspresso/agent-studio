# 아키텍처

Agent Studio의 계층, 저장 구조, 실행 경로와 스트림 계약을 설명한다.
제품 개념은 [시스템 개요](AGENT_STUDIO.md), 실제 요청 형태는 [API](API.md),
설정값은 [CONFIGURATION](CONFIGURATION.md), 시각적 흐름은 [DIAGRAMS](DIAGRAMS.md)를 보라.

코드를 처음 읽는다면 [요청 흐름](#요청-흐름)에서 사용할 진입점을 찾고,
[`runProject.ts`](../src/application/execution/runProject.ts)와 필요한 [서브시스템](#서브시스템)을
따라간다. 상수·형태·정책의 소유 파일은 [OWNERSHIP](OWNERSHIP.md)이 안내한다.

## 무엇을 위한 시스템인가

한 설치가 한 기업인 설치형 AgentOps 플랫폼이다. Studio는 프로젝트·버전·권한·도구·비용·기록을
관리하고 OpenAI Agents SDK는 기본 Agent Runtime을 제공한다. 공개 인터넷이 없는 환경에서도
필수 경로가 동작하도록 외부 연결은 배포가 선택하는 어댑터로 둔다.

| 필수 경로 | 내부 구성 |
|---|---|
| 부팅·상태 | PostgreSQL + pgvector; 부팅 시 migration |
| 로그인 | 사내 Keycloak·표준 OIDC 또는 비밀번호 |
| 모델 실행 | 사내 OpenAI 호환 모델 endpoint |
| 콘솔 | 앱이 제공하는 페이지·정적 자산 |

S3 호환 저장소, capability 검색, MCP, 메신저, 원격 모델·Plugin 카탈로그, 오디오·Workspace는
각각 활성화 조건을 갖는다. [설치 문서](INSTALL.md)는 필요한 서비스와 오프라인 구성을 설명한다.
선택 기능의 실패로 실행 중 일부 능력이나 결과가 사라지면 warning으로 알린다.

## 스택

Node.js 24·pnpm 11, Next.js 16 App Router·React 19·TypeScript strict, Mantine 9,
Better Auth와 PostgreSQL + pgvector를 사용한다. 정확한 버전은 [package.json](../package.json),
로컬에서 사용하는 DB 이미지는 [compose.yaml](../compose.yaml)이 정본이다.
Artifacts의 bytes는 선택적 S3 호환 저장소에 보관한다.

## 레이어

Clean Architecture를 적용해 도메인 규칙과 유스케이스를 UI·저장소·외부 연동의 구현에서 분리한다.
인프라 구현을 교체하거나 테스트용 어댑터를 주입해도 핵심 업무 규칙을 유지하기 위한 구조다.
의존 방향은 **`app → application → domain ← infrastructure`**다.

저장소 등 외부 기능의 계약(포트)은 domain에 두고 infrastructure가 구현한다. application은
구현체를 import하지 않고 조립 지점에서 주입받는다. 실행 중 유스케이스가 어댑터를 호출하더라도
코드 의존성은 domain의 계약을 향하는 의존성 역전(Dependency Inversion)을 따른다.

| 경로 | 책임과 의존 규칙 |
|---|---|
| `src/domain/` | 엔티티·값 규칙·저장소 포트. 순수 TypeScript이며 다른 앱 계층, framework, AWS, `shared`를 import하지 않는다 |
| `src/application/` | 유스케이스·오케스트레이션. domain·의존성 없는 shared·표준 라이브러리를 사용하고 의존성을 주입받는다 |
| `src/infrastructure/` | PostgreSQL·벡터·스토리지·LLM·MCP·네트워크·crypto 등의 어댑터. application·app을 import하지 않는다 |
| `src/app/` | 페이지·컴포넌트·HTTP/SSE 계약. 어댑터는 지정된 조립 지점을 통해 사용한다 |
| `src/lib/` | 설정·인증·세션·런타임 설정과 composition root. application에서 허용하는 import는 순수 `runMetrics` 리프뿐이다 |
| `src/shared/` | 날짜·본문 제한·로깅·타임아웃 등 의존성 없는 헬퍼. `@/` import를 두지 않는다 |
| `src/components/` | 헤더·앱 shell 등 공통 화면 요소 |

application에서 `@a2a-js/sdk`와 `@openai/agents`는 명시적 예외다. SDK의 프로토콜·Agent·Runner·
Session 계약을 직접 사용하고, 배포별 저장·모델·자격 증명은 포트로 주입한다.
어댑터와 유스케이스는 환경변수를 직접 읽지 않으며 `lib/config.ts`와 주입된 설정을 사용한다.
`"use client"` 모듈은 application·infrastructure의 runtime 값을 가져오지 않는다.

주요 구현 경로는 다음과 같다.

| 관심사 | 코드 |
|---|---|
| 프로젝트·버전과 접근 | `application/project/`, `domain/project/` |
| 유형별 실행·바인딩·Memory·미리보기 | `application/execution/` |
| SDK Agent·Runner·도구·Session·승인 | `application/runtime/` |
| 프롬프트 조립·PII·문맥 예산·모델 카탈로그 | `application/llm/` |
| 공통 실행 정책·Trace 수명 | `application/run/` |
| Chat·재연결·Workspace 결과 재개 | `application/chat/` |
| 메신저 공통 턴·첨부·응답 | `application/messaging/`; 플랫폼별 `slack/`, `telegram/`, `teams/` |
| 문서·Artifacts·오디오 | `application/document/`, `artifact/`, `audio/`; `infrastructure/documents/` |
| Workspace·Sandbox·Git 승인 | `application/workspace/`, `infrastructure/workspace/`, `sandbox/` |
| 카탈로그·Plugin·자동화·원격 프로토콜 | `application/catalog/`, `plugin/`, `trigger/`, `a2a/`, `agui/` |
| DB와 네트워크 경계 | `infrastructure/db/`, `net/`, `storage/`, `crypto/` |
| 콘솔 공통 UI·클라이언트 헬퍼·번역 | `app/_components/`, `app/_lib/`, `app/_i18n/` |

### 모듈 경계와 재사용

높은 응집도와 낮은 결합도를 기준으로 모듈을 설계한다. 파일 수나 분할 자체가 목표는 아니다.

- 같은 책임과 변경 이유를 가진 규칙·동작은 한 모듈에 모으고, 서로 다른 책임은 분리한다.
- 모듈은 필요한 계약만 공개하고 다른 모듈의 내부 구현이나 조립 지점을 역으로 참조하지 않는다.
  외부 의존성은 주입해 실제 인프라 없이도 유스케이스를 검증하고 구현체를 교체할 수 있게 한다.
- 공통 기능과 규칙은 의미에 맞는 계층의 단일 소유자가 제공하고 소비자는 이를 재사용한다.
  여러 곳에서 사용한다는 이유만으로 도메인 규칙을 `shared`로 옮기지 않는다.
  기존 소유자는 [OWNERSHIP](OWNERSHIP.md)에서 확인한다.
- 재사용은 실제 사용처에서 확인된 공통성을 기준으로 한다. 코드 모양이 비슷하다는 이유로
  서로 다른 정책을 묶거나, 예상만으로 범용 추상화와 확장 지점을 만들지 않는다.

### 조립은 의도적으로 고른 몇 곳에서만

| Wiring site | 조립하는 것 |
|---|---|
| `src/lib/container.ts` | 저장소·포트·채널·유스케이스와 실행·Chat·Trigger·worker deps |
| `src/app/api/chats/_deps.ts` | HTTP Chat에 공통 `chatDeps` 재노출 |
| `src/app/api/slack/events/_lib/` | Slack 이벤트의 실행·클라이언트 deps |
| `src/app/api/telegram/webhook/_lib/` | Telegram 실행·클라이언트·transcript deps |
| `src/app/api/teams/messages/_lib/` | Teams 실행·클라이언트·transcript deps |
| `src/app/api/a2a/[name]/route.ts` | 프로젝트 카드와 실행 deps 위의 요청별 SDK handler |
| `src/instrumentation.ts` | 설정 검증·migration·관리자 bootstrap·감사 sink·모델 카탈로그·managed MCP 복구 |

추가로 `lib/auth.ts`, `runtime-settings.ts`, `memberAccess.ts`만 어댑터에 직접 닿는
lib wiring 모듈이다. 유스케이스는 `createXUseCases` 팩토리로 한 번 바인딩하거나 실행 경로에
맞는 deps bag을 받는다. 이미 repository를 가진 application 모듈은 export된 자유 함수를 사용한다.

### 규칙은 기계적이며, 희망 사항이 아니다

[`tests/architecture.test.ts`](../tests/architecture.test.ts)가 계층·조립·클라이언트 번들 경계,
단일 소유자와 제한된 호출 지점을 검사한다. 일시적 위반 허용 목록은 비어 있다.
소유자의 정의가 사라지거나 소비자가 규칙을 복제해도 실패한다.
새 호출 지점은 해당 집합을 의도적으로 검토하며, 검사 실패를 피하려고 경계를 완화하지 않는다.

## PostgreSQL 아이템 테이블 설계

[`migrations.ts`](../src/infrastructure/db/migrations.ts)가 advisory lock 아래 스키마를 적용하고
`schema_migrations`에 기록한다. 부팅 또는 `pnpm db:migrate`가 같은 경로를 사용한다.

| 저장 영역 | 목적 |
|---|---|
| `items` | `pk`·`sk`와 JSONB `data`로 제품 엔티티를 저장한다. 키는 `COLLATE "C"`로 정렬하고 JSONB에서 파생한 GSI·만료 컬럼에 인덱스를 둔다 |
| `user`·`session`·`account`·`verification` | Better Auth의 인증 스키마와 유니크 제약 |
| `catalog_vectors` | capability embedding과 metadata. 모델별 차원이 달라 열에 폭을 고정하지 않으며 재색인으로 일치시킨다 |
| `runtime_sessions` | 압축·인증 암호화한 SDK 이력·RunState, owner·project·revision·만료·삭제 tombstone. 큰 native payload를 아이템 행과 분리한다 |

키의 유일한 작성자는 [`keys.ts`](../src/infrastructure/db/keys.ts)다.
계층을 넘어 공개하는 Artifact cursor 형태만 `domain/artifact/repository.ts`의 `artifactCursor`가 소유한다.
아래는 저장 주소와 접근 패턴이다. 주요 엔티티는 `entityType`, 보조 행은 키와 상태로 구분한다.

| 엔티티 | PK | SK | GSI1PK | GSI1SK |
|---|---|---|---|---|
| Project | `PROJECT#{name}` | `META` | `TYPE#PROJECT` | `{name}` |
| 삭제된 Project 이름 tombstone | `PROJECT#{name}` | `META` | — | — |
| Project version | `PROJECT#{name}` | `VERSION#{versionName}` | — | — |
| Project API 토큰 | `PROJECT#{name}` | `APITOKEN` | — | — |
| Workspace 정책 / 저장소 생성 receipt | `PROJECT#{name}` | `WORKSPACEPOLICY` / `REPOSITORYCREATE#{repository lowercased}` | — | — |
| Workspace | `WORKSPACE#{id}` | `META` | `WORKSPACEOWNER#{email}` | `{createdAt}#{id}` |
| Workspace Chat 역참조 | `WORKSPACECHAT#{chatId}` | `META` | — | — |
| Workspace Session·Sandbox·Run·승인·요청·전달·후속 실행 | `WORKSPACE#{id}` | `{SESSION\|SANDBOX\|RUN\|APPROVAL\|REQUEST\|DELIVERY\|CONTINUATION}#{childId}` | — | — |
| Workspace 이벤트 | `WORKSPACE#{id}` | `EVENT#{runId}#{seq zero-padded 8}` | — | — |
| Workspace checkpoint manifest / chunk | `WORKSPACESTATE#{id}` | `{checkpointId}#META` / `{checkpointId}#{index zero-padded 6}` | — | — |
| Project 의 MCP OAuth 연결 | `PROJECT#{name}` | `MCPCONN#{server}` | — | — |
| 진행 중인 MCP OAuth 인가 | `MCPOAUTH#{state}` | `META` | — | — |
| Trigger (webhook / schedule) | `PROJECT#{name}` | `TRIGGER#{triggerId}` | schedule 만: `TYPE#SCHEDULE` | schedule 만: `{name}#{triggerId}` |
| Trigger 런 (delivery / firing) | `PROJECT#{name}` | `TRIGGERRUN#{triggerId}#{startedAt}#{runId}` | — | — |
| Trigger 중복 제거 claim (`Idempotency-Key` / `schedule:{instant}`) | `TRIGGERIDEM#{name}#{triggerId}#{key}` | `META` | — | — |
| 오디오 작업 | `PROJECT#{name}` | `AUDIOJOB#{id}` | — | — |
| 오디오 프로젝트 큐 | `PROJECT#{name}` | `AUDIOSLOTS` | 비어 있지 않을 때: `AUDIOJOBDUE` | `{headDueAt}#{name}#{headJobId}` |
| 오디오 기본 설정 | `PROJECT#{name}` | `AUDIOCONFIG` | — | — |
| 오디오 중복 방지 / 발생별 한도 | `PROJECT#{name}` | `AUDIOSOURCE#{sourceKey}` / `AUDIOOCCURRENCE#{occurrence}` | — | — |
| 비공개 원본·파생 파일 inventory | `SOURCEFILE#{id}` | `META` | 미삭제 파일만: `SOURCEFILEEXPIRY` | `{retireAt}#{name}#{id}` |
| 암호화된 원본 참조 | `SOURCEREFERENCE#{id}` | `META` | — | — |
| 멱등 사용량 receipt | `PROJECT#{name}` | `USAGERECEIPT#{id}` | — | — |
| Chat | `CHAT#{chatId}` | `META` | `CHATOWNER#{email}` | `{updatedAt ISO}` |
| Chat 메시지 | `CHAT#{chatId}` | `MSG#{seq zero-padded 6}` | — | — |
| Chat 런 로그 (리플레이 버퍼, 짧은 TTL) | `CHAT#{chatId}` | `RUNLOG#{runId}#{seq zero-padded 6}` | — | — |
| Skill | `SKILL#{name}` | `META` | `TYPE#SKILL` | `{name}` |
| MCP 서버 | `MCP#{name}` | `META` | `TYPE#MCP` | `{name}` |
| 외부 Agent (registry) | `AGENT#{name}` | `META` | `TYPE#AGENT` | `{name}` |
| Plugin | `PLUGIN#{name}` | `META` | `TYPE#PLUGIN` | `{name}` |
| Plugins-sync 리포트 (소스 repo 별) | `PLUGINSYNC#{repo}` | `REPORT` | — | — |
| Plugins-sync 리스 | `PLUGINSYNC#{repo}` | `LOCK` | — | — |
| Usage (프로젝트별 일간) | `USAGE#{projectName}` | `DATE#{yyyy-MM-dd}` | `USAGEDATE#{yyyy-MM-dd}` | `{projectName}` |
| Usage (호출자별 일간) | `USAGE#{projectName}` | `ACTOR#{yyyy-MM-dd}#{kind}:{id}` | — | — |
| Usage 월간 임계값 claim | `USAGE#{projectName}` | `MONTHCLAIM#{yyyy-MM}` | — | — |
| Usage (멤버별, 일별, 프로젝트별) | `USAGEMEMBER#{email}` | `DATE#{yyyy-MM-dd}#{projectName}` | — | — |
| 런 동시성 슬롯 | `RUNSLOT#{kind}:{id}` | `SLOT#{index zero-padded 3}` | — | — |
| Slack 이벤트 중복 제거 | `SLACKEVENT#{eventId}` | `META` | — | — |
| Slack 스레드 참여 (봇이 답한, 또는 음소거된 스레드) | `SLACKTHREAD#{projectName}#{channel}#{threadTs}` | `META` | — | — |
| Telegram 업데이트 중복 제거 (`update_id` 는 봇마다의 카운터이므로 봇으로 한정한다) | `PROJECT#{name}` | `TELEGRAMUPDATE#{botId}#{updateId}` | — | — |
| Telegram 앨범 claim (한 `media_group_id` 에 한 번 답한다) | `PROJECT#{name}` | `TELEGRAMALBUM#{botId}#{mediaGroupId}` | — | — |
| Telegram destination | `PROJECT#{name}` | `TELEGRAMDESTINATION#{botId}#{chatId}#{threadId}` | — | — |
| Teams activity 중복 제거 (App ID 로 한정; activity id 는 대화 안에서만 유일하므로 대화 id 를 앞에 붙인다) | `PROJECT#{name}` | `TEAMSACTIVITY#{appId}#{conversationId}#{activityId}` | — | — |
| 대화 transcript 턴 (플랫폼 히스토리가 없는 chat-bot 표면, Telegram, Teams; project 파티션에 있어 cascade 가 지운다) | `PROJECT#{name}` | `TRANSCRIPT#{conversationKey}#TURN#{createdAt ISO}#{seq}` | — | — |
| Artifact (첨부 원본과 런 출력) | `ARTIFACT#{artifactId}` | `META` | `ARTIFACTPROJECT#{projectName}` | `{createdAt ISO}#{artifactId}` |
| A2A 태스크 (수신) | `A2ATASK#{projectName}#{urlencode(tenant:client)}` | `TASK#{taskId}` | `A2ATASKLIST#{projectName}#{urlencode(tenant:client)}` | `{statusTimestamp ISO}#{taskId}` |
| 원격 대화 (송신 A2A `contextId`) | `PROJECT#{name}` | `REMOTECTX#{agentName}#{conversationKey}` | — | — |
| A2A 클라이언트 키 | `A2ACLIENT#{name}` | `META` | `TYPE#A2ACLIENT` | `{name}` |
| A2A 클라이언트 키 해시 (검증용. 인증은 이 행이 지목한 primary 의 동일 hash 와 client-name 컨텍스트로 복호화한 token 도 확인한다) | `A2AKEYHASH#{sha256}` | `META` | — | — |
| Trace | `TRACE#{traceId}` | `META` | `TRACEPROJECT#{projectName}` | `{createdAt ISO}#{traceId}` |
| Trace 삭제 참조 | `PROJECT#{name}` | `TRACE#{createdAt}#{traceId}` | — | — |
| 감사 기록 | `AUDIT#{yyyy-MM-dd}` | `{createdAt ISO}#{eventId}` | — | — |
| 앱 설정 (환경변수 오버라이드) | `SETTINGS#app` | `META` | — | — |
| Capability catalog reindex lease + 영구 generation (in-place rebuild와 겹친 검색은 결과를 버린다) | `CATALOGREINDEX#global` | `LOCK` | — | — |
| 사용자별 모델 즐겨찾기 | `MODELPREFERENCES#{userId}` | `META` | — | — |
| admin 이 업로드한 모델 카탈로그 문서 (배포당 하나, 발행 카탈로그보다 우선) | `MODELCATALOG#doc` | `META` | — | — |

두 번째 인덱스는 다음 목록을 담당한다:

| 엔티티 | GSI2PK | GSI2SK |
|---|---|---|
| 실행·정리가 필요한 Workspace | `WORKSPACEDUE` | `{dueAt}#{workspaceId}` |
| 대기·진행 중인 Workspace 후속 실행 | `WORKSPACECONTINUATIONDUE` | `{dueAt}#{workspaceId}#{approvalId}` |
| Telegram destination | `TELEGRAMDESTINATION#{name}#{botId}` | `{lastSeenAt ISO}` |
| Artifact (소유자 이메일이 있는 행만, 희소) | `ARTIFACTOWNER#{email}` | `{createdAt ISO}#{artifactId}` |
| 미삭제 파생 파일 | `SOURCEJOB#{project}#{job}` | `{kind}#{id}` |

GSI1은 종류·소유자·시각별 목록, GSI2는 Workspace 큐·후속 실행, Telegram destination,
개인 Artifact와 작업별 source 파일을 조회한다. 둘 다 인덱스 키가 있는 행만 포함하는 희소 인덱스다.
Workspace의 파일·native Session checkpoint는 별도 `WORKSPACESTATE#` 파티션에 나누어 저장하며
Chat의 SDK `runtime_sessions`와 수명을 공유하지 않는다.

### 관례

- 아이템 리포지토리는 [`store.ts`](../src/infrastructure/db/store.ts)를 사용한다. 조건부 쓰기는
  행 잠금 아래 평가하고 여러 키는 일정한 순서로 잠근다. 접두사 범위·트랜잭션·만료 삭제도 이 계층이 소유한다.
  전용 인증·벡터·SDK Session 테이블과 `skillRepository.describe`의 projection은 별도 SQL 경로다.
- 무한히 늘어나는 목록에는 `limit`을 주고, 만료·조건 필터는 `LIMIT` 전에 적용한다.
  `queryItems`에 넘기는 `notExpiredAt`·`filter`가 그 경계다.
- 이름 기반 registry의 공통 CRUD는 `createKeyedRepository`를 사용한다. Project의 publish는
  `META.publishedVersion`, Chat 메시지 번호는 `META.nextSeq`가 소유한다.
- Project 삭제는 먼저 `deletingAt`으로 자식 쓰기를 차단하고 관련 행을 정리한 뒤
  소유권을 제거한 tombstone을 남긴다. 중단된 cascade는 같은 owner/admin이 다시 DELETE하여
  이어간다. Chat·Artifact처럼 더 오래 남는 참조가 있어 프로젝트 이름을 재사용하지 않는다.
- Usage는 행 잠금 아래 모델별 델타를 더한다. 임계값 알림 claim은 Usage 행에 둬
  프로젝트 편집 revision과 분리한다. 귀속·집계는 [관측성 설계](design/observability.md)를 따른다.
- DB 만료 삭제는 자동 TTL이 아닌 `sweepExpiredRows`다. 외부 schedule scan이 실행해야
  아이템·인증 Session·SDK Session을 정리하며 읽기도 만료를 검사한다.
  객체·오디오·Sandbox의 정리는 [행 보존](OPERATIONS.md#행-보존)에 따로 명시한다.

## 요청 흐름

실행 표면은 인증·Project 접근·입력 검증을 마친 뒤
[`runProject.ts`](../src/application/execution/runProject.ts)의 파사드를 호출한다.

| 파사드 | 계약 |
|---|---|
| `streamProjectRun` | 모든 project type을 chunk로 반환한다. image는 `generateImageStream`으로 연결한다 |
| `executeProjectStream` / `executeProject` | agent의 도구 실행 또는 llm의 단발 completion을 반환한다. image는 거절한다 |
| `executeAgent` | agent Project만 실행하고 바인딩·SDK Runtime·정산을 조율한다 |
| `executeWorkspaceTask` | 모델 Version 없이 Workspace 작업의 공통 정책을 연다 |

단발 실행의 `executeVersion`/`executeVersionStream`을 외부 표면에서 직접 호출하지 않는다.
Predict와 A2A는 이미지 전용 응답을 만들기 위해 `generateImage`를 직접 호출하는 지정된 예외다.
새 chunk 소비자는 `streamProjectRun`을 사용한다.

| 진입점 | 호출자 | 사용하는 파사드 |
|---|---|---|
| Predict | `POST …/predict` | `executeProjectStream`(스트림) / `executeProject`(논스트림). 그래서 agent project 도 여기서 툴 루프를 돌고, (프롬프트 템플릿만 소비하는) `variables` 는 그 경우 무시된다. image project 는 → `generateImage`, 요청에 source `images` 가 오면 편집하고 아니면 생성한다 |
| OpenAI 호환 | `POST …/chat/completions` | `executeProjectStream`(스트림) / `executeProject`(논스트림). image project 는 400 으로 거절된다. 이미지에는 chat completion 이 없다 |
| Agent SSE | `POST …/agent` | `executeAgent` |
| Chat | 생성·메시지 전송·SDK 승인 재개 API, Workspace 승인·CI 결과의 후속 실행 | `executeAgent` (`ChatDeps.runAgent` 로 바인딩) |
| Slack | `/api/slack/events/[project]` → `handleSlackEvent` → `handleTurn` | `executeAgent` (`SlackEventDeps` 경유) |
| Telegram | `/api/telegram/webhook/[project]` → `handleTelegramUpdate` → `handleTurn` | `executeAgent` (`TelegramEventDeps` 경유). Slack 과 같은 공유 파이프라인 ([design/messaging.md](design/messaging.md)) |
| Teams | `/api/teams/messages/[project]` → `handleTeamsActivity` → `handleTurn` | `executeAgent` (`TeamsEventDeps` 경유). 같은 파이프라인 |
| A2A | `POST /api/a2a/[name]` → executor | `executeProjectStream` |
| AG-UI | `POST /api/agui/[name]` → `streamAguiRun` | `streamProjectRun`. 채팅 패널은 어느 타입이든 그릴 수 있으므로 image project 도 거절하지 않는다. 청크는 `src/application/agui/events.ts` 가 프로토콜의 이벤트로 바꾼다 ([design/agui.md](design/agui.md)) |
| Webhook trigger | `POST /api/webhook/[project]` → `executeDelivery` | `streamProjectRun` (`container.ts` 에서 `triggerRunnerDeps.run` 으로 바인딩). AG-UI 와 함께, image project 를 거절하지 않고 스트리밍하는 dispatch 다. firing 의 행은 텍스트를 담으므로, 그림을 그렸다는 사실을 기록한다 |
| Schedule trigger | `POST /api/triggers/scan` → `scanSchedules` → `executeFiring` | `streamProjectRun` (같은 `triggerRunnerDeps.run`) |
| Audio 후처리 | audio worker가 고정한 project/version으로 실행 | `streamProjectRun` + `collectRun` (`backgroundTask: true`) |
| Workspace | 별도 worker가 DB 큐와 native operation을 이어받는다 | `executeWorkspaceTask` + 공통 `openTaskRun`. 일반 명령과 외부 CLI runtime은 모델 Version 없이 실행한다 |

오디오 전사 호출은 worker가 `openModelCall`로 모델 정책·비용·동시성을 적용하고,
후처리는 표의 프로젝트 실행 경로를 사용한다. 같은 Version이라도 사용자·token·메신저·자동화가
갖는 Session·도구·승인은 다르다. [실행 창구별 계약](design/workspaces.md#실행-창구별-계약)을 보라.

### 런 브래킷

[`runBracket.ts`](../src/application/run/runBracket.ts)는 최상위 실행의 공통 정책을 소유한다.

1. 로그 correlation ID를 만들고 모델 실행이면 primary·fallback의 미등록 모델 정책을 검사한다.
2. 프로젝트 일간·월간 비용과 해당 user actor의 멤버 월간 상한을 검사한다.
3. 호출자별 DB lease 슬롯을 획득하고 in-flight 메트릭을 연다.
4. `openRun`은 여기에 프로젝트·버전·실행 주체가 묶인 Artifact recorder를 추가한다.
5. 실행 경로가 사용량을 저장한 뒤 `close`가 메트릭을 닫고 슬롯을 해제하며 비용 임계값을 정산한다.

`executeVersion`, `executeVersionStream`, `executeAgent`, `generateImage`가 `openRun`을 사용한다.
오디오 전사는 `openModelCall`, Workspace 작업은 모델 없는 `openTaskRun`을 사용한다.
Workspace native CLI의 사용량은 Studio SDK 모델 Usage와 별개다.

거절된 실행은 실행 메트릭·Usage·Trace를 만들지 않는다. 비용·모델 정책의 설정 조회 장애는
fail-open, 동시성 저장소 장애는 fail-closed다. user tier는 개인 예산과 동시성에 적용하고
서비스 credential인 project-token에는 개인 예산을 청구하지 않는다.

슬롯은 획득 토큰과 만료가 있는 DB 행이다. 해제도 토큰을 검사해 만료된 실행이 새 실행의 슬롯을
지우지 못한다. 하위 Agent는 부모 브래킷 안에서 실행하되 대상의 발행 버전·순환·깊이·모델·
프로젝트 비용과 남은 턴을 검사한다. 사용량 flush 후 비용을 쓴 하위 프로젝트도 정산한다.
상한과 튜닝은 [CONFIGURATION](CONFIGURATION.md#실행-제한),
실패 정책은 [OPERATIONS](OPERATIONS.md#지출-가드와-부하-가드)에 있다.

### 프리뷰는 모델을 호출하지 않고 런 입력을 조립한다

`promptPreview.ts`는 실제 런과 같은 빌더로 프롬프트를 조립한다. Agent의 Skill 표·MCP alias·
위임·이미지 지침은 실행 시 결정되므로 preview도 같은 MCP 준비 경로를 사용한다.
캐시 상태에 따라 실제 서버를 조회할 수 있으며 준비한 세션은 반환 전에 정리한다.
요청을 주면 명시적 Memory recall과 capability 검색을 반영하고, 요청이 없으면 빠진 문맥을 경고한다.
image Project는 `composeImagePrompt`로 style과 템플릿을 합친다.
preview는 PII 치환 전 원문이며 필터를 켠 Version에는 이를 경고한다.

### SSE 응답은 답하기 전에 첫 chunk 를 당겨온다

[`sse.ts`](../src/app/api/_lib/sse.ts)는 generator의 첫 `next()`를 최대 25초 기다린다.
이 안에 발생한 예외는 route의 `apiError`가 HTTP 상태와 `Retry-After`로 반환할 수 있다.
기한 안에 출력이 없으면 같은 pending read를 유지한 채 응답을 열어 15초 간격 keepalive를 보낸다.
이후 실패는 이미 보낸 HTTP 상태를 바꾸지 못하고 스트림의 오류 프레임으로 전달한다.

일반 SSE의 정상 전송은 `data: [DONE]`으로 끝나며 A2A·AG-UI는 자체 종료 계약을 사용한다.
Chat의 연결 분리 wrapper는 이 계층 바깥에 있다. 브라우저 연결 종료와 실제 실행 취소를
구분하는 방법은 [Chat 설계](design/chat.md#런은-자기-연결보다-오래-산다)를 따른다.

### EngineChunk 계약

[`domain/llm/types.ts`](../src/domain/llm/types.ts)가 Runtime과 소비자 사이의 형태를 소유한다.
최상위 출력은 `author`가 없으며 판정은 `isTopLevelChunk`를 사용한다.

| 필드 | 의미와 소비 규칙 |
|---|---|
| `delta.content` | 복원된 응답 텍스트. 최상위 답변과 자식 출력을 구분해 저장·렌더링한다 |
| `delta.reasoningContent` | `reasoningTrace`를 켰을 때만 표시한다. provider 재생 이력은 옵션과 무관하게 원래 모델 턴에 남는다. Chat 화면용 합친 추론은 모델에 재주입하지 않는다 |
| `delta.toolCalls` / `toolResult` | 도구 표시·진행·결과. 화면 레코드는 SDK Session의 모델 이력을 대신하지 않는다. 호출 ID는 run·author 범위에서 짝짓는다 |
| `warning` | 사용할 수 없는 binding, 잘린 문맥·결과, 저장 실패 등 손실. 실행을 끝내지 않으며 `collectedWarning`으로 자식 경고도 중복 없이 모은다 |
| `image` | inline 이미지와 선택적 저장 참조. 자식 출력도 소비한다. 모델이 가져와 읽은 `fetched` 이미지는 생성 Artifact로 보관하지 않는다 |
| `file` | 이름·media type·출처·저장 참조. bytes는 모델 문맥에 넣지 않고 저장 후 제거한다. `producedFiles.ts`가 외부 주소와 저장 손실 설명을 소유한다 |
| `usage` | 실제 호출 모델과 사용량. 여러 호출을 합산한 응답은 단일 모델을 뜻하지 않는다. DB 기록은 별도 정산 경로다 |
| `error` | 최상위 오류는 전체 실행 실패다. 위임 오류는 부모의 도구 결과·경고로 흡수할 수 있다 |
| `done` / `finishReason` | 전송 구간 종료와 턴·출력 한도. `runTermination`이 최상위 종료만 판정한다. 취소는 소비자의 signal/return으로 판정한다 |
| `approval` | `{ pending: true }`면 영속 Chat의 승인 항목을 조회한다. 이 경우 전송이 끝나도 작업이 완료된 것은 아니다 |
| `author` / `authorPath` | 자식 출력의 이름과 위임 경로. Handoff는 같은 Runner의 담당 Agent를 바꾸므로 별도 작성 경로를 만들지 않는다 |
| `transferId` / `authorDone` | 동시 위임 호출의 식별자와 해당 자식 실행 종료. Trace 샘플링과 독립적이다 |
| `traceId` | Studio Trace 식별자. text 자식은 최상위 Trace의 SDK span 계층을 사용하며 특화 자식은 별도 Trace를 가질 수 있다 |

이미지와 파일을 소비하는 표면은 두 축을 모두 다룬다. raw chunk route는 `withAddressedFiles`로
파일 참조를 URL로 바꾸고, completion API·A2A·AG-UI·메신저·Trigger는 자기 응답 형태에 맞게
변환한다. 도구가 새 capability를 발견한 사실은 손실이 아니므로 warning으로 만들지 않는다.
reasoning fold·Artifact capture·raw stream의 호출 범위는 구조 테스트로 검사한다.

## 에러 처리

HTTP 응답 전에 발생한 유스케이스 오류는 `AppError` 하위 타입과 `apiError`로 변환한다.
검증·없음·권한·충돌·제한 오류는 각각 적절한 4xx, upstream 실패는 502, 실행 deadline은 504다.
제한 오류에는 재시도 시점을 함께 전달한다. 알 수 없는 예외는 상세를 서버에 기록하고
일반 500으로 응답한다.

응답 시작 뒤 오류는 stream 값으로 전달한다. 사용할 수 없는 개별 capability는 경고와 함께
빠질 수 있고, 도구 timeout은 오류 도구 결과가 되어 모델이 다음 행동을 선택한다.
이미 출력한 실행을 무조건 재시도하지 않는다. 모델 fallback의 조건과 SDK 동작은
[실행 설계](design/execution.md#모델과-실행)를 따른다.

## 서브시스템

| 문서 | 소유하는 설명 |
|---|---|
| [execution](design/execution.md) | Project·Version, SDK Runtime, 이미지와 Artifacts |
| [sdk-capabilities](design/sdk-capabilities.md) | SDK 기능별 제품 적용 범위·미지원 경계·검증 근거 |
| [chat](design/chat.md) | 화면 기록·SDK Session·승인·연결 분리·재연결 |
| [capabilities](design/capabilities.md) | Skill·Plugin sync·벡터 검색·Memory recall |
| [mcp](design/mcp.md) | binding·transport·세션·캐시·managed 서버·OAuth |
| [documents](design/documents.md) | 형식별 읽기·생성·편집, worker, 파일 참조·HTML 미리보기 |
| [audio](design/audio-processing-spec.md) | 원본·비동기 전사·후처리·delivery·보존 |
| [workspaces](design/workspaces.md) | 영속 작업 공간·Sandbox·worker·Git 승인·Chat 후속 실행 |
| [messaging](design/messaging.md) | 공통 턴·첨부·응답 포트·delivery claim |
| [slack](design/slack.md) / [telegram](design/telegram.md) / [teams](design/teams.md) | 플랫폼별 인증·참여 판단·렌더링·대화 문맥 |
| [triggers](design/triggers.md) | Webhook·Schedule·중복 방지·유실 실행 정리 |
| [observability](design/observability.md) | Audit·Usage·Trace의 기록·귀속 |
| [agents-a2a](design/agents-a2a.md) | 외부 Agent registry·양방향 A2A |
| [agui](design/agui.md) | 입력과 이벤트 변환·frontend tool |

로컬 작업 지침은
[`runtime/AGENTS.md`](../src/application/runtime/AGENTS.md),
[`llm/AGENTS.md`](../src/application/llm/AGENTS.md),
[`chat/AGENTS.md`](../src/application/chat/AGENTS.md)에 있다.
설계 문서는 동작과 이유를, 로컬 지침은 변경 시 지켜야 할 불변식을 다룬다.

## UI

| 화면 | 역할 |
|---|---|
| `/`, `/login`, `/guide` | 로그인 상태별 개요·랜딩, 로그인, 사용자 가이드. `/dashboard`는 `/`로 redirect |
| `/projects`, `/projects/[name]` | 카탈로그·생성·Playground |
| 프로젝트 하위 `versions`·`compare`·`usage`·`traces`·`artifacts` | 버전·비교·비용·실행 기록·산출물 |
| 프로젝트 하위 `api-reference`·`integrations`·`settings`·`audio`·`workspace` | 호출 예제·연동·설정·선택적 비동기 작업 |
| `/chats`, `/chats/[chatId]`, `/artifacts` | 개인 대화·작업·파일 |
| `/skills`·`/tools`·`/agents`·`/plugins`와 각 상세 | 공유 capability registry |
| `/models`, `/profile`, `/members`, `/audit`, `/settings` | 모델·개인 한도·관리 화면. 실제 접근은 서버 권한 검사로 제한 |

콘솔 언어는 route가 아닌 locale cookie로 정한다. `en.ts`가 번역 key의 정본이고 `ko.ts`는
타입 검사로 일치시킨다. 독자에게 보이는 날짜는 명시적 locale을 받는 `shared/date.ts`를 사용한다.
서버의 `resolveViewer`가 shell의 권한을 해석하며, 클라이언트 조회도 같은 viewer 계약을 쓴다.
로그아웃 상태에서는 내비게이션 내용을 렌더하지 않는다.

Mantine 테마의 소유자는 `app/theme.ts`다. 공통 검색은 `CatalogSearch`, IME Enter 전송은
`isSubmitEnter`, Chat 스크롤은 `use-stick-to-bottom`이 담당한다.
시스템 테마는 hydration 전후 기본값을 일치시키고, 답변·추론의 고빈도 출력은
`createTextPacer`로 묶는다. API Reference 예제는 프로젝트·버전에 맞춰 만들고 credential은
자리표시자로만 표시한다.

## 용어

개념의 기본 정의는 [시스템 개요](AGENT_STUDIO.md#skilltoolmcpagentmemory)를 따른다.
코드의 `agent project`는 다중 턴 프로젝트, `subagent`는 버전의 실행 대상 참조,
`ExternalAgent`는 원격 registry 항목이다. `McpServer`는 콘솔의 Tools에 등록한 서버를 뜻한다.

`RunActor`는 실행 귀속, `RunCaller`는 선택적 사용자 표시 문맥, `RunConversation`은 표면별
대화 주소다. route의 predict, 파사드의 execute, Runtime의 run은 같은 요청의 서로 다른 계층이다.

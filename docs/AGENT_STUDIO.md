---
title: Agent Studio 시스템 개요
description: 제품 경계와 주요 개념을 연결하고 상세 계약과 코드로 안내하는 검색·RAG용 지도
audience: 개발자, 운영자, 신규 기여자, 개발 에이전트
tags: [agent-studio, control-plane, rag, mcp, workspace, offline]
---

# Agent Studio 시스템 개요

Agent Studio는 기업 내부에 설치하는 AI Agent Control Plane이다. 사용자는 Project를 만들고
Version에 모델·프롬프트·도구를 구성한 뒤 여러 실행 창구에서 호출한다. Studio는 접근 권한,
자격 증명, 예산과 기록을 관리하고 OpenAI Agents SDK는 모델 턴과 도구 실행을 관리한다.

이 문서는 프로젝트 전체를 이해하거나 검색·RAG 문맥으로 읽는 통합 지도다. 세부 필드·수치·절차는
각 절에서 연결한 문서가 소유한다. 문서와 구현이 어긋나면 연결한 코드에서 현재 동작을 확인한다.

## 제품 경계와 배포

한 설치는 한 기업이다. 멀티테넌시는 없으며 설치 안의 접근은 멤버 등급, 프로젝트 공개 범위와
소유권으로 나눈다. PostgreSQL + pgvector가 기본 영속 저장소다. 사내 로그인 수단과 OpenAI 호환
모델 채널을 구성하면 필수 부팅·로그인·실행·콘솔 경로를 공개 인터넷 없이 운영할 수 있다.

파일 보관에는 S3 호환 저장소, 오디오와 Workspace에는 별도 worker가 필요하다. 외부 모델,
원격 카탈로그·Plugin sync, Slack·Telegram·Teams·GitHub·A2A는 배포가 선택하는 연결이다.
문서 worker, 오디오 worker, Workspace Sandbox와 관리형 MCP는 서로 다른 실행 자원이다.

애플리케이션은 Next.js App Router 기반의 단일 풀스택 앱이다. 이 저장소는 앱과 이미지,
로컬 개발 환경을 소유한다. IDC와 Kubernetes의 ingress·secret·backup·rollout은 배포 저장소가
소유한다. 개발 중이므로 API·설정·저장 형식의 하위 호환은 보장하지 않는다.
설치와 업그레이드는 [INSTALL](INSTALL.md), 실제 변수는 [CONFIGURATION](CONFIGURATION.md)을 따른다.

## Project와 Version

Project는 이름으로 호출하는 제품 단위다. `llm`은 단발 프롬프트, `agent`는 도구를 사용하는
다중 턴 실행, `image`는 이미지 생성·편집이다. Version은 모델·fallback·프롬프트·생성 설정,
Skill·MCP·하위 Agent binding과 실행 정책을 묶는다.

Version은 이름이 있는 수정 가능한 구성이다. publish는 Project의 `publishedVersion` 포인터를
바꾸며 별도의 불변 사본을 만들지 않는다. URL에 버전을 지정하는 API는 그 버전을 실행한다.
자동 선택에서는 발행 버전이 우선하며 Chat은 발행 버전을 찾지 못하면 최신 draft를 허용한다.
메신저·Trigger·A2A·하위 Agent는 발행 버전을 요구한다.

[실행 설계](design/execution.md#project--version)는 편집·검증·선택 계약을,
[API](API.md#version-과-publish)는 요청 형태를 설명한다. 선택 규칙은
[`resolveRunnableVersion.ts`](../src/application/project/resolveRunnableVersion.ts)가 소유한다.

## Skill·Tool·MCP·Agent·Memory

| 개념 | 역할 |
|---|---|
| Skill | 모델이 필요할 때 읽는 Markdown 지침과 참고 파일 |
| Tool | 입력 schema를 받아 실제 기능을 수행하는 함수 |
| MCP | 외부 Tool·리소스와 자격 증명을 연결하는 프로토콜 |
| 하위 Agent | 로컬 Project 또는 외부 OpenAI 호환/A2A 실행 대상 |
| Memory | 연결된 MCP 서버가 보관하는 장기 지식 |
| SDK Session | 특정 Chat에서 재생할 정확한 모델·도구 이력 |
| Workspace checkpoint | 파일·Git·native CLI Session의 복구 상태 |

Skill 본문은 시스템 프롬프트에 모두 넣지 않는다. 이름·설명을 제공하고 `Skill` 도구로 필요한
본문과 참고 파일을 읽는다. Plugin 저장소 또는 업로드 아카이브는 Skill·MCP를 동기화한다.
sync는 사라진 항목을 보고하지만 삭제는 별도의 명시적 작업으로 남긴다.

MCP registry는 서버 주소를 소유하고 Version binding은 도구 목록과 헤더를 좁히거나 덮어쓴다.
프로젝트별 OAuth 연결과 선택적인 Docker 관리형 서버도 지원한다. 등록·dispatch 경계에서
주소와 자격 증명을 검사한다. [MCP](design/mcp.md)와 [보안](SECURITY.md#mcp-oauth)을 보라.

선택적 capability 검색은 전역 `catalog_vectors`에서 현재 요청에 맞는 Skill·MCP·Agent를 찾는다.
명시적 binding을 유지하면서 capability를 추가하며, 실제 사용 전에 정책과 연결 권한을 적용한다.
별도의 Memory recall은 명시적으로 연결한 MCP의 `recall`을 호출해 장기 지식을 실행 문맥에 넣는다.
Studio 자체의 장기 Memory DB는 없다. [Capabilities](design/capabilities.md)가 두 경로를 설명한다.

## 요청이 실행되는 방식

```text
실행 창구 → 인증·프로젝트 접근·입력 검증 → Version 선택
  → 실행 파사드 → 공통 실행 가드 → capability 준비 → SDK Runtime
  → EngineChunk → 창구별 응답·저장 → 사용량 정산·자원 해제
```

[`runProject.ts`](../src/application/execution/runProject.ts)는 프로젝트 유형별 실행을 선택한다.
chunk를 소비하는 `streamProjectRun`은 이미지를 포함하고, completion을 만드는
`executeProjectStream`/`executeProject`는 image Project를 거절한다. `executeAgent`는 agent만
실행한다. Predict와 A2A의 이미지 응답은 전용 이미지 유스케이스를 사용한다.

최상위 실행은 [런 브래킷](ARCHITECTURE.md#런-브래킷)을 통과한다. 모델 정책, 프로젝트·멤버 비용,
호출자 동시성을 검사하고 메트릭과 결과 저장 범위를 연다. 비용 조회 장애는 실행을 허용하고,
동시성 저장소 장애는 실행을 거절한다. 종료 시 사용량을 저장한 뒤 슬롯을 놓고 비용 임계값을 정산한다.
이미 진행 중인 실행의 미정산 비용까지 예약하지 않으므로 비용 한도는 절대적인 청구 상한이 아니다.

SDK Runtime은 모델 턴, 도구, Handoff와 Agent-as-Tool을 담당한다. Handoff는 같은 Runner의
담당 Agent를 바꾸고, Agent-as-Tool은 자식 결과를 부모에게 돌려준다. Studio는 모델 endpoint,
credential, schema 검증, PII 치환, 예산과 로컬 Trace를 연결한다. 기본 공개 Trace exporter는
사용하지 않는다. [실행 설계](design/execution.md#native-agent-runtime)와
[SDK 적용 범위](design/sdk-capabilities.md)는 구현된 기능과 제한을 구분한다.

## 모델·스트림·실행 주체

모델의 capability·가격은 외부 `opspresso/agent-models` 카탈로그가 소유한다. 앱에는 오프라인
스냅샷을 포함하고, 배포가 원격 소스나 업로드 문서를 선택할 수 있다. 자체 호스팅 모델은 별도의
배포 선언이다. 모델 채널의 URL·credential·전송 모델명은 함께 해석한다.
[CONFIGURATION](CONFIGURATION.md#llm-채널)이 우선순위와 갱신 방법을 소유한다.

`EngineChunk`는 텍스트·추론·도구·사용량·경고·이미지·파일·승인·종료 정보를 전달한다.
최상위 chunk에는 `author`가 없고 자식 출력에만 작성 경로가 있다. 이미지와 파일은 별도 축이다.
파일 bytes는 모델 문맥에 들어가지 않으며 저장 후 참조로 바뀐다. 기능·문맥·출력의 손실은
warning으로 전달한다. reasoning 표시 옵션은 원래 모델 턴의 provider 재생 이력을 삭제하지 않는다.
자세한 소비 규칙은 [EngineChunk 계약](ARCHITECTURE.md#enginechunk-계약)에 있다.

`actor`는 비용·동시성에 쓰는 안정적인 실행 주체다. user와 project-token은 이메일,
Slack과 Telegram은 사용자 ID, Teams는 발신자 Entra object ID를 사용한다. 메신저 workspace나
bot ID와 혼동하지 않는다. `caller`는 Version이 허용한 표시 이름·시간대 등의 모델 문맥이며
이메일 필드가 없다. `ownerEmail`은 파일의 개인 귀속, `conversation`은 대화의 연속성을 나타낸다.
정의는 [actor.ts](../src/domain/execution/actor.ts), 귀속은 [관측성 설계](design/observability.md)에 있다.

## Chat과 승인

Chat은 소유자별 비공개 대화다. 화면용 메시지, SDK Session, 재연결용 run log는 목적과 수명이
다르다. 화면의 assistant·tool 행을 다시 조립해 모델 이력으로 사용하지 않는다.

SDK Session의 이력과 승인 RunState는 압축·인증 암호화한 `runtime_sessions`에 함께 저장한다.
소유자와 revision을 검사해 동시 갱신을 막고, 승인 시 체크포인트를 먼저 선점한 뒤 도구를 실행한다.
선점 이후 중단돼 결과가 불확실한 실행은 자동으로 반복하지 않는다.

Chat 실행은 브라우저 연결이 끊겨도 계속되고, 재접속한 클라이언트는 로그와 저장된 메시지로
따라잡는다. Stop은 별도의 취소 요청이다. 종료 순서는 메시지 저장 → 종단 로그 → 실행 lease 해제다.
상태·재연결·승인은 [Chat 설계](design/chat.md), 요청은 [Chat API](API.md#chats)를 따른다.

## 문서·이미지·Artifacts

이미지는 모델의 입력 capability와 바이트 한계를 검사한다. 문서 첨부는 텍스트를 추출해
출처 경계가 있는 데이터로 전달하고 저장소가 있으면 원본도 보관한다. HTML 첨부를 읽는 과정은
스크립트를 실행하지 않는다.

Agent의 `File` 도구는 저장된 파일을 읽고 검사하며 지원 형식을 생성·편집한다.
편집 결과는 원본을 덮지 않는 새 파일이다. `SaveFile`은 텍스트 기반 파일을 만든다.
이미지 Project와 이미지 도구는 생성·편집을 제공한다.
[문서 설계](design/documents.md)는 형식별 지원 범위와 HTML 실행 미리보기의 격리를 설명한다.

Artifact metadata는 DB에, bytes는 S3 호환 저장소에 둔다. URL 발급과 원본 접근은 별도 계약이며,
일반 Artifact의 DB 보존과 객체 lifecycle도 별개다. 비공개 오디오 source 파일은 매 요청 소유권과
만료를 검사한다. [보안](SECURITY.md#데이터-노출과-보존)과 [운영](OPERATIONS.md#행-보존)을 보라.

## 오디오와 Workspace

오디오는 파일 가져오기·전사·후처리를 영속 job으로 접수한다. 별도 worker가 DB 큐를 선점하고
체크포인트를 남겨 완료한 단계를 재사용한다. 후처리 Version은 접수 시 고정하고, 재귀 작업과
임의 외부효과 도구를 제한한다. 결과는 비공개 Artifacts에 보관하고 개인 Memory·Document 기록은
요청한 작업으로 수행한다. 실시간 음성 통화 기능은 아니다.
[오디오 설계](design/audio-processing-spec.md)와 [운영](OPERATIONS.md#오디오-작업-운영)을 따른다.

Workspace는 파일·Git·native CLI Session의 영속 공간이고 Sandbox는 작업을 실행하는 격리 자원이다.
`parameters.workspaceTools`, 프로젝트 정책, 사용자 권한과 배포 설정이 함께 충족되어야 Agent에
도구가 제공된다. GitHub MCP의 로그인은 worker의 Git 자격 증명이나 저장소 허용 정책을 대신하지 않는다.

별도 Workspace worker가 실행·관찰·검사·체크포인트·만료 정리를 담당한다. 커밋·푸시·PR·main 반영은
검토한 Git 상태에 대한 단계별 승인으로 실행한다. 결과와 CI 대기는 연결된 원래 Chat에 전달할 수 있다.
불확실한 작업은 자동 재실행하지 않는다. [Workspace 설계](design/workspaces.md)를 보라.

## 외부 실행과 연동

Predict·OpenAI 호환 Chat Completions·Agent SSE는 프로젝트 실행 API다. 프로젝트 token은
해당 프로젝트의 실행 credential이며 사용자 Session이나 Workspace 권한을 만들지 않는다.
로그인 사용자로 실행하더라도 stateless API에는 영속 Chat 승인 화면이 없다.

Slack·Telegram·Teams는 프로젝트별 bot으로 같은 메시징 파이프라인을 사용한다. 인증과 참여 판단,
첨부 수신·응답 렌더링은 플랫폼별 adapter가 담당한다. Slack은 플랫폼 thread를 읽고,
Telegram·Teams는 Studio가 한정된 transcript를 보관한다. 중복 delivery를 막지만 실행 중 급사한
비멱등 작업을 자동 재생하지 않는다. [메시징 설계](design/messaging.md)를 보라.

Webhook은 인증한 이벤트를 접수하고 발행 버전을 백그라운드 실행한다. Schedule은 외부 ticker가
scan API를 호출해야 진행된다. A2A는 에이전트 간 task 프로토콜, AG-UI는 앱의 화면 이벤트와
frontend tool 프로토콜이다. 각 표면의 권한·이력은 서로 독립적이다.
정확한 요청·상태·응답은 [API](API.md), 자동화 동작은 [Trigger 설계](design/triggers.md)에 있다.

## 저장·보안·운영

DB에는 네 영역이 있다. `items`는 대부분의 제품 상태, Better Auth 테이블은 인증,
`catalog_vectors`는 검색 벡터, `runtime_sessions`는 SDK 이력과 승인을 저장한다.
키와 접근 패턴은 [아키텍처](ARCHITECTURE.md#postgresql-아이템-테이블-설계)가 설명한다.

부팅은 필수 설정 검사, migration, 관리자 bootstrap, 감사 sink 연결과 모델 카탈로그 갱신을
순서대로 수행한다. 관리형 MCP 복구는 listen을 막지 않는 별도 작업이다. 만료 행 삭제는
schedule scan, 오디오 파일 정리는 audio worker, Sandbox 정리는 Workspace worker가 담당한다.
프로세스가 켜져 있다는 사실만으로 이 작업들이 진행되는 것은 아니다.

인증은 Better Auth, 인가는 route gate와 유스케이스의 소유권 검사로 나눈다. 저장된 secret은
문맥에 묶인 인증 암호화와 마스킹을 적용한다. 운영자가 등록한 URL과 모델이 고른 URL의 허용
범위는 다르다. 선택적 PII 필터는 모델 요청을 치환하지만 저장 데이터 전체를 익명화하지 않는다.
[SECURITY](SECURITY.md)가 이 경계와 예외를 소유한다.

Usage는 비용, Trace는 실행 구조·시간·상태, Audit은 민감 작업의 행위자와 대상을 기록한다.
`/api/health`는 liveness, `/api/ready`는 하류 연결과 draining, `/api/metrics`는 프로세스 지표다.
종료 시 readiness가 내려가며 실제 트래픽 차단과 drain 시간은 배포 설정과 서버 런타임에 달려 있다.
[OPERATIONS](OPERATIONS.md)에서 프로브·보존·릴리스·장애 대응을 확인한다.

## 코드를 읽고 변경하기

의존 방향은 `app → application → domain ← infrastructure`다. `lib`는 서버 설정·인증·조립,
`shared`는 의존성 없는 헬퍼를 둔다. application에 어댑터를 주입하며
`container.ts`를 역으로 import하지 않는다. 허용된 조립 지점과 주요 경로는
[ARCHITECTURE](ARCHITECTURE.md), 상수·형태·정책의 단일 소유 위치는 [OWNERSHIP](OWNERSHIP.md)에 있다.

[DEVELOPMENT](DEVELOPMENT.md)는 로컬 셋업, 테스트별 전제와 현재 CI 범위를 설명한다.
[AGENTS.md](../AGENTS.md)와 변경 영역의 로컬 지침을 읽고 관련 검사를 실행한다.
[MILESTONES](MILESTONES.md)는 미완료 작업과 완료 조건을 관리하며, 완료 이력은 git과 Release에 남긴다.

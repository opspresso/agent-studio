# 기능 현황

현재 구현된 기능과 사용 조건을 화면·API·실행 경로·worker 기준으로 정리한다.
선택 기능은 배포 환경의 설정에 따라 활성화한다.

개념과 연결 관계는 [시스템 개요](AGENT_STUDIO.md), HTTP 계약은 [API](API.md),
활성 조건과 제한값은 [CONFIGURATION](CONFIGURATION.md), 실행 원리는
[설계 문서](ARCHITECTURE.md#서브시스템)를 따른다. 개발 계획은 [MILESTONES](MILESTONES.md)에서 관리한다.

## 명칭과 기능 경계

| 현재 명칭 | 실제 역할 |
|---|---|
| Agents | 현재 설정을 저장하고 실행하는 단위 |
| Tools | MCP 서버 등록·연결·운영 기능 |
| Plugins | Skills와 MCP 서버를 가져오는 동기화 묶음 |

Agent는 기본 모델·fallback 모델·이미지 도구 모델을 사용한다.
Reasoning은 모델의 capability와 실행 설정으로 제어한다.

## 1. Agents

### 기본 관리

- Agent 목록과 검색: 이름·표시 이름·설명.
- 고유 이름, 표시 이름, 설명, 소유자, 부서 코드.
- Agent 생성.
- 표시 이름·설명·부서 코드 수정.
- Agent 복제.
- Agent 삭제.
- 공개 범위 표시.
- 조직 공개 / 비공개 설정.
- 비공개 Agent의 사용자 이메일 초대.

현재 공개는 로그인한 조직 사용자에게 공개한다는 의미다. 초대 사용자는 조회·실행·복제가
가능하지만 편집자는 소유자·관리자다.

### Agent 실행

모든 Agent는 같은 도구 실행 경로를 사용한다. 이미지 생성·편집은
Agent의 GenerateImage·EditImage 도구로 제공한다.

### 현재 Agent 설정

- 하나의 현재 설정 조회·전체 저장.
- 저장하지 않은 변경 표시와 Prompt preview.
- 조회 권한이 있는 사용자의 읽기 전용 조회.
- Project 메타데이터·설정의 동시 저장 충돌 검사.
- 새 실행에 저장 내용 적용, 진행 중 실행·Audio 작업의 설정 snapshot 유지.
- 승인 대기 중 설정·연결 변경 검사와 중복 재개 방지.

실험을 분리하려면 Agent를 복제한다.

### 모델과 프롬프트

Agent에 기본 모델과 fallback, 프롬프트와 생성 설정을 저장한다.

- 기본 모델 선택.
- 모델 검색·즐겨찾기 그룹·capability 확인.
- Fallback 모델 선택.
- 시스템 프롬프트.
- Temperature.
- 최대 출력 토큰.
- Presence penalty.
- Reasoning effort: 기본값 / low / medium / high.
- Reasoning 표시·기록 여부.
- Structured output 활성화.
- JSON Schema 입력·구문 검사.
- 요청자 정보 전달 여부: 이름, 표면이 제공하는 시간대·아바타. 이메일은 모델용 요청자 정보에서 제외.
- PII filtering: 이메일·전화번호·한국 주민등록번호·카드번호 치환.

Agent는 대화 메시지를 입력으로 사용한다.
Fallback은 첫 출력 전 429·5xx 오류에서 한 번 전환한다.
이미지 도구는 별도의 이미지 모델을 사용하며 PII filtering을 켜면 도구 프롬프트에도 적용한다.

### Agent 역량과 실행 정책

- 복수 Skills 연결.
- 복수 MCP 서버 연결.
- 서버별 사용할 도구 선택.
- Agent별 MCP 헤더 추가·교체·제거.
- MCP 결과의 원본 파일 매핑 설정.
- 프로젝트별 MCP OAuth 연결·재인증·해제.
- 로컬 프로젝트를 하위 Agent로 연결.
- Handoff.
- Agent-as-Tool 위임.
- 이미지 도구를 가진 Agent 위임.
- 최대 Agent 턴 수.
- 최대 입력 문자 수.
- 차단할 도구 이름 목록.
- 승인이 필요한 도구 이름 목록.
- 도구 입력 스키마 검증.
- 위임 깊이·순환·남은 턴 검사.
- 잘린 결과·누락된 역량·실행 손실 경고.

### Memory·자동 검색

- 실행 전 Memory recall 활성화.
- 연결된 MCP의 `recall`로 관련 기억 조회.
- 조회한 기억을 모델 문맥에 추가.
- MCP가 제공하는 기억 저장 도구 사용.
- Dynamic capabilities 활성화.
- Skill·MCP 서버·MCP 도구의 의미 기반 검색.
- Embedding 검색과 선택적 Rerank.
- 명시적으로 연결한 역량에 검색 결과 추가.
- 검색된 역량·준비 경고 표시.

장기 Memory는 외부 MCP에서 관리하며 Chat 이력과 별도 문맥으로 사용한다.
로컬 Project는 명시적 하위 Agent 연결로 사용한다.

### 내장 도구

- `Skill`: 지침·참고 파일 읽기.
- `GenerateImage`, `EditImage`: 이미지 생성·편집.
- `FetchUrl`: URL 내용 읽기.
- `SaveFile`: 텍스트 계열 파일 생성.
- `File`: 문서 읽기·검사·생성·편집.
- `Workspace`: Sandbox 작업·코딩·Git 검토 요청.
- `ImportFile`, `TranscribeAudio`, `AudioJob`: 파일 가져오기·전사·오디오 작업.
- Slack 읽기 도구: `SlackHistory`, `SlackThread`, `SlackUser`, `SlackUsers`, `SlackChannels`, `SlackReactions`.

도구마다 Agent 설정·저장소·연동·호출자 권한 등의 활성 조건이 있다.

구현 근거: [Project·AgentConfiguration 정의](../src/domain/project/types.ts),
[Agent 설정 편집기](../src/app/agents/[name]/_components/AgentConfigurationEditor.tsx),
[내장 도구 목록](../src/domain/llm/toolNames.ts).

## 2. Playground

### Playground

- 현재 Agent 설정 조회.
- 설정 편집과 실행 결과를 함께 표시.
- 저장 전 초안의 Prompt preview: 조립된 시스템 메시지, 선택적 검색 요청,
  실제 도구 JSON Schema, 발견한 역량, Memory·바인딩·PII 관련 경고, 결과 복사.
- 저장한 Agent 설정 테스트 실행.
- 텍스트 메시지 입력.
- 이미지·문서 첨부.
- 이미지 생성·원본 이미지 편집.
- 답변 스트리밍.
- Reasoning·도구 호출·하위 Agent 진행 표시.
- 생성 이미지·파일 표시.
- 비용·오류·경고·종료 상태 표시.

Prompt preview는 모델 답변을 생성하지 않지만 검색·MCP 조회·Memory recall은 실제 수행할 수
있다. 실제 Run은 저장한 Agent 설정을 실행한다.

구현 근거: [Prompt preview](../src/app/agents/[name]/_components/PromptPreview.tsx),
[실행 패널](../src/app/agents/[name]/_components/RunPanel.tsx).

## 3. Chats

개편 후에도 Agent의 기본 실행 경로로 유지한다.

- 접근 가능한 Agent 프로젝트 선택·검색.
- 새 대화 생성.
- 마지막 선택 프로젝트 기억.
- 첫 메시지 기반 제목 자동 생성.
- 본인 대화 목록·최근 활동순 표시.
- 일반 Chat과 Workspace 대화 구분.
- 목록 더 보기.
- 실행 중 표시.
- 대화 삭제.
- 텍스트·이미지·문서 첨부.
- 파일 선택·드래그앤드롭·붙여넣기.
- Markdown 답변·복사.
- Reasoning 표시.
- 도구 이름·인자·결과 표시.
- 하위 Agent·위임 경로 표시.
- 실행 시간 표시.
- 이미지 확대·파일 미리보기·다운로드.
- Stop으로 실행 취소.
- 이전 대화·모델·도구 이력 유지.
- 화면 이동·연결 종료 후 서버 실행 유지.
- 재접속 시 실행 상태·제한된 로그 이어받기.
- 도구별 승인·거절.
- 승인 체크포인트에서 실행 재개.
- 불확실하게 중단된 승인 실행 폐기.
- Workspace 승인·CI 결과 수신 및 후속 실행.

Chat은 소유자 개인 대화이며 연결이 종료돼도 서버에서 실행을 이어간다.
서버가 중단된 실행은 저장된 상태와 외부 효과를 확인한 뒤 처리한다.

구현 근거: [새 대화](../src/app/chats/_components/NewChatPanel.tsx),
[대화 소유권·조회](../src/application/chat/getChat.ts), [Chat 설계](design/chat.md).

## 4. Models

### 목록·탐색

`/models`는 관리자가 등록한 모델의 읽기 전용 목록이다.

- 전송 모델 ID·표시 이름·provider.
- 모델 유형: Text, Image, Embedding, Rerank, Transcription, Decisions.
- Tools·Structured output·Vision·Reasoning capability.
- Context window·출력 토큰 한도.
- 입력·출력·캐시 등 유형별 가격.
- 이름·ID·제작사·provider 검색.
- Provider·유형·capability 필터.
- 이름·가격 정렬.
- 검색·필터·정렬·페이지 상태 기억.

### 관리자 관리

Settings → Models에서 연결·등록·사용 설정을 관리한다. Self-hosted도 같은 등록 흐름을 사용한다.

- 이름·종류·API base URL·키로 프로바이더 연결 등록.
- 프로바이더의 전체 모델 목록 조회·필터·선택 등록과 직접 등록.
- 선택된 모델만 보기와 삭제.
- 등록 모델의 표시 이름·유형·문맥 크기·출력 토큰·capability·가격 수정.
- 프로바이더 목록에 등록 모델이 있는지 상태 확인. 실제 추론 성공은 별도로 검증한다.

### 모델 사용 설정

- 새 Agent와 모델 선택기에 사용할 기본 모델.
- Capability 검색용 Embedding 모델.
- Embedding 변경 시 확인 후 재색인.
- Rerank 모델·최소 점수.
- Codex·Claude·OpenCode별 Workspace 모델.
- Workspace 모델 선택 해제로 해당 runtime 비활성화.

미등록 모델과 삭제된 모델을 사용하는 새 실행은 거부한다. `UNKNOWN_MODEL_POLICY`는 등록됐지만
가격이 없는 모델의 실행 허용 여부만 제어한다. 공개 모델 메타데이터는 조회 결과의 누락된 facts를
보완하며 모델을 자동 등록하지 않는다. 등록·삭제 제약과 오프라인 메타데이터 갱신은
[모델 등록과 사용](CONFIGURATION.md#모델-등록과-사용)을 따른다.

구현 근거: [Models 화면](../src/app/models/page.tsx),
[모델 등록](../src/application/llm/modelRegistry.ts),
[모델 선택](../src/application/llm/modelSelection.ts).

## 5. Plugins

- 설치된 Plugin 목록·검색.
- 이름·버전·설명.
- 포함된 Skill·MCP 서버 수.
- 동기화 시각·commit.
- 상세 구성 요소 조회.
- 원본 저장소·branch·경로·commit 링크.
- GitHub 저장소 동기화.
- 오프라인 `.tar / .tar.gz / .tgz` 업로드 동기화.
- Skill 본문·참고 파일 가져오기.
- MCP 서버 정의·설명·운영 문서 가져오기.
- 기존 항목 갱신 및 출처 인수.
- 변경·생성·스킵·실패 보고서.
- 변경된 필드·스킵 이유 표시.
- 원본에서 사라진 항목 감지.
- 해당 항목을 사용하는 프로젝트 표시.
- 사라진 Plugin·Skill·MCP의 명시적 선택 삭제.
- 최근 동기화 보고서 보관.
- 외부 ticker 기반 자동 동기화.
- 동기화 후 capability 재색인.

Plugin은 원본 동기화로 관리한다. 항목 삭제는 사용자가 명시적으로 선택한다.
MCP header credential은 Studio의 자격 증명 설정에서 관리한다.

구현 근거: [Plugin 목록](../src/app/plugins/page.tsx),
[동기화 보고서](../src/app/_components/PluginSyncSummary.tsx),
[Plugin 동기화](../src/application/plugin/syncPlugins.ts).

## 6. Skills

- Skill 목록·검색.
- 이름·설명·Plugin 출처·참고 파일 수.
- 수동 Skill 생성.
- Markdown 지침 본문 작성.
- 설명·본문 편집.
- 수동 Skill 삭제.
- 본문 조회.
- 참고 파일 경로·내용 조회.
- 소유 Plugin으로 이동.
- 프로젝트에 명시적으로 연결.
- 자동 capability 검색으로 발견.
- 실행 중 필요한 지침·참고 파일만 읽기.

Plugin 소유 Skill과 참고 파일은 원본 동기화로 관리한다. Agent는 필요한 지침과 파일을 읽어 사용한다.

구현 근거: [Skill 목록](../src/app/skills/page.tsx),
[Skill 상세](../src/app/skills/[name]/page.tsx), [Skill 로딩](../src/application/skill/loadSkill.ts).

## 7. Tools — MCP 서버

### 원격 서버

- 목록·검색.
- 이름·URL·모델용 설명·운영 문서.
- HTTP 헤더·자격 증명.
- 서버 등록·편집·삭제.
- Plugin 출처 표시.
- 자격 증명 마스킹.
- 연결 테스트.
- 제공 도구 이름·설명·개수 조회.
- 연결 오류 표시.
- 프로젝트에서 사용할 도구 선택.

연결 테스트로 MCP 도구를 발견하고 이름·설명·연결 상태를 확인한다.

### OAuth

- 서버 인증 메타데이터 발견·재발견.
- Authorization server 선택.
- Resource·authorize/token endpoint 조회.
- Client 등록 방식 확인.
- 공유 Client ID·Client Secret·Redirect URI 설정.
- OAuth 설정 제거.
- 프로젝트별 연결·재인증·해제.
- Token 갱신·재인증 필요 상태 처리.

### Managed MCP — 조건부

- Docker 기반 서버 생성·시작.
- 이미지·포트·환경변수·실행 인자·endpoint 설정.
- 설명·운영 문서.
- 실행·연결 상태 조회.
- 재시작.
- 실행 설정 변경 시 재시작.
- 컨테이너와 등록 항목 삭제.
- 앱 부팅 후 상태 확인·복구.

Docker와 Managed MCP 설정이 필요하다. Kubernetes 관리형 runtime은 현재 구현돼 있지 않다.

구현 근거: [MCP 관리 화면](../src/app/tools/[name]/page.tsx),
[Managed MCP 생성](../src/app/tools/_components/ManagedMcpModal.tsx), [MCP 설계](design/mcp.md).

## 8. Integrations·API Reference

Integrations에서 프로젝트 인증과 외부 연동을 설정하고 API Reference에서 호출 계약과 예제를 확인한다.

### 프로젝트 API Token

- 생성.
- 상태·마스킹 값·발급 시각 조회.
- 값 보기·숨기기·복사.
- 재발급.
- 폐기.
- 소유자 tier에 따른 발급·사용 제한.

현재 프로젝트당 Token 하나다.

### 실행 API·Reference

- Predict 완료형·스트리밍.
- Agent raw chunk 스트리밍.
- OpenAI-compatible Chat Completions.
- Agent 이미지 도구의 결과 반환.
- 메시지·인라인 이미지·문서 입력.
- 모델·사용량·비용·경고·종료 이유·출력 파일 반환.
- 선택적 대화 ID 전달.
- Endpoint·인증·요청/응답·오류 문서.
- curl·Python·Node.js 예제.
- 예제 복사.

API Reference는 프로젝트 주소로 현재 Agent 설정을 호출하는 예제를 제공한다.

### Slack

- App manifest 생성·복사.
- Bot Token·Signing Secret.
- 활성화·연결 테스트·해제.
- 이벤트 endpoint 안내.
- 제안 프롬프트·채널 키워드 설정.
- DM·mention·참여 중인 thread 응답.
- 키워드 기반 참여.
- Assistant 시작 안내·제안 프롬프트.
- `!help / !mute / !unmute`.
- 스트리밍 답변·진행 표시.
- Thread 문맥·이미지·문서 읽기.
- 생성 이미지·파일 전달.
- Private 프로젝트의 사용자 접근 검사.
- Schedule·비용 알림 목적지.

### Telegram

- Bot Token.
- 활성화·연결 테스트·해제.
- Webhook 자동 등록·해제·재등록.
- 개인 Chat·그룹 mention·봇 답장 처리.
- `/start / /help`.
- 타이핑·편집 방식 응답·긴 답변 분할.
- 이미지·문서 입력과 결과 전달.
- 대화 이력·forum topic 구분.
- 관찰한 Chat·topic을 알림 목적지로 선택.

음성 메시지 자동 전사 기능으로 보면 안 된다.

### Microsoft Teams

- App ID·Client Secret·선택 Tenant ID.
- 활성화·연결 테스트·해제.
- Messaging endpoint 안내.
- 개인 Chat·채널/그룹 mention 응답.
- 타이핑·메시지 편집·긴 답변 분할.
- 이미지·문서 입력과 결과 전달.
- 대화 이력.
- Schedule·비용 알림 목적지.

배포 담당자가 준비한 Azure Bot·Teams App의 자격 증명을 연결한다.

구현 근거: [연동 화면](../src/app/agents/[name]/integrations/page.tsx),
[API Reference](../src/app/agents/[name]/api-reference/endpoints.ts),
[메시징 설계](design/messaging.md).

## 9. Webhook·Schedules

개편 시 Webhook과 Cron(Schedules)을 선택적 어댑터로 분리한다. 예약·이벤트 자동화 기능은
유지하되 Agent 실행 코어와 분리하며, 다른 어댑터도 같은 계약으로 추가할 수 있어야 한다.

### Webhook

- 프로젝트별 Webhook 설정.
- 호출 주소 복사.
- 활성화.
- Secret 생성·확인·회전.
- JSON payload를 사용자 메시지로 전달.
- 겹침 실행 허용 여부.
- Secret header·GitHub 서명 검증.
- 중복 요청 억제.
- 접수 후 백그라운드 실행.
- 현재 Agent 설정 실행.
- 최근 실행 상태·결과·오류·경고.
- 생성 Artifact 보관.
- API에서 설명 설정.

### Schedules

- 여러 Schedule 생성·조회·수정·삭제.
- Schedule ID.
- 5필드 cron.
- IANA 시간대.
- 실행 메시지.
- 활성화.
- 겹침 실행 허용 여부.
- 소유자 문맥으로 실행 여부.
- Slack·Telegram·Teams 결과 배달.
- 최근 실행 결과.
- 플랫폼별 배달 성공·실패.
- 제한된 놓친 실행 보충.
- 중복 tick 억제.
- 유실된 실행 상태 정리.
- API에서 설명 설정.

예약 실행은 외부 ticker가 호출한다.

구현 근거: [Webhook 설정](../src/app/agents/[name]/settings/WebhookSection.tsx),
[Schedule 설정](../src/app/agents/[name]/settings/SchedulesSection.tsx), [Trigger 설계](design/triggers.md).

## 10. Workspace·Sandbox·Coding

### 작업 실행

- Chat / Workspace 실행 방식 선택.
- 프로젝트 선택.
- Runtime 선택: Command, Codex, Claude, OpenCode.
- Script 또는 자연어 코딩 작업 접수.
- 저장소·기준 브랜치 선택.
- 같은 Workspace에서 후속 작업.
- 작업 상태·실행 이력.
- stdout·stderr·메시지·경고 조회.
- Git Diff 조회.
- Test·Lint·Build 결과 조회.
- 작업 취소.
- Workspace 종료.
- PR 링크·CI 상태 조회.

### 영속성

- 작업 큐.
- 파일·Git·native Session 체크포인트.
- 유휴 Sandbox 정리.
- 후속 요청 시 복구.
- Worker 재시작 후 작업 관찰·이어받기.
- 결과가 불명확한 외부 작업의 자동 재실행 방지.

### 프로젝트 정책

- Workspace 도구 활성화.
- 기본 Runtime.
- 저장소·허용 owner 목록.
- 저장소 접근 범위: 지정 저장소, 지정 owner, 서버 계정이 접근 가능한 전체,
  프로젝트가 만든 신규 저장소 자동 허용.
- 유휴 TTL.
- Test·Lint·Build 명령.
- 배포 허용 workflow.

### Git·배포 승인

- Commit.
- Commit & push.
- 작업 브랜치 Push.
- Draft PR·PR 생성·상태 변경.
- PR 병합.
- 조건부 main fast-forward push.
- 허용된 GitHub workflow 실행.
- 정확한 HEAD·Diff·CI 상태를 확인한 승인·거절.
- 작업 결과·거절·실패·결과 불명 상태 보관.
- GitHub Webhook 기반 PR·CI 상태 갱신.
- 원래 Chat으로 결과 전달·후속 실행.

### Agent 도구로 가능한 추가 작업

- 저장소 접근 확인.
- 새 저장소 생성.
- Workspace 생성·선택.
- 저장소 연결.
- 작업 실행·상태 확인·대기·취소·종료.
- Git 검토 준비와 승인 URL 발급.

Docker·별도 worker·runtime 모델 설정이 필요하다. Command 실행은 모델을 사용하지 않는다.
작업을 제출하고 출력·Diff·검사 결과를 확인하는 화면을 제공한다.
Agent의 Workspace 도구는 로그인한 member 이상 사용자의 실행에서 제공하며, 프로젝트 Token이나
메신저·예약 실행이 같은 권한을 자동으로 얻지는 않는다.

구현 근거: [Workspace 화면](../src/app/workspaces/_components/WorkspacePanel.tsx),
[Workspace 도구](../src/application/workspace/workspaceTool.ts), [Workspace 설계](design/workspaces.md).

## 11. Documents·파일 생성·편집

### 읽기·추출

- UTF-8 텍스트·Markdown·CSV·JSON·XML·YAML.
- HTML.
- PDF 텍스트 레이어.
- DOCX·XLSX·PPTX.
- HWP 5.x·HWPX.
- ODT·ODS·ODP.
- RTF.
- 추출 실패·누락·길이 초과 경고.
- Artifact ID로 저장된 파일 읽기.

### 문서 검사

- 문서 구조.
- 편집 대상 텍스트 위치.
- 시트·셀 주소·값·수식.
- 숨김 시트 포함 여부.
- 범위를 나눠 조회.

### 문서 생성

- DOCX.
- PDF.
- HWPX.
- PPTX.
- XLSX.
- 제목·파일명·문서 스타일 프로필.
- 지원 형식의 이미지 삽입.
- 시트·셀·수식 지정.
- 생성 결과의 구조 검사·재열기 검증.

### 파일 편집

- 텍스트·HTML·SVG 문자열 교체.
- JSON 수정 및 문법 검사.
- DOCX·PPTX·HWPX의 지정 텍스트 교체.
- XLSX 셀 값·수식 변경.
- 원본 보존 및 수정본 생성.
- 원본과 수정본의 관계 기록.

### SaveFile

- HTML·Markdown·TXT·CSV·JSON·SVG 생성.
- 다운로드 및 Artifact 연결.

업로드한 문서는 추출문을 모델 문맥에 넣거나 파일 ID로 읽는다.

구현 근거: [문서 처리 계약](../src/domain/document/processor.ts),
[File 도구](../src/application/document/fileTool.ts), [문서 설계](design/documents.md).

## 12. Audio Processing

- MP3·WAV·FLAC·Ogg 업로드.
- 원본 파일 가져오기.
- Transcription 모델 선택.
- 언어 지정.
- 원본 보존 기간·시간대.
- 후처리 Agent 선택.
- 접수 시점의 후처리·전달 설정 보존.
- 외부 MCP 저장 목적지.
- Documents·Memories 저장 여부.
- 활성화·활성 작업 수·발생당 작업 수 설정.
- 가져오기만 / 전사 / 후처리 / 전체 처리.
- 영속 작업 큐·중복 접수 억제.
- 긴 오디오 변환·분할 전사.
- 완료된 구간 재사용.
- 긴 전사문 분할 후처리·통합.
- 단계·진행률·시도 횟수·오류 조회.
- 자동 재시도·수동 재시도·취소.
- 종료된 작업 이력 삭제.
- 원본 다운로드.
- 전사 JSON·요약 Markdown·구조화 결과·대화록.
- 외부 Documents·Memory 저장 결과 확인.
- 원본·파생 파일 만료 정리.
- Agent가 `AudioJob`으로 작업 제출·조회·읽기.

저장소·전사 채널·별도 worker를 구성해 프로젝트 소유자인 member 이상의 개인 오디오 파일을 처리한다.
외부 Documents·Memory 저장에는 수신 MCP의 도구와 계약이 필요하다.

구현 근거: [Audio 화면](../src/app/agents/[name]/audio/page.tsx),
[Audio 도구](../src/application/audio/toolDefinitions.ts), [오디오 설계](design/audio-processing-spec.md).

## 13. Artifacts

- 개인 갤러리.
- 프로젝트별 갤러리.
- 이미지·문서·오디오 필터.
- 불러온 목록에서 파일명·프롬프트·프로젝트·Agent·모델 검색.
- 목록 더 보기.
- 이미지 썸네일·확대.
- 원본 첨부와 생성 파일 구분.
- 파일명·크기·생성 시각·생성 모델·출처 표시.
- 다운로드.
- HTML·Markdown·CSV·JSON·SVG·텍스트 미리보기.
- HTML 상호작용 미리보기: 버튼·입력·스크립트·Canvas, Sandbox iframe, Stop·Restart,
  스크립트 오류·차단 리소스 안내.
- 삭제.
- 실행·사용자·하위 Agent·원본 관계 보관.
- API·자동화 등 다른 실행 표면의 출력 수집.

산출물은 파일별 접근 권한으로 보호하며 사용자·프로젝트별 갤러리에서 조회한다.
Office·PDF 원본은 다운로드해 확인한다. 개인 Audio 원본·파생 파일은 소유권과 만료 조건으로
접근을 검사한다.

구현 근거: [Artifact 갤러리](../src/app/artifacts/_components/ArtifactGallery.tsx),
[산출물 권한](../src/application/artifact/artifactUseCases.ts).

## 14. Usage·비용 한도

### 사용량 조회

- 기간·빠른 기간 선택.
- 전체 비용.
- 모델 호출 수.
- 평균 호출 비용.
- 일별 비용 차트.
- 프로젝트별 집계.
- 모델별 집계.
- Provider별 집계.
- 부서별 집계.
- 캐시 사용 비율.
- 프로젝트별 호출자 수.
- 호출자별 호출 수·비용.
- 개인 사용량.
- 개인 월 예산 사용률.
- API·저장 데이터의 입력·출력·캐시 토큰과 비용.

위치는 전체 Overview, 프로젝트 Usage, 개인 Profile로 나뉜다. 전체 Overview는 프로젝트·모델·
provider·부서별, 프로젝트 Usage는 모델·provider별, Profile은 프로젝트·모델·provider별 집계를
제공한다. 호출자별 상세는 소유자·관리자 전용이다.

### 프로젝트 비용 정책

- 일별 경고 한도.
- 일별 차단 한도.
- 월별 경고 한도.
- 월별 차단 한도.
- 한도 해제.
- Slack·Telegram·Teams 알림 목적지.
- 임계액 도달 알림.
- 차단 한도 도달 후 추가 실행 거부.
- UTC 일·월 기준 집계.

### 사용자 등급 정책

- Guest·Member·Admin별 월 비용 정책.
- 등급별 동시 실행 정책.
- 프로젝트 생성 가능 여부.
- 프로젝트 API Token 사용 가능 여부.

등급별 한도는 코드 정책으로 관리한다. 비용 가드는 기록된 사용량을 기준으로 새 실행을 제어한다.

구현 근거: [전체 비용 화면](../src/app/_components/Dashboard.tsx),
[사용량 조회·권한](../src/application/usage/usageUseCases.ts),
[등급 정책](../src/domain/member/tiers.ts), [비용·기록 설계](design/observability.md).

## 15. Traces

- 프로젝트별 기간 조회.
- Trace 상세.
- 실행 시간·상태.
- 완료·실패·취소·승인 대기·턴/출력 제한 구분.
- 호출자·대화 ID·Agent 호출 경로 기록.
- 모델·도구·하위 Agent·준비·Guardrail span.
- 입력·출력·캐시·Reasoning 토큰.
- Span별 상태·시간.
- 준비한 역량·Memory 통계.
- 오류·경고.
- 하위 Trace 이동.
- 생략된 span 수 표시.
- Agent 실행의 상시 기록.
- 선택적 OTLP export.

소유자·관리자가 span 표에서 실행 상태·시간·사용량을 확인한다.

구현 근거: [Trace 목록](../src/app/agents/[name]/traces/page.tsx),
[Span 표시](../src/app/agents/[name]/traces/TraceContent.tsx), [Trace 설계](design/observability.md#trace).

## 16. Audit

- 관리자 감사 기록 조회.
- 기간 필터.
- 시각·행위·행위자·대상·상세 표시.
- 시크릿 조회·발급/회전·폐기 기록.
- 관리자 프로젝트 변경 기록.
- 설정 변경·모델 등록·수정·삭제·기본값 변경.
- 프로젝트 삭제.
- 공유 레지스트리 삭제·소유 출처 변경.
- 타인 Artifact 삭제.
- 사용자 tier 변경.
- 보존 기간에 따른 정리.

기간을 선택해 감사 기록을 조회한다.

구현 근거: [감사 화면](../src/app/audit/page.tsx), [감사 대상 행위](../src/domain/audit/types.ts).

## 17. 인증·Members·Profile

### 인증

- Keycloak 로그인.
- 표준 OIDC 로그인.
- Google 로그인.
- 선택적 이메일·비밀번호 로그인.
- 초기 관리자 부트스트랩.
- 허용 이메일 도메인 제한.
- 세션 로그인·로그아웃.
- 로그인 후 원래 페이지로 복귀.
- 역할별 페이지·API 접근 제어.

### Members

- 관리자용 사용자 목록.
- 이름·이메일·프로필 이미지.
- 가입 시각·마지막 로그인.
- Guest / Member / Admin 변경.
- 설정으로 지정한 관리자 tier 잠금.

### Profile

- 본인 이름·이메일·이미지·tier.
- 가입 시각·마지막 로그인.
- 동시 실행·월 예산 정책.
- 이번 달 지출·한도 사용률.
- 기간별 개인 사용량.
- 프로젝트·모델·provider별 개인 비용.

Profile에서 본인 정보와 사용량을 조회한다.

구현 근거: [인증 구성](../src/lib/auth.ts), [Members 화면](../src/app/members/page.tsx),
[Profile 화면](../src/app/profile/page.tsx), [인증·인가 계약](SECURITY.md).

## 18. Settings

| 탭 | 관리 항목 |
|---|---|
| General | Public Base URL, Artifact 접근 방식, 관리자 이메일·허용 도메인, 가격 미지정 등록 모델의 실행 정책 |
| Plugins | Plugin GitHub 저장소·Branch |
| Models | 프로바이더 연결, 모델 선택·등록 관리, 기본·Workspace·검색 모델 사용 설정 |
| Keys | GitHub Token |

### 설정 공통

- 일반 설정 값의 출처 표시: override / env / default / unset.
- 현재 탭에서 변경한 필드만 DB override로 저장.
- 일반 설정의 override 해제 시 환경변수로 복귀. 모델 선택은 DB에서만 관리한다.
- 시크릿 마스킹·암호화 보관.

SSO·DB·스토리지·worker·retention은 배포 설정으로 관리한다. 필드와 적용 범위는
[설정 화면](CONFIGURATION.md#설정-화면)을 따른다.

구현 근거: [Settings 탭 정의](../src/app/settings/tabs.ts),
[Settings API](../src/app/api/settings/route.ts), [설정 계약](CONFIGURATION.md).

## 19. 공통 화면·운영 기능

### 공통 화면

- 공개 소개 화면.
- 로그인 후 Overview.
- 최근 프로젝트·대화.
- 새 프로젝트·Chat 바로가기.
- 카탈로그 수·비용 요약.
- 최초 사용 안내.
- 사용 가이드.
- 한국어·영어.
- Light·Dark·System 테마.
- 반응형 메뉴.
- 사용자 메뉴·로그아웃.

### 운영·기반 기능

- 사내 설치·공개 인터넷 없는 필수 실행 경로.
- 부팅 시 설정 검사·DB migration.
- S3-compatible 저장소.
- 시크릿 암호화·마스킹.
- URL 접근·SSRF 제한.
- 실행 동시성·시간·문맥·도구 결과 상한.
- Liveness·Readiness endpoint.
- Prometheus 메트릭.
- 선택적 OTLP tracing.
- 종료 시 draining.
- 외부 ticker 기반 예약·Plugin 동기화·카탈로그 재색인.
- 만료 데이터 정리.
- Audio·Workspace worker.
- Managed MCP 복구.

구현 근거: [공통 메뉴](../src/components/AppLayout.tsx),
[Overview](../src/app/_components/Overview.tsx), [부팅](../src/instrumentation.ts),
[메트릭](../src/app/api/metrics/route.ts), [운영 계약](OPERATIONS.md).

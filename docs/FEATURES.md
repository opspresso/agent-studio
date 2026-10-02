# 기능 현황

현재 구현된 기능, 활성 조건과 확인할 결과를 정리한다. 한 설치가 한 기업이며,
필수 부팅·로그인·Agent 실행·콘솔은 사내 서비스만으로 구성할 수 있다.

사용 절차는 [콘솔 Guide](../src/app/guide/page.tsx), HTTP 계약은 [API](API.md),
설정·상한은 [CONFIGURATION](CONFIGURATION.md), 배포·worker·보존은
[OPERATIONS](OPERATIONS.md)를 따른다. 미구현 작업은 [MILESTONES](MILESTONES.md)에서 관리한다.

## 제품 단위와 접근 권한

| 단위 | 역할·접근 범위 |
|---|---|
| Agent | 모델·프롬프트·역량·한도를 저장하는 실행 단위. public은 조직의 로그인 사용자에게 공개하며, private은 소유자·초대 이메일·관리자로 제한한다 |
| Skill | 모델이 이름·설명으로 선택한 뒤 본문과 참고 파일을 읽는 지침 |
| Tools | MCP 서버 레지스트리. 서버 설명은 모델용이고 운영 메모는 콘솔용이다 |
| Plugin | Skill·MCP 정의의 원본 묶음. GitHub 저장소 또는 checkout archive에서 동기화한다 |
| Chat | 소유자 개인 대화와 SDK Session. 화면 기록과 모델 이력은 별도로 보관한다 |
| Workspace / Sandbox | Workspace는 파일·native Session을 유지하고, Sandbox는 작업을 실행하는 일시적 컨테이너다 |
| Artifact | 첨부 원본·생성·수정 결과 파일. 개인 귀속과 Agent 접근 범위에 따라 조회한다. 비공개 Audio 파일은 소유자만 읽고 삭제한다 |

Agent 조회·실행·복제 권한과 편집 권한은 다르다. 초대는 편집 권한을 주지 않으며,
복제에는 Agent 생성 권한도 필요하다. 공유 레지스트리는 guest도 조회하며 관리자가 변경한다. guest는 member와 같은 메뉴를 읽기 전용으로 본다.
Agent 소유자·관리자는 설정·연동·Trace를 관리한다. 봇·토큰·자동화의 인증은 사용자 세션을 대신하지 않는다.

근거: [Agent 접근](../src/application/agent/agentUseCases.ts),
[등급 정책](../src/domain/member/tiers.ts), [인증·인가](SECURITY.md).

## 계정과 기본 화면

| 기능 | 조건·사용 위치 | 확인할 결과 |
|---|---|---|
| 로그인 | Keycloak·표준 OIDC·Google 또는 선택적 비밀번호 로그인. 허용 이메일 도메인과 초기 관리자 설정은 배포가 관리한다 | 로그인 후 원래 페이지로 돌아간다. 로그아웃은 앱 세션을 종료한다 |
| Members | 관리자 전용 사용자 목록·tier 변경. 설정에 지정한 관리자는 tier를 잠근다 | 이름·이메일·가입·마지막 로그인과 tier를 확인한다. 동시 변경은 사용자별 요청이 끝날 때까지 해당 입력을 잠근다 |
| 등급 설정 | Settings → Access에서 등급 추가·삭제와 월 USD 한도 관리 | admin·guest는 고정이고 admin은 무제한이다. 배정된 사용자가 있으면 삭제를 막는다. Chat·Workspace·Profile이 같은 한도를 사용한다 |
| Profile | 본인 계정·등급별 동시 실행·월 비용 정책 | 날짜 필터의 개인 사용량과 현재 UTC 월의 한도 사용률을 구분한다 |
| Overview | 최근 Agent·Chat·Workspace, 카탈로그 수, 비용 요약과 최초 사용 안내 | 목록 조회 실패를 빈 목록·0 비용으로 표시하지 않는다 |
| 공통 화면 | 공개 소개·로그인 없는 Guide, 한국어/영어, Light/Dark/System, 반응형 메뉴·계정 메뉴 | locale은 cookie로 유지하며 URL을 바꾸지 않는다. 필요한 정적 자산은 앱에서 제공한다 |

근거: [계정](../src/app/profile/page.tsx), [Members](../src/app/members/page.tsx),
[공통 화면](../src/components/AppLayout.tsx), [Overview](../src/app/_components/Overview.tsx).

## Agent 구성과 실행

| 기능 | 조건·사용 위치 | 확인할 결과 |
|---|---|---|
| Agent 관리 | 생성 가능한 tier. 목록에서 이름·표시 이름·설명 검색, 생성·복제·메타데이터·부서·공개 범위·초대 관리 | 식별자는 변경하지 않는다. 삭제된 이름은 재사용하지 않으며 Chat·Artifact는 각 보존 규칙을 따른다 |
| 현재 설정 | Playground에서 하나의 현재 설정을 저장한다. 독립 실험은 복제본을 사용한다 | 초안·미저장 상태를 표시하고 동시 설정 저장 충돌을 거절한다. Run은 저장된 설정을 사용한다 |
| 모델·출력 설정 | 등록된 도구 호출 가능 텍스트 모델, 선택적 fallback·이미지 도구 모델. Temperature·출력 토큰·Presence penalty·Reasoning effort·JSON Schema | 모델 capability를 검사한다. fallback은 첫 출력 전 재시도 가능한 전송 오류에 한 번 적용한다. 턴·출력 제한은 부분 답변으로 구분한다 |
| 실행 정책 | 최대 입력·턴 수, 차단·승인 도구 이름, 호출자 문맥·PII filtering | 스키마·위임 깊이·순환·턴 예산을 검사한다. PII filtering은 제한된 패턴 치환이며 완전한 익명화를 보장하지 않는다 |
| Prompt preview | member 이상이 현재 초안을 조립한다. 선택적 요청으로 Memory·동적 검색을 확인한다 | 시스템 메시지·실제 도구 Schema·발견한 역량·경고를 복사한다. 답변 생성은 하지 않지만 MCP·검색·recall은 실제 읽기다 |
| Playground Run | 저장된 설정에 텍스트·이미지·문서를 전달한다 | 답변·Reasoning·도구·하위 Agent·이미지·파일·비용·오류·경고를 스트리밍한다 |
| 로컬 위임 | 설정된 Agent를 명시적으로 바인딩한다 | Handoff 또는 Agent-as-Tool로 실행한다. 하위 활동은 author로 표시하며 같은 실행·비용·Artifact 계약을 따른다 |
| 동적 역량 검색 | 활성 capability catalog와 등록 Embedding 모델; Rerank는 선택적이다 | 최근 요청으로 Skill·MCP 서버/도구를 찾아 명시적 바인딩에 추가한다. 발견은 경고가 아니며, 사용할 수 없거나 잘린 역량은 경고한다 |
| Memory recall | Agent에서 켜고 recall을 제공하는 MCP를 명시적으로 바인딩한다 | 실행 가능한 서버마다 사전 recall을 호출한다. 차단·승인 도구는 자동 호출에서 제외하며 실패·시간 초과는 경고한다. 장기 Memory는 MCP가 소유한다 |
| 자동 모델 라우팅 | 설정 → Models → 사용 설정의 전역 tier·작업 정책·예산과 Agent별 스위치. 결정 모델은 후보 선택에 사용한다 | 첫 응답 전 주 모델을 선택한다. ModelTask는 보조 추론을 수행하며 출력·품질·예산을 검사한다. 기본값 복원은 ModelTask를 제거한다. 선택 근거는 Trace에서 확인한다 |
| Agent 추천 | 관리자 선택 결정 모델, 새 Chat·Workspace의 입력 요청 | 접근 가능한 후보에서 추천한다. 선택은 사용자가 적용하며 마지막 성공한 추천은 입력 중 유지한다. 요청·후보 설명의 인식된 PII 패턴을 가린 뒤 결정 프로바이더에 전달한다 |

모든 Agent 실행은 같은 facade·SDK 루프·run bracket을 사용한다. 진행 중 Agent 실행과 접수된
Audio 작업은 준비·접수 시점의 설정을 유지하고 새 사용자 요청은 현재 저장된 설정을 읽는다.
승인 재개는 저장된 설정·연결·정책을 다시 검사한다.

근거: [Playground](../src/app/agents/[name]/page.tsx),
[실행 facade](../src/application/execution/runAgent.ts), [실행 설계](design/execution.md).

### 내장 도구의 활성 조건

| 도구 | 조건·지원 범위 |
|---|---|
| Skill | 명시적 바인딩 또는 동적 검색으로 제공된 Skill의 본문·참고 파일 읽기 |
| GenerateImage / EditImage | Agent의 이미지 기능과 등록 이미지 모델·프로바이더. 생성·편집 결과를 같은 Agent 실행에서 전달한다 |
| FetchUrl | Agent의 URL 읽기 opt-in. URL guard를 거쳐 웹·PDF·데이터·이미지를 읽는다 |
| SaveFile / File | Artifact 저장소. 텍스트 파일 저장과 지원 문서 읽기·검사·생성·편집. 문서 엔진에 MCP 바인딩은 필요하지 않다 |
| ImportFile / TranscribeAudio / AudioJob | Agent의 Audio 기능과 소유자의 member 이상 문맥. 파일은 비공개 저장소에 보관하고 worker가 작업을 처리한다. 전사는 등록된 전사 채널을 추가로 요구한다 |
| Workspace | Agent의 Workspace 기능, 로그인한 사용자(guest 포함), Sandbox·worker·실행 정책. 개인 월 한도를 적용한다. 개인 토큰·연결된 메신저·Schedule 등록자의 현재 권한과 Agent 정책을 검사해 제공한다 |
| Slack 읽기 | Agent의 Slack 읽기 기능과 활성 봇. History·Thread·User(s)·Channels·Reactions를 봇 권한으로 읽으며 이 도구들은 게시하지 않는다 |
| ModelTask | Agent의 명시적 모델 라우팅 설정. 다른 도구나 두 번째 Agent 루프를 실행하지 않는 보조 모델 호출 |

근거: [도구 이름](../src/domain/llm/toolNames.ts),
[역량 조립](../src/application/execution/agentBindings.ts).

## Chat·Workspace와 결과 파일

| 기능 | 조건·사용 위치 | 확인할 결과 |
|---|---|---|
| Chat | 접근 가능한 Agent를 선택한다. 마지막 선택을 기억하고 첫 메시지로 제목을 만든다 | 개인 목록을 최근 활동순으로 조회하며 일반 Chat·Workspace를 별도로 페이지한다. 입력·첨부 초안은 접수 거절 시 유지한다 |
| Chat 표시·재접속 | Markdown·Reasoning·짝지은 도구 호출/결과·위임 경로·이미지·파일·실행 시간 | 화면 이동은 실행을 중단하지 않는다. Stop은 취소를 요청한다. 재접속은 제한된 실행 로그를 읽고 저장된 답변으로 교체한다 |
| Chat 승인 | Agent가 지정한 승인 도구와 영속 SDK checkpoint | 전체 인자를 보고 승인·거절한다. 불확실하게 중단된 실행은 폐기할 수 있다. 화면 메시지로 모델 Session을 재구축하지 않는다 |
| Workspace 실행 | Chats의 Workspace 선택 또는 Agent 도구. Command는 정확한 script, Codex·Claude·OpenCode는 설정된 native 모델 채널과 자연어 작업 | 같은 Workspace에서 후속 작업·stdout/stderr·Diff·설정한 Test/Lint/Build 결과를 확인한다. Command는 Studio 모델 없이 실행한다 |
| Workspace 영속성 | Docker Sandbox와 별도 worker. 파일·Git·native Session checkpoint, idle suspension·복구 | 작업 취소와 Workspace 종료를 구분한다. 종료 후 보존된 checkpoint로 후속 작업을 시작할 수 있다. 불명확한 외부 작업은 자동 재실행하지 않는다 |
| 저장소 정책 | Agent의 Workspace 도구 탭에서 저장소·owner·전체 접근·신규 자동 등록 모드, 기본 runtime·idle TTL·검사·workflow 설정 | 기존 저장소 접근과 새 저장소 생성을 구분한다. 권한·정책·각 Git 승인을 현재 설정으로 재검사한다 |
| Git·배포 검토 | Commit, commit-and-push, 작업 브랜치 push, Draft PR/PR, 병합, 조건부 main fast-forward, 허용 workflow | 정확한 HEAD·파일 트리·Diff·CI에 동작별 승인·거절을 적용한다. 결과·CI 갱신은 요청한 Chat으로 돌아간다. 실패·결과 불명은 게시 성공이 아니다 |
| Audio 작업 | 원본 가져오기·전사·후처리·전체 처리, 접수 설정 snapshot·큐·중복 방지·완료 단계 재사용 | 단계별 진행량·시도·오류·재시도·취소를 확인한다. 원본·전사 JSON·요약 Markdown·대화록·구조화 결과는 비공개 Artifact다 |
| Audio 외부 전달 | 명시적 Documents/Memory 목적지와 수신 MCP의 ingestion·idempotency 계약 | 접수 ID와 처리 완료를 구분한다. 작업 삭제는 중복 방지를 해제하지만 원본·결과의 보존 기간은 유지한다 |
| Artifact 갤러리 | 개인/Agent 갤러리, 이미지·문서·오디오 필터, 불러온 목록 검색·추가 조회 | 첨부 원본과 생성·수정 결과를 구분하고 크기·시각·Agent·모델·출처를 확인한다. 만료·삭제 파일은 링크 갱신으로 복원하지 않는다 |
| 미리보기·다운로드 | 이미지 확대와 HTML·Markdown·CSV·JSON·SVG·텍스트 preview. Office·PDF는 다운로드한다 | HTML은 격리 iframe에서 바로 실행하며 Stop/Restart·스크립트 오류·차단 안내를 제공한다. 웹 요청 제한은 완전한 오프라인 격리가 아니며 preview 변경은 원본에 저장하지 않는다 |

근거: [Chat 설계](design/chat.md), [Workspace 설계](design/workspaces.md),
[Audio 설계](design/audio-processing-spec.md), [Artifact 권한](../src/application/artifact/artifactUseCases.ts).

### 문서 지원 범위

| 형식 | 읽기·검사 | 생성 | 원본을 보존하는 편집 |
|---|---|---|---|
| UTF-8 텍스트·Markdown·CSV·JSON·XML·YAML·HTML·SVG | 추출문·본문 | SaveFile: TXT·Markdown·CSV·JSON·HTML·SVG | 한 번만 나타나는 문자열 교체; JSON은 수정 후 문법 검사 |
| DOCX | 텍스트·문서 구조·대상 | 지원 | 지정 텍스트 교체 |
| PPTX | 텍스트·슬라이드 대상 | 지원 | 지정 텍스트 교체 |
| HWPX | 텍스트·대상 | 지원 | 지정 텍스트 교체 |
| XLSX | 시트·셀·값·수식·선택적 숨김 시트 | 지원 | 셀 값·수식 변경 |
| PDF | 읽기: 텍스트 레이어 | 지원 | 미지원 |
| HWP 5.x·ODT/ODS/ODP·RTF | 읽기: 텍스트 추출 | 미지원 | 미지원 |

첨부 문서의 텍스트 추출은 저장소 없이도 동작한다. 원본 파일 ID로 다시 읽거나 편집하려면
원본이 저장되어야 하며 편집은 별도 수정본을 만든다. 생성 시 문서 스타일·지원 이미지·시트·수식을
지정할 수 있다. 수식 계산·OCR·암호화 파일·서명 문서/매크로 workbook 편집은
지원하지 않는다. DOCX·PPTX·HWPX 텍스트 교체는 문단·줄바꿈을 추가하지 않는다.
결과의 내용·배치는 다운로드 후 검토한다.

근거: [문서 처리 계약](../src/domain/document/processor.ts), [문서 설계](design/documents.md).

## Models·레지스트리·연동

| 기능 | 조건·사용 위치 | 확인할 결과 |
|---|---|---|
| Models | guest를 포함한 로그인 사용자가 관리자가 등록한 Text·Image·Embedding·Rerank·Transcription·Decision 모델을 조회한다 | provider·ID·capability·문맥·유형별 가격을 검색·필터·정렬하고 개인 즐겨찾기를 선택기에 반영한다 |
| 모델 관리 | Settings → Models에서 provider 이름·종류·주소·키와 모델을 등록한다. Self-hosted는 같은 흐름이며 직접 등록도 지원한다 | 전체 provider 목록 조회와 등록을 구분한다. 등록 모델 수정·삭제·제공 상태를 검사하며 listing 성공은 추론 성공을 보장하지 않는다 |
| 모델 사용 설정 | 기본·결정·Workspace·Embedding·Rerank 모델, 검색 점수, 전역 라우팅과 가격 미지정 정책 | 선택된 모델만 실행한다. 공개 catalog·가격은 오프라인 snapshot과 선택적 갱신을 사용하며 자동 등록하지 않는다. Embedding 변경은 확인 후 재색인한다 |
| Skills | 관리자 수동 생성·본문 편집·삭제, Plugin 출처와 참고 파일 조회 | 이름·설명이 검색과 모델 선택을 안내하며 본문은 로드 후 전달한다. Plugin 소유 본문·참고 파일은 원본에서 수정한다 |
| Plugins | 관리자 GitHub 동기화 또는 .tar/.tar.gz/.tgz 업로드, 변경·skipped·실패·출처 인수·고아 항목 보고 | 헤더 credential은 가져오지 않는다. 고아 항목·Plugin은 바인딩 영향과 현재 원본을 확인해 명시적으로 삭제한다. archive hold 중 자동 GitHub 동기화는 진행하지 않는다 |
| 원격 MCP | 관리자 등록·검사·편집과 Agent 바인딩·도구 선택·헤더 override | 도구 이름·설명·Schema를 발견한다. private DNS는 배포 allowlist와 실제 도달성이 필요하다. URL이 이동하면 저장한 credential을 새 대상으로 보내지 않는다 |
| MCP OAuth | 관리자 metadata 발견·authorization server 선택·공유 client 설정, Agent 소유자 연결·재인증·해제 | 연결은 Agent 설정 Save와 별도로 저장된다. token 갱신과 재인증 상태를 확인한다. discovery 성공만으로 자원 접근을 증명하지 않는다 |
| Managed MCP | 선택적 Docker provisioner, 이미지·내부 포트·환경·argv·endpoint 설정 | 컨테이너 상태·접속·재시작·삭제를 확인한다. loopback에 게시하고 PORT를 전달한다. private registry 인증은 호스트가 준비한다. Kubernetes 관리형 adapter는 미구현이다 |
| 개인 API·Webhook 토큰 | 현재 Agent 접근과 토큰 사용 tier가 있는 사용자가 본인 토큰을 발급·조회·폐기한다 | 사용자 ID와 Agent·purpose에 묶인다. 호출마다 현재 권한을 확인하고 개인 비용·동시성에 합산한다. API와 Webhook 토큰은 서로 대신 사용할 수 없다 |
| 실행 API | predict 완료형/raw stream, agent raw stream, OpenAI chat/completions. 메시지·인라인 이미지, 지원 경로의 문서 입력 | 응답·이미지·파일·사용량·경고·종료 이유를 확인한다. 호출자가 이력을 공급하며 X-Conversation-Id는 MCP 식별만 유지한다 |
| Slack | dedicated bot manifest·token·signature·활성화와 실제 event URL. DM·mention·참여 thread·키워드, help/mute, 제안 프롬프트 | 입력·도구·답변·이미지·파일을 플랫폼에 전달한다. 읽기 capability와 게시 목적지는 별도다. private Agent 접근을 검사한다 |
| Telegram | token·secret webhook, 활성화 시 자동 등록·해제와 재등록 | 식별된 발신자의 개인 Chat·그룹 mention/봇 답장에 응답하며 /start·/help, 분할 답변·forum topic·관찰한 목적지를 지원한다. 음성 메시지 자동 전사는 제공하지 않는다 |
| Teams | Azure Bot/Teams 채널, App ID·secret·선택 tenant와 messaging URL | token·serviceUrl을 검증하고 식별된 발신자의 개인 Chat·그룹/채널 mention에 답한다. typing·편집·분할·이미지·문서·알림 목적지를 지원한다 |
| Webhook | Agent별 주소·secret/서명·활성화·겹침 정책·중복 방지 | JSON 입력을 접수 후 배경 실행한다. 202의 accepted·skipped 사유·ping을 구분하고 이력에서 결과를 확인한다 |
| GitHub PR 리뷰 | 관리자가 Webhook에 허용 저장소·리뷰 모드를 설정한다 | 서명된 지원 PR 이벤트의 diff를 제한된 Agent로 검토하고 검증한 PR/HEAD에 댓글을 남긴다. 미선택 이벤트는 ignored이며 일반 secret 인증은 거부한다 |
| Schedules | 다섯 필드 cron·IANA 시간대·메시지·활성화·겹침 정책, 외부 ticker | 현재 설정 실행·중복 tick·제한된 놓친 발생분·유실 상태 복구를 처리한다. owner 문맥과 Slack/Telegram/Teams 전달은 명시적으로 설정하며 실행 성공과 전달 성공을 구분한다 |

근거: [모델 등록](../src/application/llm/modelRegistry.ts), [Plugin 동기화](../src/application/plugin/syncPlugins.ts),
[MCP 설계](design/mcp.md), [메시징 설계](design/messaging.md), [Trigger 설계](design/triggers.md),
[API Reference](../src/app/agents/[name]/api-reference/endpoints.ts).

## 비용·진단·운영

| 기능 | 조건·사용 위치 | 확인할 결과 |
|---|---|---|
| Usage | Overview는 Agent·모델·provider·부서, Agent Usage는 모델·provider, Profile은 Agent·모델·provider별 집계 | UTC 기간·일별 비용·호출·캐시 비율을 확인한다. 호출자 상세는 소유자·관리자 전용이며 가격 추정 0은 실제 무료의 증거가 아니다 |
| 비용·등급 한도 | Agent의 일·월 alert/block, 알림 목적지와 사용자 tier의 월 비용·동시성·생성·토큰 정책 | 기록된 사용량으로 새 실행을 제어한다. 기준값은 선불 잔액이 아니며 알림 실패와 차단은 별개다 |
| Traces | Agent 소유자·관리자. 실행·준비·모델·도구·위임·Guardrail·라우팅 span과 대화 식별 | 완료·실패·취소·승인 대기·턴/출력 제한, 시간·입출력·캐시·Reasoning·오류·손실·span 생략을 확인한다. 봇 전달 성공은 별도로 확인한다 |
| Audit | 관리자 전용 기간 조회. secret 조회·회전·폐기, 설정·모델·레지스트리·tier·관리자 작업 기록 | 행위자·대상·상세·UTC 날짜 페이지를 조회한다. 실행 진단은 Trace를 사용한다 |
| Settings | Service: branding·주소·Artifact 전달·동시성·Slack 표시, Access: admin/domain, Plugins: repo/branch/token, Models: 연결·등록·사용 | 변경한 탭 필드만 저장하고 override/env/default/unset 출처를 표시한다. 일반 override reset과 배포 전용 설정을 구분한다 |
| 운영 기반 | 부팅 설정 검사·DB schema, 암호화·mask·SSRF guard·실행 상한, health/ready·Prometheus·선택 OTLP·draining | 실제 Agent 실행과 파일 재열기로 경로를 검증한다. 일정·Plugin sync·catalog reindex는 각각 외부 호출이 필요하다. Audio·Workspace는 별도 worker다 |
| 보존·복구 | authenticated schedule tick의 DB sweep, 일반 object lifecycle, private Audio expiry와 Sandbox cleanup | DB 기록·객체·Session·worker 상태의 수명을 구분하고 복구를 별도 환경에서 검증한다 |

근거: [비용·기록 설계](design/observability.md), [감사 행위](../src/domain/audit/types.ts),
[Settings 계약](CONFIGURATION.md#설정-화면), [운영 계약](OPERATIONS.md).

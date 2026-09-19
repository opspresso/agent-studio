# 기능 현황과 개편 결정

현재 구현을 개편 여부를 결정할 수 있는 기능 단위로 정리한다. 화면뿐 아니라 API·도메인
타입·실행 경로·worker를 대조한 목록이다. 아래의 구현 여부는 코드 기준이며, 선택 기능이
현재 운영 환경에서도 활성화돼 있다는 뜻은 아니다.

이 문서는 기능 범위와 개편 결정을 소유한다. 확정된 목표와 현재 구현은 구분하며,
아래 번호가 붙은 기능 목록은 아직 제거되지 않은 기능까지 포함한 코드 현황이다. 개념과 연결 관계는
[시스템 개요](AGENT_STUDIO.md), HTTP 계약은 [API](API.md), 활성 조건과 제한값은
[CONFIGURATION](CONFIGURATION.md), 실행 원리는 [설계 문서](ARCHITECTURE.md#서브시스템)를 따른다.
마지막의 정리 후보는 사용 여부와 제거 범위를 확인할 대상이다.
확정된 미완료 작업만 [MILESTONES](MILESTONES.md)에서 관리한다.

## 개편 목적

복잡한 구조를 단순화·명확화하고, 사용하지 않는 기능을 과감히 제거해 주요 기능에 집중한다.
기능 확장이나 범용 플랫폼 구축이 아니라, 사용자가 이해해야 할 개념과 개발·운영해야 할 경로를
줄이는 것이 목표다.

- 핵심은 Agent의 현재 설정, 요청에 맞는 모델 선택·도구 실행, API·Chat·A2A 기본 지원이다.
- 사용하지 않는 기능은 개선하거나 이름만 바꿔 남기지 않고 제거한다. 구현돼 있다는 사실이나
  나중에 쓸 가능성만으로 유지하지 않는다.
- 사용 여부를 모르는 기능은 유지·확장을 전제하지 않고 실사용 필요부터 확인한다.
  미사용으로 확인되면 화면뿐 아니라 전용 API·실행 분기·설정·의존성·worker까지 함께 정리한다.
- Slack·Telegram·Teams·Cron·Webhook은 필요한 연동을 분리하는 어댑터다. 모든 부가 기능을
  어댑터로 옮겨 보존하는 수단이나 새로운 Plugin 플랫폼으로 만들지 않는다.
- 같은 책임의 중복은 합치고, 서로 다른 책임은 명확히 나눈다. 파일·계층·인터페이스 수를
  늘리는 것 자체를 모듈화의 성과로 보지 않는다.
- 남기는 핵심 실행에 필요한 권한·비용·승인·기록 보호는 유지한다. 이 보호를 이유로 관련
  부가 기능 전체를 보존하지는 않는다. 기능 제거와 기존 데이터 삭제는 별도로 판단한다.

완료 여부는 핵심 사용 시나리오의 정상 동작과 불필요한 메뉴·설정·분기·운영 의존성의 실제 감소로
확인한다. 이 문서의 현재 기능 목록은 유지 약속이나 추가 개발 목록이 아니라 정리 대상의 기준선이다.

## 확정된 개편 방향

다음은 구현할 목표이며, 현재 코드에 반영된 상태가 아니다.

| 영역 | 결정 | 목표 |
|---|---|---|
| 프로젝트 유형 | Agent만 유지 | 독립적인 `llm`·`image` 프로젝트 유형과 유형 선택·분기를 제거한다 |
| 버전 관리 | 제거 | 버전 생성·목록·편집·선택·발행을 없애고 Agent의 현재 설정을 직접 관리·실행한다 |
| 모델 호출 | 요청 기반 역할 선택 | 사용자 요청에 따라 `light / mid / heavy / reasoning / image` 중 적합한 역할을 선택하고 해당 모델을 호출한다 |
| 기본 실행 경로 | API·Chat·A2A 유지 | 하나의 Agent를 세 기본 경로에서 실행하며 별도 채널 어댑터 설치를 요구하지 않는다 |
| AG-UI | 제거 | 사용하지 않는 AG-UI endpoint·프로토콜 변환·전용 예제와 노출을 제거한다 |
| 추가 실행 연동 | 확장 가능한 어댑터로 분리 | Slack·Telegram·Teams·Cron·Webhook을 선택적 어댑터로 제공하고 이후 다른 어댑터를 추가할 수 있게 한다 |

모델 호출의 목표 흐름은 `사용자 요청 → 모델 역할 선택 → 해당 역할에 연결된 실제 모델 호출`이다.
역할은 특정 provider나 모델 ID와 구분한다. `image`는 독립 프로젝트 유형이 아니라 Agent가
이미지 요청을 처리할 때 사용하는 모델 역할이다. 이미지 생성·편집 기능 자체를 삭제하는 결정은 아니다.

버전에 연결된 프롬프트·역량 설정은 Agent의 현재 설정으로 옮긴다. 유지하기로 한 실행 경로의
버전/발행본 참조도 함께 정리하며, 제거할 부가 기능을 새 구조로 이식하지 않는다.
버전 기반 Compare도 제거하고 이번 개편에서 별도 모델 비교·평가 기능으로 대체하지 않는다.

구현 전에 정할 세부사항:

- 요청을 분류하고 역할을 선택하는 방식·기준.
- 역할별 실제 모델을 설정하는 위치와 범위: 설치 전역 또는 Agent별.
- 선택한 역할의 모델이 없거나 호출에 실패했을 때의 처리·fallback 정책.
- 기존 프로젝트·버전·진행 중 실행·기록의 전환 및 보존 방식. 기능 제거를 저장 데이터 일괄 삭제 권한으로 해석하지 않는다.

프로젝트·모델 개편의 완료 조건은
[agent-only-request-routing](MILESTONES.md#agent-only-request-routing)에서 관리한다.

### 기본 지원과 어댑터 경계

Agent가 실행의 중심이다. API·Chat·A2A는 기본 지원하며, 그 밖의 실행 채널·자동화 진입점은
어댑터를 통해 연결한다. 기본 지원은 인증·접근 제어 없이 공개하거나 자동 활성화한다는 뜻이 아니다.

| 구분 | 대상 | 책임 |
|---|---|---|
| Agent 실행 코어 | 공통 실행 유스케이스 | 요청 기반 모델 선택·도구 실행과 권한·비용·사용량·Trace·Artifact 정책을 일관되게 적용한다 |
| 기본 진입점 | API·Chat·A2A | 각 프로토콜과 대화 계약에 맞게 같은 Agent 실행 유스케이스를 호출한다 |
| 메시징 어댑터 | Slack·Telegram·Teams | 채널 인증·이벤트 해석·호출자와 대화 식별·첨부 변환·응답 전달을 담당한다 |
| 자동화 어댑터 | Cron·Webhook | 예약 또는 외부 이벤트를 검증·해석하고 중복·겹침 실행을 제어해 Agent 실행을 요청한다 |
| 추가 어댑터 | 이후 추가할 실행 연동 | 공통 계약을 구현하고 등록·조립해 연결한다 |

- 어댑터는 Agent 실행 루프와 공통 권한·비용 정책을 복제하지 않는다. 신원을 전달하더라도
  실행 코어의 접근·지출 검사를 우회하지 않는다.
- Agent 실행 코어는 특정 채널의 SDK·설정·이벤트 형식에 의존하지 않는다. 입력·출력과 실행
  상태의 경계를 명시하고, 어댑터마다 지원 가능한 스트리밍·첨부·대화·취소·승인 범위를 구분한다.
- 새 어댑터 추가는 구현·설정·등록·조립과 해당 검증으로 한정한다. Agent 실행 코어에 채널별
  분기나 전용 필드를 계속 추가하는 구조로 만들지 않는다.
- 어댑터가 없거나 설정되지 않아도 기본 경로의 부팅·실행은 가능해야 한다. Cron 분리로 만료
  데이터 정리 같은 공통 운영 기능이 선택적 예약 어댑터에 종속되지 않도록 한다.
- 예약 결과·비용 알림의 전달도 공통 출력 계약을 통해 어댑터에 위임한다. Agent 설정에
  Slack·Telegram·Teams 전용 목적지 구조를 계속 확장하지 않는다.

어댑터 전환은 다섯 연동 기능을 삭제하는 결정이 아니다. AG-UI만 제거하며, 나머지는 같은
Agent를 호출하는 선택적 연결 방식으로 바꾼다. Cron은 현재 Schedules 기능의 개편 대상이다.
이 실행 어댑터를 기존 Skills·MCP 배포용 Plugins와 같은 개념으로 취급하지 않는다.

어댑터의 등록·활성화 단위, 설정·시크릿 관리 위치, 배포·패키징 방식과 구체적인 인터페이스는
구현 전에 정한다. 런타임 동적 설치나 별도 Plugin 마켓을 제공하기로 확정한 것은 아니다.
완료 조건은 [agent-entry-adapters](MILESTONES.md#agent-entry-adapters)에서 관리한다.

## 변경 판단과 권고

판단 기준은 [개편 목적](#개편-목적)에 기여하는가다. 기능 추가를 먼저 제안하지 않는다.
확정된 방향은 구현 대상으로 삼고, 나머지는 실사용 필요를 확인해 유지·통합·제거를 결정한다.

### 하는 것이 좋은 변경

| 대상 | 변경 방향 | 단순화 결과·조건 |
|---|---|---|
| 유형·버전 제거 | Agent 하나의 현재 설정으로 관리·실행하고 유형 선택·버전·발행·버전 비교를 제거한다 | 사용자 개념과 실행 분기를 줄인다. 이미지 역할과 실행 일관성 보호는 유지한다 |
| 미사용 기능 제거 | AG-UI와 추가로 미사용이 확인된 기능을 전용 코드·설정·의존성까지 제거한다 | 숨김이나 비활성화만으로 남기지 않아 유지·검증·운영 범위를 실제로 줄인다 |
| 어댑터 분리 | 다섯 연동은 필요한 입출력·인증만 공통 Agent 실행에 연결한다 | 채널별 Agent 복제나 코어 분기 없이 연동을 추가·제거한다 |
| 요청 기반 모델 선택 | 사용자가 매번 실제 모델을 고르는 대신 요청에 맞는 역할을 선택한다 | 다섯 역할을 새 프로젝트 유형처럼 만들지 않는다. 선택 결과와 비용은 확인할 수 있게 한다 |
| 명칭·설정 통합 | 남기는 기능의 중복 개념·설정 위치를 줄이고 책임을 명확히 한다 | 설정을 여러 화면에 복제하거나 기존 화면을 새로운 관리 화면으로 일대일 대체하지 않는다 |
| 부가 기능 범위 축소 | Workspace·Audio·문서 처리 등은 실사용 부분만 남기고 미사용 부분을 제거한다 | 전체 기능을 보존한 채 UI만 개선하는 작업을 먼저 하지 않는다. 구체적인 제거 범위는 아래 표에서 확인한다 |

모델 역할은 단일한 성능 순서가 아니다. `light / mid / heavy`는 처리 수준을 나누는 역할이고,
`reasoning / image`는 요청에 필요한 기능과 관련된 역할이다. 다섯 역할은 유지하되 선택 우선순위와
겹치는 요청의 처리 기준을 정해야 한다. 역할별로 반드시 서로 다른 모델을 배정할 필요는 없다.
대표 요청 묶음으로 선택 결과·답변 품질·비용·지연을 비교해 검증하며, 이를 위해 별도 평가 플랫폼을
먼저 만드는 것은 이번 개편의 전제가 아니다.

### 하지 말아야 할 변경

| 피할 변경 | 이유 |
|---|---|
| 미사용 기능을 숨기거나 adapter·feature flag 뒤로 옮겨 모두 보존 | 사용자가 보는 복잡성만 숨기고 코드·설정·의존성은 그대로 남는다 |
| 버전 관리 제거 뒤 이름만 다른 발행·리비전 관리 제품을 재구축 | 제거한 사용자 개념과 절차를 다시 만드는 셈이다. 내부 실행 일관성 검사만 남긴다 |
| 어댑터를 위해 범용 Plugin 플랫폼·동적 코드 로딩·모든 채널을 위한 거대 인터페이스 도입 | 다섯 실제 연동을 분리하려다 더 큰 구조를 만든다. 필요한 공통 계약과 선택 기능만 둔다 |
| 요청 라우팅을 복잡한 다단계 Agent·무제한 모델 승급·재시도로 구현 | 단순 요청까지 비용·지연·실패 경로가 늘어난다. 명시된 역할 선택과 제한된 실패 처리에 집중한다 |
| 기능 감소 대신 Knowledge Base·평가 플랫폼·실시간 음성·웹 IDE·새 관리 화면 추가 | 핵심 구조를 정리하기 전에 제품 범위와 유지 비용을 확대한다 |
| 단순화를 이유로 서로 다른 데이터·권한을 무조건 합치거나 핵심 보호를 제거 | 승인·비용·개인정보·중복 실행 문제가 생긴다. 필요한 책임은 분리하고 미사용 제품 기능만 제거한다 |
| 제거할 부가 기능까지 새 Agent 구조에 이식한 뒤 삭제 | 버릴 코드의 전환 작업을 먼저 하게 된다. 유지 범위를 정한 뒤 그 범위만 이식한다 |
| 기능 삭제와 함께 승인 없이 저장 데이터·기록을 일괄 삭제 | 데이터 전환·보존은 별도 결정이며, 기능 제거가 파괴적 데이터 작업의 허가는 아니다 |

구현 근거: 현재 [승인 재개](../src/application/runtime/session.ts)는 설정 fingerprint와 저장 revision을
검사한다. [모델 정책](../src/application/run/modelPolicy.ts)은 미등록 모델의 비용 누락을 제어하고,
[예약 스캔](../src/app/api/triggers/scan/route.ts)은 만료 데이터 정리도 실행한다. 문서의 제거 결정만으로
이 보호·운영 책임까지 없애서는 안 된다.

## 명칭과 기능 경계

| 현재 명칭 | 실제 역할 |
|---|---|
| Projects | 프롬프트·Agent·이미지 프로젝트를 관리하는 로컬 실행 단위 |
| Agents | 다른 시스템의 원격 Agent를 등록하는 레지스트리 |
| Tools | MCP 서버 등록·연결·운영 기능 |
| Plugins | Skills와 MCP 서버를 가져오는 동기화 묶음 |

`light / mid / heavy` 역할별 모델 배정은 현재 없다. 기본 모델·fallback 모델·이미지 도구
모델이 있고, Reasoning은 모델의 capability와 실행 설정이다.

## 1. Projects — 내부 Agent·프롬프트·이미지 프로젝트

### 기본 관리

- 프로젝트 목록과 검색: 이름·표시 이름·설명.
- 유형 필터: `llm`, `agent`, `image`.
- 고유 이름, 표시 이름, 설명, 소유자, 부서 코드.
- 프로젝트 생성.
- 표시 이름·설명·부서 코드 수정.
- 프로젝트 복제.
- 프로젝트 삭제.
- 발행 버전 및 공개 범위 표시.
- 조직 공개 / 비공개 설정.
- 비공개 프로젝트의 사용자 이메일 초대.

현재 공개는 로그인한 조직 사용자에게 공개한다는 의미다. 초대 사용자는 조회·실행·복제가
가능하지만 편집자는 소유자·관리자다.

### 프로젝트 유형

개편 시 `agent`만 유지하고 나머지 유형은 제거한다. 현재 구현은 다음과 같다.

- `llm`: 프롬프트·템플릿 기반 단발 모델 실행.
- `agent`: 모델과 도구를 반복 호출하는 Agent 실행.
- `image`: 이미지 생성·편집.

### 버전 관리

이 절의 버전 관리·발행 기능은 제거 대상이다. 현재 구현은 다음과 같다.

- 버전 목록·모델·생성 시각·발행 상태 조회.
- 현재 설정을 복사해 새 버전 생성.
- 버전 설정 수정.
- 실행할 버전 선택.
- 발행 버전 지정·변경.
- 버전 삭제.
- 저장하지 않은 변경 표시.
- 권한 없는 사용자의 읽기 전용 조회.

발행 버전도 수정할 수 있다. 발행은 불변 릴리스 생성이 아니라 `publishedVersion` 포인터
변경이다. 현재 발행본 삭제는 제한되며, 별도 발행 취소 기능은 없다.

### 모델과 프롬프트

개편 시 버전별 고정 모델 중심의 실행을 [요청 기반 모델 역할 선택](#확정된-개편-방향)으로
바꾼다. 프롬프트·역량은 Agent의 현재 설정으로 관리하며, 아래는 현재 설정 항목이다.

- 기본 모델 선택.
- 모델 검색·즐겨찾기 그룹·capability 확인.
- Fallback 모델 선택.
- 시스템 프롬프트.
- 사용자 프롬프트 템플릿.
- `{{변수}}` 치환.
- Temperature.
- 최대 출력 토큰.
- Presence penalty.
- Reasoning effort: 기본값 / low / medium / high.
- Reasoning 표시·기록 여부.
- Structured output 활성화.
- JSON Schema 입력·구문 검사.
- 요청자 정보 전달 여부: 이름, 표면이 제공하는 시간대·아바타. 이메일은 모델용 요청자 정보에서 제외.
- PII filtering: 이메일·전화번호·한국 주민등록번호·카드번호 치환.

사용자 프롬프트 템플릿은 `llm/image`에서 사용한다. Agent는 대화 메시지를 직접 사용한다.
Fallback은 첫 출력 전 429·5xx 오류에서 한 번 전환하는 기능이며 난이도별 모델 라우팅이 아니다.
이미지 프로젝트에는 fallback 모델이 없고 PII filtering도 이미지 프롬프트에는 적용하지 않는다.

### Agent 역량과 실행 정책

- 복수 Skills 연결.
- 복수 MCP 서버 연결.
- 서버별 사용할 도구 선택.
- 버전별 MCP 헤더 추가·교체·제거.
- MCP 결과의 원본 파일 매핑 설정.
- 프로젝트별 MCP OAuth 연결·재인증·해제.
- 로컬 프로젝트를 하위 Agent로 연결.
- 외부 Agent 연결.
- Handoff.
- Agent-as-Tool 위임.
- 이미지 프로젝트 위임.
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
- Skill·MCP 서버·MCP 도구·외부 Agent의 의미 기반 검색.
- Embedding 검색과 선택적 Rerank.
- 명시적으로 연결한 역량에 검색 결과 추가.
- 검색된 역량·준비 경고 표시.

장기 Memory는 외부 MCP 기반이다. Chat 이력과 별개이며, Studio 내부의 독립 Memory 관리
화면은 없다. 로컬 Project는 자동 capability 검색 대상이 아니라 명시적 하위 Agent 연결 대상이다.

### 내장 도구

- `Skill`: 지침·참고 파일 읽기.
- `GenerateImage`, `EditImage`: 이미지 생성·편집.
- `FetchUrl`: URL 내용 읽기.
- `SaveFile`: 텍스트 계열 파일 생성.
- `File`: 문서 읽기·검사·생성·편집.
- `Workspace`: Sandbox 작업·코딩·Git 검토 요청.
- `ImportFile`, `TranscribeAudio`, `AudioJob`: 파일 가져오기·전사·오디오 작업.
- Slack 읽기 도구: `SlackHistory`, `SlackThread`, `SlackUser`, `SlackUsers`, `SlackChannels`, `SlackReactions`.

도구마다 버전 설정·저장소·연동·호출자 권한 등의 활성 조건이 있다.

구현 근거: [Project·Version 정의](../src/domain/project/types.ts),
[Version 편집기](../src/app/projects/[name]/_components/VersionEditor.tsx),
[내장 도구 목록](../src/domain/llm/toolNames.ts).

## 2. Playground·Compare

### Playground

- 저장된 버전 선택.
- 설정 편집과 실행 결과를 함께 표시.
- 저장 전 초안의 Prompt preview: 조립된 시스템·사용자 메시지, 템플릿 변수 입력,
  실제 도구 JSON Schema, 발견한 역량, Memory·바인딩·PII 관련 경고, 결과 복사.
- 저장된 버전 테스트 실행.
- 텍스트 메시지·템플릿 변수 입력.
- 이미지·문서 첨부.
- 이미지 생성·원본 이미지 편집.
- 이미지 크기·품질 선택.
- 답변 스트리밍.
- Reasoning·도구 호출·하위 Agent 진행 표시.
- 생성 이미지·파일 표시.
- 비용·오류·경고·종료 상태 표시.

Prompt preview는 모델 답변을 생성하지 않지만 검색·MCP 조회·Memory recall은 실제 수행할 수
있다. 실제 Run은 저장된 버전을 실행한다.

### Compare

- 같은 프로젝트의 버전 두 개 선택.
- 동일 입력으로 나란히 실행.
- 답변·Reasoning·이미지·생성 파일 비교.
- 비용·실행 시간 비교.
- 오류·경고 확인.

현재는 수동 비교다. 평가 데이터셋·자동 채점·A/B 트래픽 배분은 없다.
버전 기반 Compare는 [버전 관리 제거의 영향 범위](#확정된-개편-방향)에 포함된다.

구현 근거: [Prompt preview](../src/app/projects/[name]/_components/PromptPreview.tsx),
[실행 패널](../src/app/projects/[name]/_components/RunPanel.tsx),
[Compare](../src/app/projects/[name]/compare/page.tsx).

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

Chat은 소유자 개인 대화다. 공유 프로젝트를 사용하더라도 대화가 공유되지는 않는다.
별도 모델·버전 선택, 메시지 수정, 답변 재생성, 대화 공유·내보내기·전문 검색 UI는 없다.
연결 종료 뒤 실행 유지가 서버 프로세스 급사 후 자동 복구까지 뜻하지는 않는다.

구현 근거: [새 대화](../src/app/chats/_components/NewChatPanel.tsx),
[대화 소유권·조회](../src/application/chat/getChat.ts), [Chat 설계](design/chat.md).

## 4. Models

### 목록·탐색

- 모델 ID·표시 이름·제작사·provider.
- 모델 유형: Text, Image, Embedding, Rerank, Transcription.
- Tools·Structured output·Vision·Reasoning capability.
- Context window.
- 입력·출력·캐시 등 유형별 가격.
- 할인율·다른 provider 공급 경로.
- 공급 채널 사용 가능 상태.
- 이름·ID·제작사·provider 검색.
- Provider·유형·capability 필터.
- 이름·provider·가격 정렬.
- 필터·정렬 상태 기억.
- 개인 즐겨찾기.

### 관리자 관리

- 모델 선택 목록에서 숨김·해제.
- 전체 숨김 해제.
- Text·Image·Rerank 연결 테스트.
- 테스트 성공 여부·지연시간·오류 표시.
- 카탈로그 즉시 새로고침.
- 부팅·주기적 카탈로그 갱신.
- 오프라인 스냅샷 사용.
- JSON 카탈로그 업로드·설치·제거.
- 설치자·설치 시각·모델 수·스킵 항목 확인.

### Self-hosted

- 서버가 제공하는 모델 발견.
- 모델 선언 추가·편집·제거.
- 표시 이름·유형·문맥 크기·출력 토큰·capability 설정.
- 선언과 실제 serving 상태 불일치 표시.

모델 다운로드·서빙 프로세스 실행·파인튜닝 기능은 아니다.

### 특수 목적 모델 설정

- Capability 검색용 Embedding 모델.
- Embedding 변경 시 확인 후 재색인.
- Rerank 모델·최소 점수.
- Codex·Claude·OpenCode별 Workspace 모델.
- Workspace 모델 선택 해제로 해당 runtime 비활성화.

모델 숨김은 기존 버전의 실행 금지와 다르다. 관리자 모델 테스트도 프로젝트의 일반 실행·Usage
기록과 분리돼 있다. Embedding·Transcription의 독립 Test 버튼은 없다.

구현 근거: [Models 화면](../src/app/models/page.tsx),
[모델 연결 테스트](../src/application/llm/testModel.ts),
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
- 해당 항목을 사용하는 프로젝트·버전 표시.
- 사라진 Plugin·Skill·MCP의 명시적 선택 삭제.
- 최근 동기화 보고서 보관.
- 외부 ticker 기반 자동 동기화.
- 동기화 후 capability 재색인.

현재는 동기화 중심이다. Plugin 직접 작성·편집, 스토어 검색·개별 설치, Plugin별 활성 스위치가
있는 구조는 아니다. 동기화가 자동으로 항목을 삭제하지도 않는다. 저장소의 header credential은
가져오지 않는다.

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

Plugin 소유 Skill은 원본 동기화로 관리한다. 수동 첨부 업로드·편집 UI는 없으며, Skill 자체를
프로그램처럼 실행하는 기능도 아니다.

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

현재 화면은 MCP 도구 발견까지 지원한다. 임의 도구의 인자 입력 폼을 만들어 직접 실행하는
범용 Tool Tester는 없다.

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

## 8. Agents — 외부 Agent

- 외부 Agent 목록·검색.
- 이름·설명.
- 프로토콜 선택: OpenAI-compatible / A2A.
- 실행 endpoint 또는 Agent Card URL.
- HTTP 헤더·자격 증명.
- 등록·편집·삭제.
- 테스트 메시지 전송.
- 응답·오류 확인.
- 프로젝트 하위 Agent로 연결.
- 자동 capability 검색 대상으로 사용.
- 발행된 로컬 프로젝트의 A2A 목록 조회.
- Agent Card URL 복사·JSON 조회.

이 메뉴에는 자체 모델·시스템 프롬프트·Skills·비용한도 설정이 없다.

구현 근거: [외부 Agent 목록](../src/app/agents/page.tsx),
[외부 Agent 상세](../src/app/agents/[name]/page.tsx), [A2A 설계](design/agents-a2a.md).

## 9. Integrations·API Reference

개편 시 API·A2A는 기본 지원으로 유지하고, Slack·Telegram·Teams는 선택적 어댑터로 분리한다.
AG-UI는 제거 대상이다. 아래는 아직 변경되지 않은 현재 구현 목록이며,
[기본 지원과 어댑터 경계](#기본-지원과-어댑터-경계)가 목표 구조다.

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
- 이미지 생성·편집 API.
- 템플릿 변수·메시지·이미지·문서 입력.
- 모델·사용량·비용·경고·종료 이유·출력 파일 반환.
- 선택적 대화 ID 전달.
- Endpoint·인증·요청/응답·오류 문서.
- curl·Python·Node.js·AG-UI 예제.
- 예제 복사.

API Reference는 발행본 예제를 보여주지만, 버전별 REST endpoint에서는 지정한 미발행 버전도
실행할 수 있다.

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

Azure Bot·Teams App 자체를 자동 생성하는 기능은 아니다.

### A2A

- Agent Card 조회·복사.
- 공유 키·이름 있는 Client Key 인증.
- 메시지 전송·스트리밍.
- Task 조회·목록·취소·재구독.
- 상태·문맥·시각 필터와 페이지 조회.
- Task 결과 저장.
- 텍스트·inline image 입력.
- 텍스트·이미지·파일 출력.
- 발행 프로젝트 노출.

Push notification과 Chat 같은 영속 모델 이력이 자동 제공되는 것은 아니다.

### AG-UI

이 절의 기능은 사용하지 않으며 제거 대상으로 확정했다. 아래는 제거 전 코드 현황이다.

- 외부 UI에서 발행 프로젝트 실행.
- 실행·텍스트·Reasoning·도구·하위 Agent 이벤트.
- 이미지·파일·사용량·경고 이벤트.
- Thread·Run ID.
- 텍스트·이미지·문서 입력.
- 클라이언트 context·state 전달.
- Frontend tool 호출과 후속 요청으로 결과 전달.

State 변경 이벤트·프로토콜 resume·영속 승인 UI는 현재 없다.

구현 근거: [연동 화면](../src/app/projects/[name]/integrations/page.tsx),
[API Reference](../src/app/projects/[name]/api-reference/endpoints.ts),
[메시징 설계](design/messaging.md), [A2A](design/agents-a2a.md), [AG-UI](design/agui.md).

## 10. Webhook·Schedules

개편 시 Webhook과 Cron(Schedules)을 선택적 어댑터로 분리한다. 예약·이벤트 자동화 기능은
유지하되 Agent 실행 코어와 분리하며, 다른 어댑터도 같은 계약으로 추가할 수 있어야 한다.

### Webhook

- 프로젝트별 Webhook 설정.
- 호출 주소 복사.
- 활성화.
- Secret 생성·확인·회전.
- 메시지 / 템플릿 변수 payload 모드.
- 겹침 실행 허용 여부.
- Secret header·GitHub 서명 검증.
- 중복 요청 억제.
- 접수 후 백그라운드 실행.
- 발행 버전 실행.
- 최근 실행 상태·결과·오류·경고.
- 생성 Artifact 보관.
- API에서 고정 변수·설명 설정.

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
- API에서 고정 변수·설명 설정.

예약 실행에는 외부 ticker가 필요하다. 현재 수동 “지금 실행” 버튼은 없다.

구현 근거: [Webhook 설정](../src/app/projects/[name]/settings/WebhookSection.tsx),
[Schedule 설정](../src/app/projects/[name]/settings/SchedulesSection.tsx), [Trigger 설계](design/triggers.md).

## 11. Workspace·Sandbox·Coding

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
현재는 제출형 작업과 출력 화면이며, 웹 IDE·파일 탐색기·대화형 터미널은 아니다.
Agent의 Workspace 도구는 로그인한 member 이상 사용자의 실행에서 제공하며, 프로젝트 Token이나
메신저·예약 실행이 같은 권한을 자동으로 얻지는 않는다.

구현 근거: [Workspace 화면](../src/app/workspaces/_components/WorkspacePanel.tsx),
[Workspace 도구](../src/application/workspace/workspaceTool.ts), [Workspace 설계](design/workspaces.md).

## 12. Documents·파일 생성·편집

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

OCR·원본 PDF 편집·범용 Office 편집기·수식 계산 엔진은 없다. 문서 업로드도 독립 Knowledge
Base에 색인하는 방식이 아니라, 추출문을 문맥에 넣거나 파일 ID로 읽는 방식이다.

구현 근거: [문서 처리 계약](../src/domain/document/processor.ts),
[File 도구](../src/application/document/fileTool.ts), [문서 설계](design/documents.md).

## 13. Audio Processing

- MP3·WAV·FLAC·Ogg 업로드.
- 원본 파일 가져오기.
- Transcription 모델 선택.
- 언어 지정.
- 원본 보존 기간·시간대.
- 후처리 Agent·버전 선택.
- 고정 버전 또는 발행본 사용.
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

저장소·전사 채널·별도 worker가 필요하다. 프로젝트 소유자인 member 이상의 개인 원본 처리이며,
실시간 음성 통화·마이크 받아쓰기·TTS 기능은 아니다. 외부 Documents·Memory 저장은 수신 MCP의
도구와 계약이 있어야 한다.

구현 근거: [Audio 화면](../src/app/projects/[name]/audio/page.tsx),
[Audio 도구](../src/application/audio/toolDefinitions.ts), [오디오 설계](design/audio-processing-spec.md).

## 14. Artifacts

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
- 실행·사용자·버전·하위 Agent·원본 관계 보관.
- API·자동화 등 다른 실행 표면의 출력 수집.

공개 프로젝트라고 산출물이 모두 공개되는 것은 아니다. 갤러리 검색은 전체 서버 전문 검색이
아니며, Office·PDF 원본은 다운로드 중심이다. 개인 Audio 원본·파생 파일의 소유권과 만료
검사는 일반 프로젝트 산출물 권한과 구분한다.

구현 근거: [Artifact 갤러리](../src/app/artifacts/_components/ArtifactGallery.tsx),
[산출물 권한](../src/application/artifact/artifactUseCases.ts).

## 15. Usage·비용 한도

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

등급별 한도는 현재 코드 정책이며, 관리자가 임의 숫자를 편집하는 콘솔은 없다.
비용 가드는 정확한 선불 예약·정산 시스템과 구분해야 한다.

구현 근거: [전체 비용 화면](../src/app/_components/Dashboard.tsx),
[사용량 조회·권한](../src/application/usage/usageUseCases.ts),
[등급 정책](../src/domain/member/tiers.ts), [비용·기록 설계](design/observability.md).

## 16. Traces

- 프로젝트별 기간 조회.
- Trace 상세.
- 버전·실행 시간·상태.
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
- 기타 실행의 샘플링.
- 선택적 OTLP export.

소유자·관리자에게 제공하며, 현재는 span 표 중심이다. 모델·도구 원문 전체 로그나 시각적
실행 그래프 편집기는 아니다.

구현 근거: [Trace 목록](../src/app/projects/[name]/traces/page.tsx),
[Span 표시](../src/app/projects/[name]/traces/TraceContent.tsx), [Trace 설계](design/observability.md#trace).

## 17. Audit

- 관리자 감사 기록 조회.
- 기간 필터.
- 시각·행위·행위자·대상·상세 표시.
- 시크릿 조회·발급/회전·폐기 기록.
- 관리자 프로젝트 변경 기록.
- 설정 변경.
- 프로젝트 삭제.
- 모델 카탈로그 설치·제거.
- 공유 레지스트리 삭제·소유 출처 변경.
- 타인 Artifact 삭제.
- 사용자 tier 변경.
- 보존 기간에 따른 정리.

현재 콘솔은 기간별 조회 중심이다. 행위자·대상별 검색 폼이나 사용자에 의한 기록 수정·삭제
기능은 없다.

구현 근거: [감사 화면](../src/app/audit/page.tsx), [감사 대상 행위](../src/domain/audit/types.ts).

## 18. 인증·Members·Profile

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

비밀번호 자체 가입 폼은 없다.

### Members

- 관리자용 사용자 목록.
- 이름·이메일·프로필 이미지.
- 가입 시각·마지막 로그인.
- Guest / Member / Admin 변경.
- 설정으로 지정한 관리자 tier 잠금.

사용자 초대 메일·계정 삭제·비밀번호 초기화 등을 제공하는 종합 계정 관리 화면은 아니다.

### Profile

- 본인 이름·이메일·이미지·tier.
- 가입 시각·마지막 로그인.
- 동시 실행·월 예산 정책.
- 이번 달 지출·한도 사용률.
- 기간별 개인 사용량.
- 프로젝트·모델·provider별 개인 비용.

현재 Profile은 조회 중심이며 프로필 편집 화면은 아니다.

구현 근거: [인증 구성](../src/lib/auth.ts), [Members 화면](../src/app/members/page.tsx),
[Profile 화면](../src/app/profile/page.tsx), [인증·인가 계약](SECURITY.md).

## 19. Settings

현재 실제 섹션은 `General / Access / LLM / Plugins repo / A2A`다.

### General

- Public Base URL.
- Artifact 접근 방식: Authenticated, Public, Proxied.

### Access

- 관리자 이메일 목록.
- 허용 이메일 도메인.

### LLM·Providers

- 기본 LLM Base URL.
- 기본 API Key.
- 미등록 모델 허용·거부 정책.
- Provider별 채널 추가·제거.
- Provider 선택.
- Base URL.
- API Key.
- Bearer / AWS SigV4 인증.
- 모델 provider prefix 유지 여부.

### Plugins repo

- GitHub 저장소.
- Branch.
- GitHub Token.

### A2A

- 공유 API Key.
- 생성·재발급·조회·숨기기·복사.
- 이름 있는 Client Key 목록.
- Client 이름·설명.
- Client Key 생성·조회·폐기.
- Client별 실행 귀속.

### 설정 공통

- 현재 값의 출처 표시: override / env / default / unset.
- 환경변수 대신 DB override 저장.
- Override 해제 시 환경변수로 복귀.
- 시크릿 마스킹·암호화 보관.

SSO·DB·스토리지·worker·retention 등 모든 배포 설정을 이 화면에서 편집할 수 있는 것은 아니다.

구현 근거: [Settings 섹션 정의](../src/app/settings/page.tsx),
[Settings API](../src/app/api/settings/route.ts), [설정 계약](CONFIGURATION.md).

## 20. 공통 화면·운영 기능

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

### 운영·기반 기능 — 별도 관리 UI가 없는 항목 포함

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

## 개편 시 별도로 결정할 항목

아래는 신규 기능 제안이 아니라 유지 필요와 제거 범위를 확인할 정리 후보이다.
소스에 존재한다는 사실만으로 실제 사용 중이라고 보지 않는다. 사용자의 사용 여부 확인이나
확인 가능한 운영 근거로 판단하며, 아직 확인되지 않은 기능을 임의로 삭제했다고 기록하지 않는다.
프로젝트 유형·버전 관리·모델 선택·기본 실행 경로·어댑터 전환·AG-UI 제거는
위의 [확정된 개편 방향](#확정된-개편-방향)을 따른다.

| 정리 후보 | 확인할 핵심 필요 | 미사용이면 제거할 범위 |
|---|---|---|
| Workspace·Sandbox·코딩 | 격리된 코딩 작업과 Git 승인 흐름이 실제 주요 용도인가 | 전용 화면·Agent 도구·작업 큐·worker·Sandbox·GitHub 연결·설정 |
| Audio Processing | 파일 전사·후처리·외부 저장을 실제 운영하는가 | 전용 화면·도구·큐·worker·전사/후처리 설정. 공통 파일 저장은 별도 판단 |
| 문서 생성·편집 | 읽기·생성·편집 중 어떤 연산과 파일 형식이 필요한가 | 미사용 연산·형식별 처리기·의존성. 필요한 첨부 읽기와 이미지 처리는 남긴다 |
| Plugins 동기화 | Skills·MCP를 저장소나 archive로 배포하는가 | 미사용 동기화·업로드·ticker·출처 관리. Skills·MCP 사용 자체와 분리해 판단 |
| 동적 역량 검색·Memory·하위 Agent | 자동 검색·장기 기억·위임 각각의 실제 사용 사례가 있는가 | 미사용 옵션·준비 경로·색인/연결·설정. Chat의 필요한 대화 이력과 구분 |
| 관리 화면·세부 옵션 | 해당 조회·설정이 핵심 사용이나 운영에 필요한가 | 중복 메뉴·집계·설정과 전용 API. 필요한 권한 검사·비용 보호·감사 기록은 유지 |

각 항목에 유지 / 통합 / 제거와 근거·영향 범위를 붙여 결정한다. 미사용으로 확인한 기능은
개선 후보로 되돌리지 않고 제거한다. 기본 실행에 필요하지 않은 기능 추가는 이번 개편 범위에서 제외한다.

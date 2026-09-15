# Workspace와 Sandbox

Workspace는 채팅과 독립적으로 파일과 실행 상태를 유지하는 작업 공간이다. Sandbox는 그
Workspace를 실행하는 일시적 컴퓨팅 자원이다. 저장소를 다루지 않는 일반 명령·스크립트 작업과
Codex·Claude·OpenCode를 사용하는 코딩 작업이 같은 생명주기와 저장소 계약을 사용한다.
기존 OpenAI Agents SDK의 대화 이력은 Workspace의 Runtime Session과 분리한다.

## 경계와 운영 조건

- `domain/workspace`는 공통 상태·포트와 한도를 소유한다. Git 정보와 승인 동작은
  `domain/coding`에 둔다. 일반 Workspace에는 저장소나 Git 브랜치가 필요하지 않다.
- application은 주입된 provider/runtime을 사용한다. Docker 명령과 CLI 프로토콜은
  infrastructure가 소유한다. 향후 Kubernetes provider는 같은 포트를 구현한다.
- 기능은 배포 설정으로 활성화한다. 비활성 상태의 기존 부팅·로그인·프로젝트 실행·콘솔에는
  새 네트워크 의존성을 추가하지 않는다. 폐쇄망은 내부 이미지·GitHub Enterprise·모델 endpoint를 사용한다.
- Sandbox에는 Docker socket, 호스트 경로, 운영 환경변수, 장기 Git 자격증명을 넘기지 않는다.
  Git 쓰기와 CI/CD 호출은 서버의 승인 경계에 둔다. 이미지와 네트워크는 운영자가 고정한다.
- 한 Workspace에서 한 작업만 실행한다. 큐 admission과 idempotency receipt를 같은 transaction에
  기록한다. lease가 끝난 작업은 실제 Sandbox 실행 상태를 먼저 확인하며, 불확실한 외부 효과를
  자동 재실행하지 않는다.
- 턴 완료는 작업 종료와 다르다. 턴 사이에는 Workspace와 Session을 유지하고, 명시적 종료·채팅
  삭제·비활성 TTL에는 Sandbox를 삭제한다. 복구용 파일·native Session 체크포인트가 저장된 뒤에만
  비활성 Sandbox를 삭제한다. 삭제 실패는 재시도 가능한 상태로 남긴다.
- DB는 Workspace·Sandbox·Session·Run·이벤트·승인·Diff·검사 결과·PR 정보를 보관한다.
  체크포인트 bytes는 암호화해 저장하며, 브라우저 응답에는 내보내지 않는다.

## CLI 계약 근거

- [Codex non-interactive mode](https://learn.chatgpt.com/docs/non-interactive-mode): JSONL 이벤트와 `exec resume`.
- [Claude Code headless](https://code.claude.com/docs/en/headless): `stream-json`과 명시적 session 재개.
- [OpenCode CLI](https://dev.opencode.ai/docs/cli/): JSON 출력, session 재개와 export/import.

설치된 CLI의 `--help`도 함께 확인한다. 배포 이미지는 검증한 CLI 버전을 고정한다.

## Docker 실행 계약

`sandbox/Dockerfile`은 Node·Git·Python과 고정 버전 CLI를 담는다. 이미지 빌드는 인터넷에
접근하는 빌드 환경에서 수행하고 폐쇄망에는 완성 이미지를 반입한다. `INSTALL_AGENTS=false`는
일반 명령 실행 검증용 이미지를 만든다. `pnpm test:sandbox`는 기본적으로
`agent-studio-workspace:test` 이미지와 `none` 네트워크에서 일회용 컨테이너를 검증한다.

Provider는 Docker CLI에 인자 배열을 넘긴다. API 입력과 모델 설정은 stdin으로 전달한다.
컨테이너 ID와 소유권 label을 확인한 뒤에만 조작하므로, 삭제 후 같은 이름으로 생긴 다른
컨테이너에 이전 handle로 접근할 수 없다. 컨테이너에는 호스트 mount와 Docker socket이 없고,
루트 파일시스템은 읽기 전용이다. 파일과 native Session은 크기가 제한된 tmpfs에 둔다.

`sandbox/control.mjs`가 실행 핸들·출력·종료 결과를 보호된 `/control/operations`에 기록한다.
명령은 uid/gid 1000으로 실행한다. 명령이 끝나면 같은 uid의 잔여 프로세스를 정리한다.
동일 operation ID와 동일 입력은 한 번만 시작하며, 다른 입력으로 ID를 재사용하면 거절한다.
이전 operation의 취소는 다음 operation에 적용되지 않는다. 재시작 시 PID와 `/proc`의 시작
시각을 함께 검사하고, 시작 전·시작 중·실행 중·완료·핸들 소실을 구별한다.

체크포인트는 파일·디렉터리·Workspace 내부 symlink와 native Session을 보관한다. 외부 경로,
경로 탈출, symlink 아래로 쓰는 복원, 특수 파일은 거절한다. 복원은 빈 Sandbox에서만 허용한다.
CLI 로그인 자격증명 파일은 체크포인트에서 제외한다. 64 MiB의 파일 bytes 또는 20,000개
항목을 넘으면 체크포인트를 실패시키며, 부분 백업을 성공으로 취급하지 않는다.
홈의 `.npm`, `.cache`, `.codex/.tmp`, `.codex/tmp`는 재생성 가능한 패키지·CLI 캐시라 제외한다.
native Session 이력과 SQLite 상태는 보관한다. Codex의 자동 plugin·App·hook 로딩은 끈다.

## Worker와 복구

`application/workspace/worker.ts`는 native 실행 → 검사 → 체크포인트 단계를 기록한다. Runtime
출력의 cursor와 미완성 JSONL 줄은 Run에 함께 남긴다. workspace lease와 revision을 확인한
쓰기만 이벤트·Session·Run을 바꿀 수 있다. 취소·종료 의도는 쓰기마다 다시 읽어 보존한다.
worker 중단은 실행 중단으로 기록하지 않는다. 다시 시작하면 같은 operation ID를 관찰하며,
전송 오류에는 Run을 유지하고 실제 핸들 소실에는 `interrupted`를 기록한다.

실행은 `executeWorkspaceTask` facade와 공통 `openTaskRun` bracket을 지난다. 일반 명령에는
모델 Version이 없으므로 모델을 임의로 만들지 않는다. 기존 프로젝트의 비용·멤버 상한,
동시성 슬롯과 메트릭은 유지한다. Native CLI의 토큰·비용은 SDK 모델 usage와 별개다.

비활성 Workspace는 `suspending`으로 바꿔 새 접수를 막은 뒤 체크포인트 저장 → Sandbox 삭제 →
`suspended` 순으로 처리한다. 백업·삭제 실패는 재시도할 상태로 남긴다. 채팅 삭제는 먼저
`closing`과 삭제 의도를 저장한다. 활동 중인 worker가 취소를 처리하거나 다음 worker가 정리하며,
Sandbox가 삭제된 뒤에만 `closed`를 기록한다. chat 행과 Workspace 정리 행은 별도 수명이다.
완료한 Workspace도 채팅 소유자의 새 요청으로 복원할 수 있다. 이 전이는 새 작업 접수와 함께
기록하며 늦게 도착한 worker 쓰기는 Workspace를 다시 열 수 없다. 새 요청과 턴 완료는 채팅과
native Session의 활동·보존 기한을 갱신한다. 완료 시 미결 승인 요청은 거절한다.
종료된 Workspace의 채팅을 삭제할 때도 소유자의 삭제 의도를 기록하고 남은 체크포인트를 정리한다.
대기 중 취소는 Sandbox를 만들기 전에 처리하며, 명령 시작 직전에도 취소·종료 의도를 다시 확인한다.

## Git과 승인

### 저장소 정책 관리

관리자는 Project Settings의 **Workspace 저장소 접근** 또는 Settings의 같은 섹션에서 기본 저장소,
추가 저장소와 허용 소유자를 관리한다. `repositoryOwners`는 정확한 계정·조직 이름을 대소문자 없이
비교하며 해당 소유자의 현재·향후 저장소를 허용한다. 임의 wildcard·URL·부분 owner 일치는 허용하지 않는다.
GitHub MCP 연결과 Workspace 서버 Git 자격증명은 별도이고, 정책 허용이 그 계정의 권한을 늘리지는 않는다.

`PROJECT#{name}/WORKSPACEPOLICY`는 Git 범위만 덮어쓴다. 이미지·네트워크·Runtime·검사·자원 한도와
`agentTools`는 배포가 소유한다. 저장된 규칙이 없으면 `WORKSPACE_CONFIG`로 돌아가고, 빈 규칙은
기본 저장소까지 포함해 모든 Git 작업을 차단한다. 초기화는 규칙만 제거하고 revision을 유지하므로
오래된 편집으로 새 정책을 덮어쓸 수 없다. 프로젝트 삭제와 정책 저장은 같은 수명 경계를 사용한다.
관리 변경은 감사 로그에 남으며 일반 Agent에는 정책을 수정하는 도구가 없다.

`getWorkspaceProjectPolicy`는 DB를 캐시하지 않는다. 앱의 접수·저장소 연결·Git 승인과 worker의 실행
진입이 같은 정책을 읽고, 조회 실패를 배포 기본값으로 대체하지 않는다. 변경은 다음 접수와 승인에
적용되며 이미 실행 중인 native 작업을 자동 취소하지 않는다. 정리·체크포인트는 별도 수명 규칙을 따른다.

새 저장소 생성 전 Agent는 `check_repository_access`로 정확한 owner/name의 허용 여부를 먼저 확인한다.
차단 결과와 `options`는 실제 `repository_policy_url`을 반환한다. 허용되지 않은 이름으로 원격 저장소를
먼저 만들거나, 관리 메뉴를 추측하거나, 이름을 바꿔 다른 저장소를 생성하지 않는다. 허용된 이름을 생성·
초기화한 뒤 `check_repository`로 서버 계정과 실제 branch를 검사한다. UI는 소유자 범위 내 새 이름도
입력받으며 관리 탭에서 돌아오면 규칙을 새로 읽고 작성 중인 작업 입력은 유지한다.

### Git 작업

Git Workspace 생성과 아직 clone되지 않은 공간의 실행 접수는 서버 GitHub 계정으로 저장소·기준 브랜치를
미리 확인한다. 허용 목록은 존재 여부가 아니며 저장소를 만들지 않는다. 접근 불가·초기 commit 없음·
기준 브랜치 없음은 구체적인 오류로 반환하고, 전송 실패와 구별한다. 이미 준비된 파일 작업에는 이
원격 사전 검사를 반복하지 않는다. clone 중 경합으로 실패하면 Git 진단을 제한해서 분류하며 원문·자격증명은 노출하지 않는다.

코딩 Workspace는 `sandbox/git.mjs`로 저장소를 clone하고 `agent/{workspace-id}` 브랜치를 만든다.
Git 디렉터리는 root 소유 `/control/git`이며, Agent의 파일 쓰기 권한으로 branch·index·config를
바꿀 수 없다. Git hook·외부 diff·textconv·credential helper를 사용하지 않는다. 공개 Git 호스트는
DNS 검증 결과를 `http.curloptResolve`로 고정하고 redirect를 거절한다. 내부 Git 호스트는 배포가 선언한다.

`CodingApproval`은 요청자·결정자·작업 인자와 검토한 전체 Git tree/HEAD의 fingerprint를 보관한다.
화면용 Diff가 잘려도 승인 fingerprint는 전체 tree에서 계산한다. 승인은 Workspace를 잠그고
실제 tree를 다시 확인한 뒤 `executing`으로 기록한다. 종료·삭제와 경합한 승인은 효과 전에 거절한다.
Commit은 로컬 브랜치와 암호화된 체크포인트에 저장한다. Push는 승인한 HEAD만 작업 브랜치에
게시하며 PR을 자동 생성하지 않는다. Commit & push는 한 번 검토한 변경을 커밋·체크포인트 저장한
뒤 새 HEAD를 게시한다. PR 요청도 게시를 포함한다. 동일 Commit
operation ID는 Git receipt로 중복 생성되지 않는다.

GitHub App의 private key는 서버에만 두고 Git 작업에는 저장소·권한을 한정한 1시간 이내의
installation token을 잠시 전달한다. 토큰은 Git 설정이나 체크포인트에 쓰지 않는다. PR 생성은
같은 작업 브랜치의 기존 PR을 재사용하며 Draft/Ready 전환도 명시적 승인을 따른다.
main 병합은 소유한 PR·정확한 head를 확인하고 merge API의 `sha` 조건으로 실행한다.
실행 중·실패한 검사는 병합을 막는다. 보고된 검사가 없는 커밋은 `none`으로 구분하고 승인 화면에
CI 증거가 없음을 표시하며 GitHub 브랜치 규칙을 따른다. `none`을 CI 성공으로 기록하지 않는다.
`push-main`은 이미 게시된 작업 브랜치의 커밋을 PR 없이 main에 fast-forward한다. 검토한 main SHA와
소스 HEAD·검사 상태를 승인 시 다시 확인하고 GitHub ref API에 `force: false`를 사용한다.
분기된 이력과 보호 규칙 거절을 우회하지 않는다. main 변경의 명시적 HTTP 거절은 `failed`로
기록해 잠금을 해제하고, 응답 소실은 `uncertain`으로 남겨 자동 재실행을 막는다.
배포는 허용한 workflow의 `main` 실행과 검토한 inputs만 사용하며 Sandbox에서 배포하지 않는다.
응답이 소실된 외부 효과는 `uncertain`으로 남기고 같은 승인을 자동 재실행하지 않는다.

계정 토큰 모드는 서버의 GitHub 설정을 재사용한다. 인증된 clone과 push는 서버의 임시 bare
저장소에서 수행하며, Sandbox에는 자격증명이 없는 Git bundle만 전달한다. 서버는 저장소
파일을 checkout하거나 hook·build script를 실행하지 않고 호스트의 Git 설정·credential helper를
상속하지 않는다. 임시 디렉터리는 작업 후 삭제한다. PR publish는 bundle의 정확한 head를
확인하고 지정된 `agent/` 브랜치만 push한다. [Git bundle](https://git-scm.com/docs/git-bundle)은
전체 commit 이력을 유지하므로 Sandbox 안에서도 clone·검토·복원 계약이 같다.

## 실행 창구별 계약

같은 Version을 Publish해도 모든 진입점에 같은 도구·이력·승인이 제공되는 것은 아니다.
`container.ts`의 Workspace 도구 바인딩은 `actor.kind=user`와 현재 member 권한, 프로젝트의
`agentTools`를 확인한다. `backgroundTask` 후처리에는 외부 효과 도구를 제공하지 않는다.

| 창구 | Workspace 빌트인 | 원래 Chat으로 승인 결과 전달 |
|---|---|---|
| 로그인한 member/admin의 Agent Chat | 배포가 허용하면 제공 | 같은 Chat의 SDK Session으로 자동 재개 |
| 로그인한 member/admin의 Playground·Agent 실행 API | 배포가 허용하면 제공 | source Chat이 없으므로 자동 재개 없음 |
| 프로젝트 API token | 미제공. actor는 `project-token` | Chat Session·승인 UI 없음 |
| Slack·Telegram·Teams | 플랫폼 actor이므로 미제공 | 플랫폼 응답이며 Chat 승인 UI 없음 |
| Webhook·Schedule | machine actor이므로 미제공. Schedule의 개인 문맥 옵션도 actor를 바꾸지 않음 | Trigger 이력으로 결과 확인 |
| Workspace 화면의 직접 작업·Git 검토 | 전용 API로 소유한 공간을 조작 | Agent가 만든 source Chat 연결이 있는 승인만 전달 |

API token은 프로젝트 소유자로 인증하고 MCP에 소유자 email을 전달한다. 이것은 브라우저 사용자
세션, Workspace 실행 자격, SDK 승인 UI와는 별개다. Skill이나 system prompt로 이 경계를 바꾸지 않는다.

## 사용자 화면과 API

배포의 `projects[].agentTools`를 켜면 로그인한 member 이상 사용자의 해당 프로젝트 Agent에
`Workspace` 빌트인을 제공한다. `options`, `start`, `run`, `status`, `wait`, `cancel`, `close`로
설정 조회·작업 접수·후속 실행·결과 확인·정리를 수행한다. 호출마다 현재 멤버 권한과 프로젝트
접근을 확인하며 다른 프로젝트의 Workspace ID는 거절한다. 비인간 실행과 background Task에는
이 도구를 제공하지 않는다. 프롬프트 미리보기에도 같은 사용자 기준으로 제공 여부를 표시한다.

Agent가 만든 Workspace는 자신의 Chat을 가진다. 요청을 조율하는 SDK 대화 이력과 native Session을
섞지 않고, 반환된 `workspace_id`로 후속 요청을 연결한다. SDK run과 tool call ID가 접수 중복을
막는다. `wait`는 최대 8초만 기다리고, 실행 중이면 반환된 Workspace 경로에서 계속 확인한다.
도구 출력은 cursor로 읽으며 생략된 출력·Diff는 표시한다. `prepare_git`는 Commit·Push·Commit & push·PR·main 병합·main 직접 Push의
검토를 준비하고 `approval_path`를 반환한다. Agent는 링크를 전달하고 승인까지 멈춘다.
Chat에서 요청한 승인은 `sourceChatId`를 보관한다. 승인 성공·실패·거절·결과 불명 기록과
`WorkspaceContinuation` 알림을 같은 transaction에 쓴다. 별도 Workspace worker의 알림 소비자는
원래 Chat의 소유권·프로젝트 접근·현재 Workspace 선택을 다시 확인하고 Chat run lease를 잡는다.
알림 claim과 채팅의 승인 결과 표시는 원자적으로 저장한다. 원래 SDK Session을 사용해 공통
`executeAgent` facade로 남은 요청을 이어가며, 새 사용자 메시지를 저장하거나 Git 동작을 재실행하지 않는다.
커밋·푸시 → PR → main 병합은 각각의 승인 결과가 다음 검토를 준비한다. 한 승인으로 뒤의 동작까지 승인하지 않는다.

PR 성공 결과의 검사 상태가 `pending`이면 `ci_watch`에 PR 번호·정확한 HEAD·30분 기한을 기록한다.
첫 후속 응답을 저장한 뒤 알림을 `waiting-ci`로 바꾸며, Worker는 15초 간격으로 원격 상태만 읽는다.
검사 완료·실패·HEAD/PR 상태 변경·대기 기한 초과 시 `workspace_ci_result`를 같은 채팅에 한 번
전달하고 SDK 이력으로 재개한다. 새 Workspace 작업·승인은 이전 CI 대기를 취소한다.
전송 실패를 검사 실패로 해석하지 않으며 기한까지 조회를 유지한다. 실패·변경·기한 초과는 병합 승인이 아니다.

알림은 브라우저 연결과 독립적이다. 다른 Chat run이나 SDK 승인이 진행 중이면 대기한다. 이미 claim한
알림의 lease가 만료되면 실패로 기록하고 자동 재실행하지 않는다. 사용자가 현재 결과를 확인한 뒤 이어가야 한다.
삭제된 Chat·Workspace, 바뀐 Workspace 선택과 철회된 접근 권한은 후속 실행을 취소한다.
Chat이 없는 Playground·직접 Workspace 화면 요청에는 원래 채팅을 추측해서 연결하지 않는다.

이 도구는 Git·배포 승인을 소비하지 않는다. Native 코딩 턴은 보호된 Git 경로와 승인 경계의
환경 지침을 받으며, 권한 변경·임시 인덱스·GitHub 도구로 Git 쓰기를 우회하지 않는다.
`status`는 실제 Git 동작 결과와 PR 정보를 반환하며 PR의 현재 HEAD·검사 상태를 GitHub에서 갱신한다.
`check_repository`는 공간 생성 없이 저장소 준비를 확인한다. 새 저장소가 요청되면 제공된 저장소 도구로
생성·초기화한 뒤 실제 브랜치를 검사한다. `workspace_url`·`approval_url`은 설정된 공개 주소가 있으면
완전한 웹 주소를 반환하며, 기존 path 필드는 상대 웹 경로로 유지한다.
사용 중·일시 중지한 Workspace는 변경된 PR 상태를 revision 조건으로 저장해 화면에도 반영한다.
동시 실행·종료가 먼저 기록되면 그 상태를 덮어쓰지 않으며 조회로 보존 기한을 연장하지 않는다.
종료된 Workspace의 Git 검토는 소유자가 action lease를 획득하며 같은 파일·Session을 복원한다.
새 native Run을 만들지 않으며, 삭제된 Chat과 Workspace는 복원하지 않는다.

플러그인의 `workspace-task`, `sandbox-task`는 이 기능을 사용하는 공용 작업 지침이다.
Agent의 설명·시스템 프롬프트에는 역할을 쓰고, 계정·저장소·변경사항은 사용자 요청에 둔다.

Chats의 Workspace 선택에서 프로젝트, Runtime, 선택적 저장소·기준 브랜치와 작업 내용을
입력한다. 기존 Chat 실행과 Workspace 실행은 같은 채팅 화면의 별도 경로를 사용한다.
목록은 `workspaceId`로 Workspaces와 대화를 나눠 표시하고, 각 그룹은 접을 수 있다.
Workspace 화면은 유형 배지와 실행 출력·Diff·검사 결과, 명시적 Git·배포 승인을 보여 준다.
승인 링크의 `#actions`는 Git·배포 탭을 바로 연다. 새 요청은
동일한 Workspace와 native Session에서 이어지며 페이지를 떠나도 서버 작업은 계속된다.

## 원래 채팅과 Workspace 선택

Agent 대화의 `Chat.linkedWorkspaces`는 실행 프로젝트마다 선택한 Workspace ID를 보관한다.
새 Workspace·전용 Chat·원래 Chat의 연결은 한 transaction에서 생성한다. 한 Chat의 연결은
최대 32개 프로젝트로 제한한다. 동시 생성과 서로 다른 tool call ID의 `start`도 같은 연결을
사용하며, 기존 Workspace를 반환할 때에는 새 작업을 접수하지 않는다. Chat이 없는 실행은
한 실행 내에서 `start`가 하나의 Workspace만 생성한다.

`options.current_workspace`는 현재 선택을 돌려준다. `run`은 선택된 Workspace에서 이어가며
`workspace_id`를 생략할 수 있다. Runtime·저장소 선택 필드를 함께 보내면 현재 선택과 대조한다.
`use_workspace`는 소유한 기존 Workspace를 명시적으로 선택하며 생성·실행·파일 복사는 하지 않는다.
새 작업 공간이 필요하면 새 Chat이나 직접 Workspace 생성 화면을 사용한다.

`attach_repository`는 Git 없는 Workspace의 빈 작업 폴더에만 저장소를 연결한다. ID와 Session은
유지하고, 기존 파일이 있으면 덮어쓰지 않고 거절한다. 이미 연결된 저장소와 기준 브랜치는 바꾸지
않는다. Git 파일의 체크포인트를 저장한 뒤 연결 메타데이터를 기록한다.

`workdir`는 파일을 쓰는 실제 작업 폴더이고 `workspace_path`는 브라우저 링크다. 작업과 검사는
기본 작업 폴더에서 상대 경로를 사용한다. `command`와 설정된 검사는 `/bin/sh -eu -s`로 실행해
실패한 명령 뒤에 다른 경로로 쓰기를 계속하는 일을 막는다.

새 Run을 접수하면 이전의 `pending` Git 검토를 같은 transaction에서 거절한다. 승인 실행이
이미 lease를 잡았거나 결과가 불확실하면 새 Run은 거절한다. 수정 후에는 새 Diff를 검토하고
다시 승인해야 한다. SDK 대화의 도구 승인·재개 계약과는 별개다.

`POST /api/workspaces`와 `POST /api/workspaces/{id}/runs`는 `Idempotency-Key`를 요구한다.
목록·이벤트는 제한된 페이지로 읽으며 클라이언트는 최근 실행 50개와 이벤트 2,000개를 유지한다.
`GET /api/workspaces/{id}`의 공개 view에는 lease, operation handle과 체크포인트 주소를 넣지 않는다.
모든 사용자 API는 member 이상과 Chat 소유권·현재 프로젝트 접근 권한을 확인한다.

`POST /api/workspaces/github/webhook`은 HMAC 서명을 검증한 뒤 PR 상태만 갱신한다. 이벤트 본문으로
작업을 실행하거나 승인하지 않는다. delivery ID와 본문 fingerprint를 상태 갱신과 함께 저장한다.
중복 배달은 같은 효과를 다시 쓰지 않으며 payload가 달라진 ID 재사용은 거절한다.

코딩 체크포인트는 Git 추적 파일과 무시되지 않은 새 파일, Git 이력과 native Session을 보관한다.
Git에서 무시하는 의존성·빌드 산출물은 다시 생성한다. 일반 Workspace는 Git 필터를 적용하지 않는다.

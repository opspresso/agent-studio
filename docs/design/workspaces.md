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

코딩 Workspace는 `sandbox/git.mjs`로 저장소를 clone하고 `agent/{workspace-id}` 브랜치를 만든다.
Git 디렉터리는 root 소유 `/control/git`이며, Agent의 파일 쓰기 권한으로 branch·index·config를
바꿀 수 없다. Git hook·외부 diff·textconv·credential helper를 사용하지 않는다. 공개 Git 호스트는
DNS 검증 결과를 `http.curloptResolve`로 고정하고 redirect를 거절한다. 내부 Git 호스트는 배포가 선언한다.

`CodingApproval`은 요청자·결정자·작업 인자와 검토한 전체 Git tree/HEAD의 fingerprint를 보관한다.
화면용 Diff가 잘려도 승인 fingerprint는 전체 tree에서 계산한다. 승인은 Workspace를 잠그고
실제 tree를 다시 확인한 뒤 `executing`으로 기록한다. 종료·삭제와 경합한 승인은 효과 전에 거절한다.
Commit은 로컬 브랜치와 암호화된 체크포인트에 저장하고, PR 요청에서만 push한다. 동일 Commit
operation ID는 Git receipt로 중복 생성되지 않는다.

GitHub App의 private key는 서버에만 두고 Git 작업에는 저장소·권한을 한정한 1시간 이내의
installation token을 잠시 전달한다. 토큰은 Git 설정이나 체크포인트에 쓰지 않는다. PR 생성은
같은 작업 브랜치의 기존 PR을 재사용하며 Draft/Ready 전환도 명시적 승인을 따른다.
main 병합은 소유한 PR·정확한 head·CI 성공을 확인하고 merge API의 `sha` 조건으로 실행한다.
배포는 허용한 workflow의 `main` 실행과 검토한 inputs만 사용하며 Sandbox에서 배포하지 않는다.
응답이 소실된 외부 효과는 `uncertain`으로 남기고 같은 승인을 자동 재실행하지 않는다.

계정 토큰 모드는 서버의 GitHub 설정을 재사용한다. 인증된 clone과 push는 서버의 임시 bare
저장소에서 수행하며, Sandbox에는 자격증명이 없는 Git bundle만 전달한다. 서버는 저장소
파일을 checkout하거나 hook·build script를 실행하지 않고 호스트의 Git 설정·credential helper를
상속하지 않는다. 임시 디렉터리는 작업 후 삭제한다. PR publish는 bundle의 정확한 head를
확인하고 지정된 `agent/` 브랜치만 push한다. [Git bundle](https://git-scm.com/docs/git-bundle)은
전체 commit 이력을 유지하므로 Sandbox 안에서도 clone·검토·복원 계약이 같다.

## 사용자 화면과 API

배포의 `projects[].agentTools`를 켜면 로그인한 member 이상 사용자의 해당 프로젝트 Agent에
`Workspace` 빌트인을 제공한다. `options`, `start`, `run`, `status`, `wait`, `cancel`, `close`로
설정 조회·작업 접수·후속 실행·결과 확인·정리를 수행한다. 호출마다 현재 멤버 권한과 프로젝트
접근을 확인하며 다른 프로젝트의 Workspace ID는 거절한다. 비인간 실행과 background Task에는
이 도구를 제공하지 않는다. 프롬프트 미리보기에도 같은 사용자 기준으로 제공 여부를 표시한다.

Agent가 만든 Workspace는 자신의 Chat을 가진다. 요청을 조율하는 SDK 대화 이력과 native Session을
섞지 않고, 반환된 `workspace_id`로 후속 요청을 연결한다. SDK run과 tool call ID가 접수 중복을
막는다. `wait`는 최대 8초만 기다리고, 실행 중이면 반환된 Workspace 경로에서 계속 확인한다.
도구 출력은 cursor로 읽으며 생략된 출력·Diff는 표시한다. 이 도구는 Git·배포 승인을 소비하지 않는다.

플러그인의 `workspace-task`, `sandbox-task`는 이 기능을 사용하는 공용 작업 지침이다.
Agent의 설명·시스템 프롬프트에는 역할을 쓰고, 계정·저장소·변경사항은 사용자 요청에 둔다.

Chats의 Workspace 선택에서 프로젝트, Runtime, 선택적 저장소·기준 브랜치와 작업 내용을
입력한다. 기존 Chat 실행과 Workspace 실행은 같은 채팅 화면의 별도 경로를 사용한다.
Workspace 화면은 실행 출력·Diff·검사 결과와 명시적 Git·배포 승인을 보여 준다. 새 요청은
동일한 Workspace와 native Session에서 이어지며 페이지를 떠나도 서버 작업은 계속된다.

`POST /api/workspaces`와 `POST /api/workspaces/{id}/runs`는 `Idempotency-Key`를 요구한다.
목록·이벤트는 제한된 페이지로 읽으며 클라이언트는 최근 실행 50개와 이벤트 2,000개를 유지한다.
`GET /api/workspaces/{id}`의 공개 view에는 lease, operation handle과 체크포인트 주소를 넣지 않는다.
모든 사용자 API는 member 이상과 Chat 소유권·현재 프로젝트 접근 권한을 확인한다.

`POST /api/workspaces/github/webhook`은 HMAC 서명을 검증한 뒤 PR 상태만 갱신한다. 이벤트 본문으로
작업을 실행하거나 승인하지 않는다. delivery ID와 본문 fingerprint를 상태 갱신과 함께 저장한다.
중복 배달은 같은 효과를 다시 쓰지 않으며 payload가 달라진 ID 재사용은 거절한다.

코딩 체크포인트는 Git 추적 파일과 무시되지 않은 새 파일, Git 이력과 native Session을 보관한다.
Git에서 무시하는 의존성·빌드 산출물은 다시 생성한다. 일반 Workspace는 Git 필터를 적용하지 않는다.

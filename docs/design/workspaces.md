# Workspace와 Sandbox

Workspace는 채팅과 독립적으로 파일과 실행 상태를 유지하는 작업 공간이다. Sandbox는 그
Workspace를 실행하는 일시적 컴퓨팅 자원이다. 저장소를 다루지 않는 일반 명령·스크립트 작업과
Codex·Claude·OpenCode를 사용하는 코딩 작업이 같은 생명주기와 저장소 계약을 사용한다.
기존 OpenAI Agents SDK의 대화 이력은 Workspace의 Runtime Session과 분리한다.

## 구현 계획과 검증 기준

1. 공통 `Workspace`, `Sandbox`, `RuntimeSession`, `WorkspaceRun`과 provider/runtime 포트를
   정의한다. PostgreSQL item store에서 revision, 작업 claim, 승인과 이벤트를 원자적으로
   기록한다. 동시 요청, 중복 요청, 소유권, 만료, 늦게 도착한 쓰기를 단위·통합 테스트한다.
2. Docker provider와 일반 명령 및 세 Coding CLI adapter를 구현한다. Sandbox 생성·복원·삭제,
   출력 스트리밍, 실행 취소, 체크포인트, Git 격리를 검증한다. CLI 세션 ID와 native 이력을
   보관해 동일 채팅의 후속 작업을 이어간다.
3. 프로젝트·기준 브랜치·Runtime·작업 입력과 진행 상황·Diff·검사 결과·후속 요청 화면을
   구현한다. 소유자 전용 API, 재연결, 채팅 삭제, 비활성 TTL과 worker 재시작을 검증한다.
4. 명시적인 Commit·Draft PR·PR·병합·배포 요청과 승인 내역을 구현한다. 병합은 PR의 정확한
   head와 CI 성공을 확인하고 사용자 승인을 소비한다. 배포는 허용된 CI/CD workflow만 호출한다.
   webhook 재전송과 결과가 불확실한 외부 요청을 중복 실행하지 않는지 검증한다.
5. 각 구현 단계마다 테스트와 커밋을 수행한다. 최종 typecheck, 전체 단위·통합 테스트,
   production build, 브라우저 확인 후 전체 diff를 검토하고 PR을 생성한다.

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

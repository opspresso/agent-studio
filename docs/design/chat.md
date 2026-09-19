# Chat

Chat은 agent Project를 실행하는 소유자별 비공개 대화다. 다른 사용자는 존재 여부도 조회할 수 없다.
실행은 공통 `ChatDeps.runAgent`에 바인딩한 `executeAgent`를 사용하고 HTTP self-call 없이
SSE로 전달한다. HTTP 계약은 [Chat API](../API.md#chats), 변경 불변식은
[Chat 지침](../../src/application/chat/AGENTS.md)과 [Runtime 지침](../../src/application/runtime/AGENTS.md)을 따른다.

## 저장과 실행의 경계

| 상태 | 목적·소유자 |
|---|---|
| Chat META | 제목·소유자·Project, `nextSeq`, 실행 lease, Workspace 연결 |
| ChatMessage | 화면의 user·assistant·tool 기록, 경고와 Artifact 참조. `run.ts`가 저장한다 |
| SDK Session | 모델에 재생할 native 이력과 승인 RunState. `runtime/session.ts`와 전용 SQL repository가 소유한다 |
| run log | 연결이 끊긴 독자가 실행을 따라잡는 짧은 버퍼. `runLog.ts`가 기록한다 |
| 브라우저 run store | 화면 이동 중 유지하는 현재 스트림과 표시 상태. `app/chats/_lib/runStore.ts`가 소유한다 |

한 Chat은 한 번에 한 실행 lease만 가진다. `claimChatRun`이 조건부 쓰기로 획득하고
다른 전송은 409로 거절한다. 이는 호출자 전체의 동시 실행 슬롯과 별개다.
Chat을 지우거나 실행이 다른 claim으로 넘어가면 이전 실행이 계속 쓰지 못하도록 상태를 확인한다.

화면 저장에서는 도구 행 다음에 그 실행의 평탄화된 assistant 행을 둔다. assistant는 최상위
답변·도구 호출·이미지·파일·경고를 담고 자식 결과에는 author 정보를 유지한다.
호출 ID는 run·author 범위에서 짝짓는다. 도구 호출만 있거나 파일만 나온 턴도 의미 있는 기록이다.

답변과 reasoning은 같은 아이템 예산을 공유한다. reasoning은 `reasoningTrace`를 켠 실행의
최상위 텍스트만 보관하고 `reasoningTokens`도 보관한 텍스트가 있을 때 함께 저장한다.
모델 Usage의 reasoning 토큰 집계는 이 표시 기록과 별개다.
한계값은 [CONFIGURATION](../CONFIGURATION.md#코드에-고정된-제한)에 있다.

## SDK Session과 승인

새 턴은 새 사용자 입력만 실행에 전달한다. SDK Session이 이전 native 모델·도구 items를 결합하며
화면용 ChatMessage에서 이력을 재구성하지 않는다. Memory recall은 독립적인 장기 문맥 기능이다.
Session이 없거나 만료되면 화면 기록은 유지하고 새 모델 문맥으로 시작한다는 경고를 표시한다.

Session은 오래된 완전한 턴과 이미지를 예산에 맞춰 생략하고 그 손실을 알린다.
모델의 reasoning은 표시 옵션과 무관하게 원래 모델 턴에 붙어 재생된다.
이력과 승인 체크포인트는 같은 암호화 payload와 revision CAS로 저장한다.

승인이 필요한 도구는 효과 실행 전에 RunState를 저장한다. 소유자는 Agent·도구·전체 인자를
검토하고 승인·거절한다. 승인 중에는 새 메시지를 보내지 못하며 승인 재개는 새 user 행을 만들지 않는다.
재개는 정확한 revision·항목 ID, 현재 프로젝트 접근, 버전·도구 binding fingerprint를 검사한다.

체크포인트를 running으로 선점한 후 중단된 실행은 도구 효과가 불확실하므로 자동 재실행하지 않는다.
살아 있는 lease가 없을 때 폐기하면 화면 기록은 보존하고 미완료 실행을 다음 모델 문맥에서 제외한다.
Chat 삭제는 Session tombstone을 먼저 남겨 늦게 끝난 실행이 모델 이력을 되살리지 못하게 한다.
암호화와 권한은 [보안 계약](../SECURITY.md#sdk-session과-승인-상태)을 따른다.

## 런은 자기 연결보다 오래 산다

브라우저 연결 종료와 실행 취소는 별개다. `detachOnReturn`은 소비자가 떠나면 source를
백그라운드에서 끝까지 읽는다. route는 그 작업을 `after()`에 등록하고 SSE에
`AbortController`를 넘기지 않는다. 서버 프로세스 자체의 급사까지 복구하는 영속 worker는 아니다.

Stop은 `DELETE /api/chats/{chatId}/runs/{runId}`로 `cancelRequestedAt`을 기록한다.
실행 측은 모델 출력이 없는 동안에도 `watchChatCancel`로 상태를 순차 조회한다.
다른 인스턴스가 받은 취소도 전달되며 사용자 중지와 실행 claim 교체를 구분해 기록한다.

종료 순서는 **화면 메시지 저장 → 종단 로그 → 실행 lease 해제**다.
lease 해제는 source 바깥의 `runLog.ts`가 맡는다. 준비 단계 실패는 준비 측이 획득한 claim을 정리한다.
저장·로그 실패는 보고하며 분리된 실행의 drain 실패가 lease를 영구히 잡아 두지 않게 한다.

### 재생 로그

연결이 유지되는 일반 실행은 프레임을 제한된 메모리 버퍼에만 모은다. 연결이 끊기면 남아 있는
버퍼를 저장하고 이후 출력을 묶어 기록한다. 버퍼가 넘으면 앞부분을 버리며 replay에 누락 경고를 넣는다.
이를 실행 전체의 영구 기록으로 사용하지 않는다.

이미지·파일 bytes와 순수 reasoning 프레임은 로그에 넣지 않고 안내문으로 대체한다.
그 결과는 실행이 끝난 뒤 저장된 메시지에서 읽는다. 저장소가 없거나 저장에 실패한 출력은
재접속으로 복원할 수 없다.

`GET …/runs/{runId}/stream`은 로그를 재생하고 새 행을 따라간다. 원래 창이 계속 연결되어
로그가 비어 있으면 두 번째 창은 동일 출력을 실시간으로 받지 못하며 잠시 후 안내를 받는다.
반면 Workspace 후속 실행은 처음부터 detached 기록을 시작한다.

### 클라이언트 상태와 시간

모듈 단위 run store가 fetch를 소유하고 컴포넌트는 `useSyncExternalStore`로 구독한다.
내비게이션·unmount로 fetch를 중단하지 않는다. 프레임은 즉시 fold하되 구독 알림은 수집
윈도로 묶고 메시지 참조를 안정적으로 유지해 과거 답변의 재렌더를 줄인다.

`{ ended: true }` 없이 연결이 끝나면 실행 상태를 조회하고 필요한 경우 replay에 다시 붙는다.
새 로그는 처음부터 다시 fold할 수 있으며 연속 실패와 전체 재접속 횟수에 각각 상한이 있다.
연결 실패만으로 서버 실행 완료를 추측하지 않는다.

처음 받은 head의 `elapsedMs`로 실행 시계를 시작한다. replay만으로 시작한 창은 시작 시각을
모르므로 0초짜리 새 실행처럼 표시하지 않는다. 같은 run에 다시 붙으면 알고 있던 시작점을 유지한다.
`endedAtMs`는 실제 종단 프레임을 받은 경우에만 설정한다.

저장된 답변 시간은 `turnDuration.ts`가 seq 순서의 user·assistant 시각에서 유도하고
중간 도구 행은 건너뛴다. Workspace 후속 답변은 플랫폼 결과 행을 기준으로 한다.
스톱워치와 저장 시간은 같은 내림 규칙을 사용하며 진행 표시 높이를 예약해 레이아웃 이동을 줄인다.

### 스크롤과 입력

`ChatThread`의 `use-stick-to-bottom`이 viewport를 소유한다. 아래를 읽을 때 답변을 따라가고,
위로 이동한 사용자는 최신으로 이동하는 버튼으로 돌아온다. 메시지 전송은 다시 답변을 따라가는 행동이다.
버튼은 `isNearBottom`을 사용하고 스레드 자식이 양 축을 모두 스크롤해 wheel 이벤트를 가로채지 않게 한다.
Enter 전송은 IME 조합을 보존하는 공통 `isSubmitEnter`를 사용한다.

## 사이드바와 스레드가 읽는 범위

사이드바는 `CHAT_PAGE` 단위로 조회하고 더 보기는 증가한 `limit`을 요청한다.
동일한 `updatedAt`을 갖는 Chat을 구분하는 cursor가 없어 크기를 늘려 다시 읽는다.
서버 상한을 넘는 무한 더 보기 버튼을 만들지 않으며 경로 변경만으로 목록을 다시 읽지 않는다.

메시지 DB 조회는 `listChatMessages`의 페이지당 100행이다. 전체 대화 읽기는 페이지들을 합치므로
응답 전체가 100행으로 제한되는 것은 아니다. 실행 뒤에는 `sinceSeq` 다음 행만 읽고,
`sinceSeq=0`도 실제 경계로 처리한다. Chat을 바꾸면 이전 tail 기준을 지운다.

새로 읽은 메시지가 기존 사본을 대체하고 seq 순으로 정렬한다. 원본 파일·이미지의 서명은
제한된 동시성으로 수행한다. 오래 열린 화면은 서명 만료 전에 다음 완료 동기화에서 전체를
다시 읽어 주소를 갱신한다. 화면 조회, 모델 Session, 재접속 로그의 예산을 서로 혼용하지 않는다.

## 첨부

이미지는 검증된 inline bytes로 모델에 전달하며 모델의 `imageInput` capability가 필요하다.
SDK Session이 최근 이미지와 편집 핸들을 다음 턴으로 이어 준다.
화면에서는 Artifact 참조를 서명하지만 모델 이력을 그 URL로 다시 구성하지 않는다.

문서는 수신 표면의 `DocumentExtractor`가 텍스트로 바꾸고 `documentParts.ts`가
파일명·데이터 경계를 붙여 턴에 넣는다. 원본이 보관되면 모델에는 파일 ID를 안내하고,
화면 조회에는 추출문 대신 파일명·상태·원본 참조를 제공한다.
추출 실패·예산 초과·빈 텍스트는 경고하며 원본 참조와 순서를 유지한다.

텍스트만 있는 턴은 문자열이고 이미지가 있을 때 content-parts 배열을 만든다.
`decodeUtf8Text`로 UTF-8을 확인하며 잘못된 bytes를 replacement 문자로 바꾼 성공으로 취급하지 않는다.
형식별 읽기·편집과 파일 권한은 [문서 엔진](documents.md)이 소유한다.

## Workspace 후속 실행

`Chat.workspaceId`는 Chat 자체가 Workspace 실행 패널일 때 사용한다.
일반 Agent 대화가 선택한 작업 공간은 `linkedWorkspaces`에 프로젝트별로 기록한다.
Workspace use case의 transaction이 이 선택을 관리하고 일반 Chat 갱신은 보존한다.

승인·CI 결과는 `workspaceAction`이 있는 플랫폼 assistant 행으로 표시한다.
worker는 원래 소유자·프로젝트·Workspace 선택·SDK Session을 확인한 뒤 검증한 결과 이벤트로
후속 실행을 시작한다. 플랫폼 결과를 새 사용자 요청이나 다음 Git 동작의 승인으로 해석하지 않는다.

연결된 화면은 보이는 동안 실행이 없을 때 tail을 확인하고 새 run을 발견하면 재접속한다.
CI 대기는 모델 턴을 소비하지 않으며 결과를 `workspaceAction.event=ci`로 전달한다.
알림 선점 후 중단된 실행은 자동 반복하지 않는다.
상태·권한·worker 계약은 [Workspace 설계](workspaces.md#원래-채팅과-workspace-선택)를 따른다.

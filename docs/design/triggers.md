# 트리거

Webhook 전달과 Schedule 발화는 현재 Agent 설정을 백그라운드 실행한다.
HTTP 요청·응답은 [API](../API.md#triggers), ticker·보존·알림은
[OPERATIONS](../OPERATIONS.md#schedule-티커)를 따른다.

## Webhook

Agent에는 예약 ID `webhook`인 Webhook 하나와 이름이 있는 Schedule들을 둘 수 있다.
Webhook 주소는 `agentWebhookPath`가 만드는 `/api/webhook/{agent}`다.
다른 ID의 Webhook이나 `webhook`이라는 Schedule 생성은 거절한다.

trigger와 실행 이력은 Agent 파티션에 저장하고 실행 이력에 보존 기간을 적용한다.
모델 실행은 Agent와 함께 읽은 현재 Agent 설정을 고정한다.

| 경계 | 동작 |
|---|---|
| 인증 | enabled 검사 전에 Agent secret을 상수 시간 비교한다 |
| GitHub | 원본 body의 HMAC과 event·delivery header를 검사한다. GitHub 헤더가 있으면 일반 secret 방식으로 후퇴하지 않는다 |
| 중복 | `Idempotency-Key`, GitHub의 경우 delivery ID를 조건부 claim한다 |
| 겹침 | 기본 `allowConcurrent: false`; DB 실행 슬롯으로 같은 trigger의 겹침을 거절한다 |
| 입력 | JSON payload를 사용자 메시지로 직렬화한다 |
| 실행 | 202 접수 후 `after()`에서 실행한다. 202는 성공적인 처리 완료가 아니다 |

인증 실패·미설정·비활성·중복·서명된 ping은 새 실행 이력을 만들지 않는다.
admission에서 Agent·현재 설정이 없거나 겹침·실행 사용자 정책에 거절된 경우에는
skipped 이력을 남긴다. 시작한 실행은 running에서 succeeded 또는 failed로 마감한다.
한도나 capability 손실은 succeeded에서도 warning으로 남을 수 있다.

### GitHub PR 리뷰

관리자는 Webhook의 `githubReview`를 설정해 일반 payload 실행 대신 PR 리뷰를 선택할 수 있다.
`scope: accessible`은 설치의 GitHub 계정이 접근 가능한 저장소를, `scope: repositories`와
`repositories`는 지정한 정확한 `owner/repo` 목록만 허용한다. 기본은 비활성이다.
리뷰 설정 변경은 공유 GitHub 자격 증명을 위임하므로 Agent 쓰기 권한에 더해 관리자를 검사한다.
시크릿을 가진 송신자는 선택 범위의 리뷰를 요청할 수 있으므로 등록할 저장소에만 시크릿을 제공한다.

GitHub의 Pull requests 이벤트를 구독한다. HMAC이 유효한 `pull_request`의
`opened`, `synchronize`, `reopened`, `ready_for_review`만 처리하며 draft·closed·대상 불일치는
모델 실행 전에 ignored로 반환한다. 이 모드는 `X-Trigger-Secret` 단독 인증을 받지 않는다.
중복 키는 base repository·PR 번호·HEAD SHA이며 같은 커밋의 다른 delivery도 한 번만 처리한다.
일반 Webhook과 같은 보존 기간·유실 시 비재실행 계약을 적용한다.

GitHub 어댑터가 고정된 API 주소로 PR과 최대 100개 변경 파일의 diff를 읽고 HEAD를 재검사한다.
파일당 12,000자, 전체 파일 문맥 80,000자 내에서 입력하며 누락·잘림을 게시 본문에도 표시한다.
`backgroundTask` 실행은 Skill만 읽고 MCP·외부 조회·코드 실행·파일 생성·위임을 제공하지 않는다.
PR 자료가 게시 대상이나 권한을 선택하지 않는다. 이 리뷰는 제공된 변경 내용 검토이며 테스트 실행이나
전체 저장소 감사를 수행하지 않는다.

모델의 정상 완료·비어 있지 않은 20,000자 이하 응답·경고 없음을 확인한 뒤,
현재 Webhook 활성 상태와 저장소 권한 설정을 다시 읽는다. 어댑터가 PR의 열린 상태·draft·HEAD를
재검사하고 해당 commit_id에 `COMMENT` 리뷰만 게시한다. 확인 직후 새 커밋이 생기더라도 리뷰는
검토한 커밋에 연결된다. 승인·변경 요구·merge는 하지 않는다. 전송 오류나 확인되지 않은 응답을
자동 재전송하지 않는다. 이력의 `review`는 대상과 posted/skipped/failed·실제 게시 URL을 보관한다.

## 실행 문맥과 결과

Webhook actor는 `webhook`이며 payload의 이메일을 사용자 권한으로 사용하지 않는다.
Schedule은 소유자가 `runAsOwner`를 명시적으로 켰을 때만 확인한 `executionEmail`을 저장하고
admission·실행 직전에 현재 Agent 소유권과 member 상태를 다시 검사한다.

이메일은 개인 MCP·오디오 문맥에 사용할 수 있지만 actor는 `schedule`로 유지한다.
Webhook·Schedule은 user 전용 Workspace 도구와 영속 Chat 승인 화면을 얻지 않는다.
[창구별 계약](workspaces.md#실행-창구별-계약)을 따른다.

실행 출력은 Trigger 이력과 Artifact에 기록한다. 이력은 제한된 텍스트·오류·경고를 담으며
이미지 bytes를 넣지 않고 생성 사실을 적는다. 별도 객체 저장소가 있으면 결과 파일을 보관한다.
Schedule의 플랫폼 전송 결과는 아래의 `deliveryResults`로 구분한다.

## Schedule

외부 ticker가 공유 token으로 `POST /api/triggers/scan`을 호출한다.
ticker는 cron 상태를 갖지 않고 `scanSchedules`가 발생 판정·claim·admission을 수행한다.

cron의 정본은 `domain/trigger/cron.ts`다. 분·시·일·월·요일의 다섯 필드에
별표·목록·범위·step과 월·요일의 3글자 이름을 지원한다. 요일 0과 7은 일요일이다.
일과 요일을 모두 제한하면 둘 중 하나가 맞는 전통적인 OR 규칙을 사용한다.
발생은 IANA 시간대의 벽시계를 UTC 분 instant로 바꾸어 식별한다.
DST에서 없는 시각은 발생하지 않고 반복되는 시각은 서로 다른 두 instant다.

| 상황 | 처리 |
|---|---|
| 여러 인스턴스·겹친 tick | `schedule:{instant}` 조건부 claim에서 한 요청만 이긴다 |
| 잠시 놓친 tick | 한정된 catch-up 창 안의 발생만 처리한다 |
| 생성·편집·재활성화 | 마지막 편집 이전의 발생을 소급 실행하지 않는다 |
| 겹침 금지 상태의 여러 누락 발생 | 가장 최근 것을 실행하고 오래된 것은 superseded로 기록한다 |
| 일부 trigger의 저장소 오류 | 해당 발생을 거절·기록하고 summary의 errors를 증가시킨다 |
| claim 후 프로세스 유실 | 같은 발생을 자동 재실행하지 않고 이력만 복구한다 |

claim은 보존 기간이 있는 중복 방지 행이다. 소비한 발생을 다시 실행하지 않는 것은 실행 정책이며
DB 행을 영구 보관한다는 뜻은 아니다. 정상 catch-up 창은 claim 보존 기간보다 짧다.
Webhook의 같은 멱등 키는 만료 시각이 지났어도 행이 실제 sweep되기 전까지 중복으로 거절한다.
scan이 없는 배포에서는 같은 키가 계속 남을 수 있으므로 새 이벤트에는 새 키를 사용한다.

Schedule은 저장한 message를 사용하고 자기 secret이나 외부 payload를 요구하지 않는다.
schedule 인덱스는 페이지로 순회하며 admission과 실제 발화에 각각 동시성 상한을 적용한다.
한 번의 DB 조회와 동시에 수행하는 작업을 제한하는 것이며, 전체 Agent·발생 수의 전역 cap은 아니다.
구체적인 값은 [CONFIGURATION](../CONFIGURATION.md#코드에-고정된-제한)을 따른다.

접수한 발생은 `queued` 이력에 `queuedAt`과 갱신 가능한 `queueLeaseUntil`을 기록한다.
tick 응답의 `fired`는 접수한 수이며 실제 시작·완료 수가 아니다. 대기 중에도 겹침 금지 예약을
유지하고 lease의 1/3 간격으로 소유 token을 확인해 갱신한다. 실행 worker가 자리를 얻으면
예약을 다시 갱신하고 정확한 queued lease를 조건부로 `running`으로 바꾸며 `startedAt`을 기록한다.
대기 시간은 실행 lease와 running 복구 시계에 포함하지 않는다. `runId`와 `scheduledFor`는
접수부터 완료까지 같다. 저장 key는 실행 시작 시각으로 원자적으로 옮겨 이력 정렬과 running
복구의 시각 범위를 유지한다. 아직 시작하지 않은 이력의 `startedAt`은 없으며 콘솔은 `—`로 표시한다.

예약 갱신 실패·만료·소유권 유실은 발화를 실패로 마감하며 모델이나 도구를 실행하지 않는다.
스캔 중단이나 background driver 오류도 남은 대기의 타이머와 예약을 정리한다.

Slack·Telegram·Teams를 각각 하나의 delivery 대상으로 고를 수 있다.
오류 없이 끝난 텍스트 응답을 독립적으로 전송하고 `sent`·`failed`를 `deliveryResults`에 남긴다.
전송 실패는 모델 실행 성공을 실패로 바꾸지 않고 warning을 추가한다.
Slack은 Agent bot의 참가 채널, Telegram은 chat과 선택적 topic, Teams는 conversation을 사용한다.
Teams serviceUrl을 사용자 입력으로 받지 않는다.

## 유실된 발화 복구

Webhook·Schedule은 ACK 후 웹 프로세스에서 실행하므로 급사하면 running 이력이 남을 수 있다.
`repairLostRuns.ts`는 실행 lease와 추가 여유가 지난 running 행을 failed로 마감한다.
도구의 외부효과를 알 수 없으므로 작업을 재실행하지 않는다.
queued 행은 별도 lease 만료 인덱스로 읽고 해당 lease가 여전히 같은 경우에만 failed로 바꾼다.
정상 heartbeat나 실행 시작이 먼저 반영되면 오래된 복구 쓰기는 거절된다. 프로세스가 유실된
대기 역시 자동 재실행하지 않는다.

주기적 scan의 복구 tick은 모든 Agent의 Webhook·Schedule을 순회한다.
Webhook 전달이 끝날 때도 자기 trigger의 과거 실행을 정리하므로 ticker가 없는 설치는
다음 전달에서 정리할 수 있다. ticker도 다음 전달도 없으면 자동 정리가 진행되지 않는다.

복구 query는 running의 시작 시각 또는 queued의 lease 만료 시각·상태·보존 만료 조건을 limit 전에 적용한다.
완료 행이 복구 대상의 자리를 차지하지 않으며 한 번에 읽을 행 수와 Agent 병렬 처리 수를 제한한다.
비활성 trigger의 이전 실행도 확인하고 개별 파티션 오류는 다른 복구를 중단시키지 않는다.
마감 기준·주기는 [고정 제한](../CONFIGURATION.md#코드에-고정된-제한)이 소유한다.

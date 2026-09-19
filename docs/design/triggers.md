# 트리거

Webhook 전달과 Schedule 발화는 발행된 Project Version을 백그라운드 실행한다.
HTTP 요청·응답은 [API](../API.md#triggers), ticker·보존·알림은
[OPERATIONS](../OPERATIONS.md#schedule-티커)를 따른다.

## Webhook

Project에는 예약 ID `webhook`인 Webhook 하나와 이름이 있는 Schedule들을 둘 수 있다.
Webhook 주소는 `projectWebhookPath`가 만드는 `/api/webhook/{project}`다.
다른 ID의 Webhook이나 `webhook`이라는 Schedule 생성은 거절한다.

trigger와 실행 이력은 프로젝트 파티션에 저장하고 실행 이력에 보존 기간을 적용한다.
모델 실행은 `resolveRunnableVersion`으로 발행 버전만 선택한다.

| 경계 | 동작 |
|---|---|
| 인증 | enabled 검사 전에 프로젝트 secret을 상수 시간 비교한다 |
| GitHub | 원본 body의 HMAC과 event·delivery header를 검사한다. GitHub 헤더가 있으면 일반 secret 방식으로 후퇴하지 않는다 |
| 중복 | `Idempotency-Key`, GitHub의 경우 delivery ID를 조건부 claim한다 |
| 겹침 | 기본 `allowConcurrent: false`; DB 실행 슬롯으로 같은 trigger의 겹침을 거절한다 |
| 입력 | message 모드는 JSON을 사용자 턴으로 직렬화하고 variables 모드는 최상위 scalar만 고정 변수 위에 덮는다 |
| 실행 | 202 접수 후 `after()`에서 실행한다. 202는 성공적인 처리 완료가 아니다 |

인증 실패·미설정·비활성·중복·서명된 ping은 새 실행 이력을 만들지 않는다.
admission에서 Project·발행 버전이 없거나 겹침·실행 사용자 정책에 거절된 경우에는
skipped 이력을 남긴다. 시작한 실행은 running에서 succeeded 또는 failed로 마감한다.
한도나 capability 손실은 succeeded에서도 warning으로 남을 수 있다.

## 실행 문맥과 결과

Webhook actor는 `webhook`이며 payload의 이메일을 사용자 권한으로 사용하지 않는다.
Schedule은 소유자가 `runAsOwner`를 명시적으로 켰을 때만 확인한 `executionEmail`을 저장하고
admission·실행 직전에 현재 프로젝트 소유권과 member 상태를 다시 검사한다.

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

Schedule은 고정 variables·message를 사용하고 자기 secret이나 외부 payload를 요구하지 않는다.
schedule 인덱스는 페이지로 순회하며 admission과 실제 발화에 각각 동시성 상한을 적용한다.
한 번의 DB 조회와 동시에 수행하는 작업을 제한하는 것이며, 전체 프로젝트·발생 수의 전역 cap은 아니다.
구체적인 값은 [CONFIGURATION](../CONFIGURATION.md#코드에-고정된-제한)을 따른다.

Slack·Telegram·Teams를 각각 하나의 delivery 대상으로 고를 수 있다.
오류 없이 끝난 텍스트 응답을 독립적으로 전송하고 `sent`·`failed`를 `deliveryResults`에 남긴다.
전송 실패는 모델 실행 성공을 실패로 바꾸지 않고 warning을 추가한다.
Slack은 프로젝트 bot의 참가 채널, Telegram은 chat과 선택적 topic, Teams는 conversation을 사용한다.
Teams serviceUrl을 사용자 입력으로 받지 않는다.

## 유실된 발화 복구

Webhook·Schedule은 ACK 후 웹 프로세스에서 실행하므로 급사하면 running 이력이 남을 수 있다.
`repairLostRuns.ts`는 실행 lease와 추가 여유가 지난 running 행을 failed로 마감한다.
도구의 외부효과를 알 수 없으므로 작업을 재실행하지 않는다.

주기적 scan의 복구 tick은 모든 프로젝트의 Webhook·Schedule을 순회한다.
Webhook 전달이 끝날 때도 자기 trigger의 과거 실행을 정리하므로 ticker가 없는 설치는
다음 전달에서 정리할 수 있다. ticker도 다음 전달도 없으면 자동 정리가 진행되지 않는다.

복구 query는 시작 시각·running 상태·만료 조건을 limit 전에 적용한다.
완료 행이 복구 대상의 자리를 차지하지 않으며 한 번에 읽을 행 수와 프로젝트 병렬 처리 수를 제한한다.
비활성 trigger의 이전 실행도 확인하고 개별 파티션 오류는 다른 복구를 중단시키지 않는다.
마감 기준·주기는 [고정 제한](../CONFIGURATION.md#코드에-고정된-제한)이 소유한다.

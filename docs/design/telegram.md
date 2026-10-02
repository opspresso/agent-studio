# Telegram

Agent별 BotFather token을 저장하고 `/api/telegram/webhook/[agent]`로 메시지를 받는다.
설정·응답은 [API](../API.md#레지스트리연동-오퍼레이션), 요청 인증은
[SECURITY](../SECURITY.md#머신-호출자의-요청-인증), 실행·첨부·종료는
[공통 메시징 파이프라인](messaging.md)을 따른다.

## 자격 증명과 Webhook

`agentTelegram.ts`는 새 token을 `getMe`로 확인하고 bot username을 함께 저장한다.
masked·빈 입력은 기존 token을 유지한다. 봇 ID는 token의 콜론 앞 숫자로 식별한다.
앱이 만드는 Webhook secret(`asg_…`)은 암호화해 저장하고 `setWebhook`에 전달한다.
Telegram이 돌려주는 `X-Telegram-Bot-Api-Secret-Token`을 상수 시간 비교하며 secret을
콘솔에 공개하지 않는다.

| 변경 | 처리 |
|---|---|
| 활성화 | 설정 저장 후 현재 주소에 Webhook을 등록한다 |
| 비활성화 | 설정 저장 후 Webhook 삭제를 시도한다 |
| token 교체 | 이전 Webhook 삭제를 시도하고 secret을 교체한다. 활성 상태면 새 봇을 등록한다 |
| 연결 해제 | credential을 제거한 뒤 이전 Webhook 삭제를 시도한다 |
| Agent 삭제 | credential을 잃기 전에 활성 봇의 Webhook 삭제를 시도한다 |
| 주소 변경·등록 실패 | 명시적 Register webhook으로 현재 주소에 다시 등록한다 |

자동 등록·삭제 실패는 저장을 되돌리지 않는다. 등록 실패는 응답 warning과 로그로,
삭제 실패는 로그로 확인한다. 명시적 Register webhook의 실패는 호출자에게 전파한다.
`setWebhook`·`deleteWebhook` 모두 `drop_pending_updates: true`로 이전 대기 update를 버린다.
요청하는 update 종류는 `message`뿐이며 편집·채널 게시물·callback은 처리하지 않는다.

## 답을 전달하기

`replyChannel.ts`는 `createEditInPlaceReply`에 Telegram 호출과 한도를 연결한다.
답변은 평문 메시지로 시작해 편집하며 마지막에 `markdown.ts`로 HTML을 렌더한다.
굵게·기울임·취소선·코드·HTTP(S) 링크를 지원하고 제목은 굵게, 목록은 bullet로 표현한다.
지원하지 않는 문법은 escape한 텍스트로 남는다.

- 메시지는 4,096자 한도 안에서 나누고 첫 메시지만 질문을 인용한다.
  공통 `messageCut`의 경계 우선순위와 마지막 800자 탐색 창을 사용한다.
- 편집은 2초 간격이며 typing indicator는 chunk가 없어도 4초마다 갱신하고 종료 시 정리한다.
- 마지막 렌더링은 조각들을 함께 처리해 경계에 걸린 코드 펜스를 이어 준다.
  HTML 전송이 거절되면 평문을 시도하고, 마감 실패 시 미전송 꼬리만 별도로 보낸다.
  지속적인 API 장애에서 전달 완료를 보장하지 않는다.
- 파일 링크·warning도 답과 함께 렌더한다. 이미지 출력은 `sendPhoto`로 보내며
  선택적 prompt caption을 붙인다.

수치와 소유자는 [CONFIGURATION](../CONFIGURATION.md#코드에-고정된-제한)을 따른다.
회귀 검사는 `tests/telegramReplyChannel.test.ts`와 공통 `tests/messagingTurn.test.ts`다.

## 어떤 update가 봇을 향한 것인가

라우트는 인증 후 `classifyTelegramUpdate`로 분류하고 처리할 update만 dedup claim한다.
BotFather privacy mode와 관계없이 앱의 다음 판정을 적용한다.

| 입력 | 판정 |
|---|---|
| 새 message가 아님, 채널 게시물, bot 발신 | 무시 |
| 다른 bot에게 보낸 명령 | 무시 |
| `/start`·`/help`, 선택적 `@이봇` 수신자 | 모델 없이 고정 응답 |
| 유효한 sender ID가 없거나 텍스트·첨부가 모두 없음 | 실행하지 않음 |
| 개인 chat | 실행 |
| 그룹의 이 봇 mention·이 봇에 대한 reply·`/ask@이봇` 같은 미지원 명령 | 실행 |
| 나머지 그룹 메시지 | 무시 |

실행 후보는 [Studio 사용자 연결](messaging.md#호출자-인증)을 확인한 뒤 실행한다.
이 봇의 mention만 제거하고 다른 내용은 보존한다. 그룹에는 Slack식 engagement나 mute가 없다.
update claim은 Agent·현재 bot ID·`update_id`로 구분한다. ACK 뒤 유실을 자동 재실행하는
worker는 없으며 외부 도구 효과의 exactly-once를 보장하지 않는다.

### 보고서 목적지

허용한 메시지의 chat과 포럼 topic을 현재 bot ID 아래에 기록한다.
개인 chat은 메시지를 보내고 그룹·topic은 mention 또는 bot reply로 목록에 나타난다.
조회는 `lastSeenAt` 인덱스에서 최신 100개를 읽는다. token 교체 후 이전 bot의 목적지는
섞이지 않으며 Agent 삭제 시 함께 제거된다. 기록 실패는 로그에 남고 답변은 계속한다.
설정 화면은 관찰된 목적지 선택과 수동 ID 입력을 제공한다.

### 앨범

`media_group_id`는 Agent·bot별로 한 번 claim하고 실행 전에 done으로 정산한다.
캡션 없는 멤버는 ACK 후 1초 기다려 캡션 있는 멤버를 우선하지만 전달 순서·지연에 따라
다른 멤버가 먼저 이길 수 있다. 선택한 멤버의 사진만 읽고 나머지는 읽지 않았다고 경고한다.
claim 저장소 실패는 로그를 남기고 실행하므로 중복 답변이 생길 수 있다.
done claim은 보존 중 재획득하지 않으며 TTL 행 삭제에는 DB sweep이 필요하다.

## 히스토리

Bot API로 이전 메시지를 다시 읽지 않는다. `runRememberedTurn`은 실행 전
`ConversationTranscriptRepository`를 읽고 답변 후 질문·답을 기록한다.
최근 50턴·합계 100,000자 안에서 오래된 순서로 전달하고 생략과 읽기 실패를 warning으로 알린다.
쓰기 실패는 로그로 확인한다. 한 턴은 최대 20,000자를 기록하고 7일 뒤 만료한다.
한도는 `transcriptHistory.ts`, 만료·cascade는 공통 transcript 저장소가 소유한다.

질문은 Telegram의 `date`, 답은 그보다 1ms 뒤로 기록한다. 파일만 보낸 질문은 첨부 이름을,
텍스트 없는 답은 전달한 이미지·파일 또는 `[no answer]`를 기록한다.
추출한 문서 텍스트는 파일 경계와 질문을 함께 남기지만 과거 이미지 bytes는 보관하지 않는다.

conversation은 `telegram:{chatId}`, 포럼 topic은 `telegram:{chatId}:{threadId}`다.
`is_topic_message`와 `chat.is_forum`이 모두 참일 때만 thread ID를 topic으로 사용한다.
일반 그룹의 reply chain은 그룹 conversation을 공유한다. 같은 키를 MCP에도 전달한다.

`callerContext`를 켠 Agent만 화자 표시 이름을 모델에 전달하고 기록·복원한다.
그룹의 사람이 둘 이상이면 현재 질문과 과거 사람 턴에 이름을 붙인다.
플랫폼 actor는 Telegram 사용자 ID를 보존한다. 실행 권한과 파일 귀속은
[연결한 Studio 사용자](messaging.md#호출자-인증)의 현재 계정을 따른다.

## 첨부

사진은 여러 크기 중 이미지 상한에 맞는 가장 큰 파일을 선택한다. 모두 초과하면
가장 작은 파일을 크기 검사에 넘겨 누락 이유를 알린다. document는 타입·이름으로 판정해
공통 추출기로 읽는다. 정지 sticker는 WebP 이미지이며 음성·오디오·비디오·애니메이션·
비디오 note·움직이는 sticker는 읽을 수 없는 첨부로 보고한다.

다운로드는 `getFile`과 파일 호스트 조회 두 단계이며 선언된 크기와 실제 bytes를 제한한다.
URL에 bot token이 포함되므로 전송 오류·API 설명에서 token을 제거하고 URL을 로그에 남기지 않는다.
원본 보관·생성 파일 참조는 [문서 설계](documents.md#채널-간-파일-참조)를 따른다.

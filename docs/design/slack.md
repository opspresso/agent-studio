# Slack

agent Project마다 Slack bot과 signing secret을 연결한다.
`/api/slack/events/[project]`는 해당 프로젝트의 이벤트만 받으며 발행된 Version을 실행한다.
인증·설정 API는 [API](../API.md#레지스트리연동-오퍼레이션),
공통 실행·첨부·종료는 [메시징 파이프라인](messaging.md)이 소유한다.

## 답변과 진행 표시

`application/slack/replyStream.ts`는 native stream을 우선하고 지원되지 않는 경우
`chat.postMessage`·`chat.update`로 답변을 편집한다.
텍스트는 성공적으로 전송한 위치까지만 소비한 것으로 기록해 실패한 append를 잃지 않는다.

| 표면 | 텍스트 | 진행 표시 |
|---|---|---|
| assistant DM | `markdown_text` stream | `assistant.threads.setStatus` |
| 채널 thread | `markdown_text` chunk | 같은 stream의 `task_update` timeline |
| stream 불가 | 길이를 제한한 메시지 편집·분할 | 중간 상태 표시와 텍스트 노트 |

채널은 처음부터 chunks 모드로 열고 DM은 text 모드를 유지한다.
한 stream에서 두 모드를 섞거나 한 요청에 둘 다 보내지 않는다.
채널 stream에는 recipient user/team을 명시하며 DM에는 추가하지 않는다.

stream append와 편집에는 각각 pacing이 있고, 상태 heartbeat는 chunk가 오지 않아도 갱신한다.
긴 답변은 `messageCut.ts`의 문단·줄·문장·공백 경계로 나누고 코드 펜스를 이어 준다.
편집의 `msg_too_long`은 조각 상한을 줄여 다시 배치한다.
넘친 메시지에서는 로딩 표시를 제거하며 마지막 쓰기가 실패하면 아직 전달하지 못한 꼬리만 보낸다.
수치와 소유 파일은 [CONFIGURATION](../CONFIGURATION.md#코드에-고정된-제한)을 따른다.

채널의 진행 행은 도구별로 묶는다. 반복 호출은 횟수로, 자식 작업은 부모의 위임 도구 행으로 표시한다.
호출 ID와 결과가 완료 경계이며 status 문구가 바뀌었다는 이유로 체크하지 않는다.
DM의 상태 줄은 자식의 진행도 표시한다. 종료 시 남은 진행 행과 텍스트를 닫고,
텍스트 없이 그림·파일만 전달한 경우 중간 캡션 메시지를 회수한다.

답변은 새 알림 권한을 얻지 않는다. 모델·도구·경고의 mention token은 Web API 전송 직전에
`neutralizeSlackMentions`로 escape한다. stream·편집·최종 fallback에 같은 규칙을 적용한다.
링크·채널 참조·알림 없는 date token은 유지한다.
[보안 계약](../SECURITY.md#slack-출력-알림)을 보라.

## 어떤 이벤트가 봇에게 온 것인가

`classifySlackEvent`는 라우트가 dedup claim을 쓰기 전에 이벤트를 분류한다.
설정과 서명을 확인한 뒤 무관한 메시지에 런이나 claim을 만들지 않는다.

| 입력 | 판정 |
|---|---|
| Messages 탭의 `app_home_opened`, `assistant_thread_started` | thread-start 처리; 모델 실행 없이 제안 프롬프트·소개 |
| 봇 자신의 메시지, 지원하지 않는 subtype | 무시 |
| `app_mention` | 실행 |
| 사람의 DM | 실행 |
| 채널 mention의 `message` 사본 | `app_mention`과 중복되므로 무시 |
| 사람의 thread 답글 | 참여 기록을 조회해 실행 여부 결정 |
| 다른 앱의 thread 답글·DM | 상호 bot loop를 막기 위해 무시 |
| thread가 아닌 채널 메시지 | 프로젝트 키워드가 맞으면 실행; 다른 앱의 알림도 가능 |
| 나머지 | 무시 |

자기 메시지는 envelope의 `authorizations.user_id`로 판정한다.
이 정보가 없으면 `bot_id`가 있는 앱 메시지를 보수적으로 무시한다.
지원 subtype은 파일 공유와 bot 메시지다.

키워드는 대소문자 없는 부분 문자열이며 `slackMessageText`가 text·attachment·prose block을
합친 내용을 사용한다. thread 답글은 키워드 재판정 대신 참여 상태를 따른다.
참여 기록은 실제 답변 이후 갱신되며 DM에는 필요 없다.

전달은 `event_id`의 claim·settle로 중복을 억제한다.
실패·만료 lease는 재전달 시 다시 받을 수 있지만 ACK 후 유실을 스스로 재실행하는 worker는 없다.
외부 도구 효과까지 exactly-once를 보장하지 않는다.
[공통 인증·중복 계약](../SECURITY.md#머신-호출자의-요청-인증)을 따른다.

## 명령, 그리고 멈추라는 말을 들었을 때

`!help`·`!mute`·`!unmute`는 단독 명령일 때 모델 없이 처리한다.
`!mute this thread please`는 명령으로 추측하지 않는다.
mute는 thread 참여를 비활성화하고 직접 mention 이후 답변은 참여를 다시 켠다.
최상위 메시지의 mute에는 사용 위치를, DM에는 DM 동작을 안내한다.

명령은 실행 Version 조회 전에 처리하지만 private 프로젝트의 접근 검사는 유지한다.
프로젝트 정보를 읽지 못하면 명령도 권한을 열지 않는다.

## private project 는 묻는 사람을 이메일로 확인한다

`slackSenderMayAccess`는 Slack profile의 email을 프로젝트 소유자·초대 목록·관리자 판정에 사용한다.
확인할 이메일이 없거나 접근이 없으면 거절하며 런·명령·thread-start 모두 같은 경계를 지난다.
모델용 caller 블록에는 이메일을 넣지 않는다.

사용자 없이 bot이 보낸 앱 알림은 소유자가 설정한 키워드 자동화로 처리한다.
private 프로젝트 접근은 접수 리액션·상태 표시 전에 검사한다.
이메일 조회는 `callerContext`가 꺼져 있어도 접근 판정·파일 귀속에 필요할 수 있다.
[SECURITY](../SECURITY.md#인가-모델)가 메신저별 권한 차이를 설명한다.

## 접수했다고 말하기

허용된 채널 실행은 시작 메시지에 eyes 리액션을 붙이고 DM은 상태 줄을 사용한다.
접수 표시 실패는 실행을 실패시키거나 손실 warning을 만들지 않는다.

제안 프롬프트는 프로젝트 설정으로 관리하고 manifest와 런타임의
`assistant.threads.setSuggestedPrompts`에 반영한다.
`assistant_thread_started`에는 소개도 보내며 방문마다 오는 `app_home_opened`에는 반복 소개를 하지 않는다.
생성 manifest에 필요한 구독·scope가 추가되면 설치된 Slack 앱에도 다시 적용해야 한다.
`app_context_changed`는 구독하지 않는다.

## 대화 문맥과 첨부

thread의 최근 턴을 읽으며 자기 bot의 메시지만 assistant, 다른 앱의 알림은 user 문맥으로 처리한다.
`slackMessageText`는 키워드 판정·현재 입력·히스토리에서 같은 내용을 추출한다.

`callerContext`를 켠 Version은 확인한 표시 이름·시간대·아바타 URL을 전달한다.
여러 사람이 있는 thread에는 최신 턴을 포함한 화자 라벨을 붙이고 다른 앱은 항상 앱 이름으로 구분한다.
프로필 조회는 상태 표시 이후 살아남은 history 범위에 대해 제한된 동시성으로 수행하고,
workspace별 한정된 캐시를 사용한다. actor는 Slack 사용자 ID로 유지한다.

현재 첨부를 먼저 읽고 남은 예산으로 최근 사람 메시지의 이미지·문서를 읽는다.
bot 자신의 이미지 업로드는 다시 입력으로 읽지 않는다.
현재·과거 문서는 같은 런의 개수·추출문 예산을 공유하고 생략을 경고한다.

Slack 파일 token은 허용된 HTTPS Slack file host에만 붙인다.
선언된 크기뿐 아니라 다운로드하는 bytes도 제한한다.
문서 원본 보관과 대화·actor별 생성 파일 참조는 [문서 설계](documents.md#채널-간-파일-참조)를 따른다.

## 워크스페이스 읽기

`parameters.slackWorkspace`가 다음 여섯 read-only 도구를 켠다.

| 도구 | 읽는 것 |
|---|---|
| `SlackHistory` / `SlackThread` | 채널 메시지 / thread |
| `SlackUser` / `SlackUsers` | 사용자 profile / 제한된 사용자 검색 |
| `SlackChannels` | 참가 채널 목록 |
| `SlackReactions` | 메시지의 reaction과 사용자 |

reader는 프로젝트 bot token에 묶여 있으며 모델이 다른 workspace나 credential을 선택하지 못한다.
사용자 profile의 이메일은 도구 결과에서 제외한다. 검색·프로필 해석·출력에는 각각 한도가 있고
잘린 결과를 알린다. capability를 켜면 해당 프로젝트 실행자가 bot이 읽을 수 있는 채널에
접근할 수 있으므로 [읽기 권한 경계](../SECURITY.md#slack-워크스페이스-읽기)를 확인하라.

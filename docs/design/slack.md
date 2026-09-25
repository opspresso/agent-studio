# Slack

Agent마다 Slack bot과 signing secret을 연결한다.
`/api/slack/events/[agent]`는 해당 Agent의 이벤트만 받으며 현재 Agent 설정을 실행한다.
인증·설정 API는 [API](../API.md#레지스트리연동-오퍼레이션),
공통 실행·첨부·종료는 [메시징 파이프라인](messaging.md)이 소유한다.

## 앱 매니페스트

`buildAgentSlackManifest`는 Agent별 앱 설정을 생성한다.
[Slack Agent messaging](https://docs.slack.dev/ai/migrating-to-agent-messaging/)에 맞춰
`agent_view`와 입력 가능한 Messages 탭을 사용하며, 별도 뷰를 게시하지 않는 Home 탭은 끈다.
Agent 설명은 앱의 짧은 설명과 Agent 소개에 쓰고, 비어 있으면 Agent 이름으로 만든다.
두 설명의 [Slack 길이 한도](https://docs.slack.dev/reference/app-manifest/)는 `domain/slack/types.ts`가 소유한다.

이벤트는 서명 검증을 거치는 HTTP Request URL로 받으므로 Socket Mode는 끈다.
Interactivity payload 처리기와 토큰 갱신 흐름이 없어 해당 설정도 끈다.
`org_deploy_enabled`는 생성 매니페스트에서 생략하고 Slack 앱 설정에서 관리한다.
이미 조직 배포를 켠 앱은 다시 끌 수 있으리라 가정하지 않으며, 재적용할 매니페스트의
`settings.org_deploy_enabled`에 기존 `true`를 명시적으로 유지한다.
필드 생략을 기존 값의 자동 보존으로 취급하지 않는다. 앱의 연동은 Agent별
워크스페이스 봇 토큰을 사용하며, 이 설정만으로 조직 단위 설치 흐름을 제공하지 않는다.
봇 권한은 메시지·파일·리액션·채널 조회·사용자 확인에 사용한다. 채널 자동 가입,
이모지 목록 조회와 사용자 custom profile 조회 권한은 요청하지 않는다.
사용자 확인에는 `users:read`와 `users:read.email`을 사용하며, user token scope는 추가하지 않는다.

`is_mcp_enabled`와 MCP OAuth callback은 같은 앱을 별도 MCP 연결에 사용할 수 있도록 유지한다.
이 설정만으로 사용자 OAuth 연결이나 검색 권한이 생기지는 않는다. MCP 사용은 MCP 설정의 별도 인가를 따른다.
설치·재적용 절차와 네트워크 요구사항은 [설치 문서](../INSTALL.md#slack-연동)를 따른다.

## 답변과 진행 표시

메시지를 허용하면 이력 조회 전에 `agents.sessions.setStatus(processing)`으로 작업 시작을 표시한다.
DM과 채널 모두 세션을 만들며, `title`·`initiator_user_id`는 Slack이 세션 생성 시에만 적용한다.
이후 질문이나 이력 조회 실패가 사용자가 바꾼 제목을 덮어쓰지 않는다.
답변 마감·실패·중단 뒤에는 `active`로 돌아간다.
[Slack 세션 계약](https://docs.slack.dev/ai/agent-sessions/)을 따른다.

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
DM의 세부 진행 문구는 `assistant.threads.setStatus`의 호환 경로를 사용한다.
상태 줄은 자식의 진행도 표시한다. 도구의 `Error:` 결과는 공통 `isToolErrorText`로 판정하며,
같은 도구 행에 성공·실패가 섞이면 실패를 유지한다. 실행 실패·중단 시 미완료 행은 성공으로 표시하지 않는다.
종료 시 남은 진행 행과 텍스트를 닫고,
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
| `agent_session_stopped` | 서명·사용자·타임스탬프 검증 후 중단 기록; 모델 실행 없음 |
| 봇 자신의 메시지, 지원하지 않는 subtype | 무시 |
| `app_mention` | 실행 |
| 사람의 DM | 실행 |
| 채널 mention의 `message` 사본 | `app_mention`과 중복되므로 무시 |
| 사람의 thread 답글 | 참여 기록을 조회해 실행 여부 결정 |
| 다른 앱의 thread 답글·DM | 상호 bot loop를 막기 위해 무시 |
| thread가 아닌 채널 메시지 | Agent 키워드가 맞으면 실행; 다른 앱의 알림도 가능 |
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

`!help`·`!stop`·`!mute`·`!unmute`는 단독 명령일 때 모델 없이 처리한다.
`!mute this thread please`는 명령으로 추측하지 않는다.
mute는 thread 참여를 비활성화하고 직접 mention 이후 답변은 참여를 다시 켠다.
최상위 메시지의 mute에는 사용 위치를, DM에는 DM 동작을 안내한다.

명령은 현재 설정 조회 전에 처리하지만 private Agent의 접근 검사는 유지한다.
Agent 정보를 읽지 못하면 명령도 권한을 열지 않는다.

`agent_session_stopped` 구독으로 Slack 기본 중단 버튼을 제공한다. `!stop`은 DM·채널의
대상 thread 안에서 보낸다. 첫 답변 전에 참여 기록이 없어도 사람의 `!stop`은 접수하며,
private Agent의 접근 판정은 중단에도 적용한다.

`SlackRunControlRepository`는 Agent·채널·thread별 최신 중단 시각을 DB에 원자적으로 기록한다.
같은 thread는 갱신 가능한 실행 lease로 한 번에 하나의 요청만 실행한다. 실행 중 추가 요청에는
대기 또는 `!stop` 사용을 안내한다. lease는 상태 정리까지 보유하고 소유 token으로 갱신·해제한다.
프로세스가 종료되면 lease가 만료되며, 소유권을 잃은 실행은 새 답변이나 상태 정리를 쓰지 않는다.
실행 서버는 `watchSlackStop`으로 이를 확인하므로 중단 이벤트와 실행이 다른 replica에 도착해도
같은 요청을 본다. 중단 이전 메시지만 취소하며 늦거나 순서가 뒤바뀐 중단 이벤트가 이후 질문을
취소하지 않는다. 지연 접수된 메시지도 모델 실행 전에 검사한다. 조회 실패 시 확인할 수 없는
실행을 계속하지 않고 이유를 알린다. 기록은 만료되며 Agent 삭제 fence·cascade를 따른다.
모델 호출 전과 이미지·파일·최종 응답 전송 전에도 중단 상태를 갱신한다. 진행 중인 조회가 있으면
같은 완료를 기다려 다음 정기 확인 전에 끝나는 짧은 실행도 이미 기록된 중단을 반영한다.

중단 signal은 공통 실행의 deadline과 합쳐 모델·도구에 전달한다. 이미 보인 답은 남기고,
중단 뒤 대기 중이던 이미지·파일 링크 전송은 생략한다. Slack이 먼저 stream을 닫았어도 미전송
텍스트를 일반 응답 fallback으로 재전송하지 않는다. 편집·미개봉 경로도 이미 전달된 텍스트와
중단 안내만 남긴다. 이미 실행된 외부 도구의 효과는 되돌리지 않는다.
진행 중인 준비 I/O는 각 호출의 timeout·취소 지원 범위를 따르며, 이후 모델 실행은 중단된다.

## private agent 는 묻는 사람을 이메일로 확인한다

`slackSenderMayAccess`는 Slack profile의 email을 Agent 소유자·초대 목록·관리자 판정에 사용한다.
확인할 이메일이 없거나 접근이 없으면 거절하며 런·명령·thread-start 모두 같은 경계를 지난다.
모델용 caller 블록에는 이메일을 넣지 않는다.

사용자 없이 bot이 보낸 앱 알림은 소유자가 설정한 키워드 자동화로 처리한다.
private Agent 접근은 접수 리액션·상태 표시 전에 검사한다.
이메일 조회는 `callerContext`가 꺼져 있어도 접근 판정·파일 귀속에 필요할 수 있다.
[SECURITY](../SECURITY.md#인가-모델)가 메신저별 권한 차이를 설명한다.

## 접수했다고 말하기

허용된 채널 실행은 시작 메시지에 eyes 리액션을 붙이고 DM은 상태 줄을 사용한다.
접수 표시 실패는 실행을 실패시키거나 손실 warning을 만들지 않는다.

제안 프롬프트는 Agent 설정으로 관리하고 manifest와 런타임의
`assistant.threads.setSuggestedPrompts`에 반영한다.
`assistant_thread_started`에는 소개도 보내며 방문마다 오는 `app_home_opened`에는 반복 소개를 하지 않는다.
생성 manifest에 필요한 구독·scope가 추가되면 설치된 Slack 앱에도 다시 적용해야 한다.
`app_context_changed`는 구독하지 않는다.

## 대화 문맥과 첨부

thread의 최근 턴을 읽으며 자기 bot의 메시지만 assistant, 다른 앱의 알림은 user 문맥으로 처리한다.
`slackMessageText`는 키워드 판정·현재 입력·히스토리에서 같은 내용을 추출한다.
`slackInputText`는 자기 봇 멘션만 제거하고 다른 사용자·채널 참조를 보존한다.
현재 메시지보다 앞선 타임스탬프만 이력으로 읽어 지연 처리 중 도착한 미래 질문·답변을 섞지 않는다.
최근 이력 상한으로 이전 턴을 생략하면 사용자에게 알린다.

`callerContext`를 켠 Agent는 확인한 표시 이름·시간대·아바타 URL을 전달한다.
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

reader는 Agent bot token에 묶여 있으며 모델이 다른 workspace나 credential을 선택하지 못한다.
사용자 profile의 이메일은 도구 결과에서 제외한다. 검색·프로필 해석·출력에는 각각 한도가 있고
잘린 결과를 알린다. capability를 켜면 해당 Agent 실행자가 bot이 읽을 수 있는 채널에
접근할 수 있으므로 [읽기 권한 경계](../SECURITY.md#slack-워크스페이스-읽기)를 확인하라.

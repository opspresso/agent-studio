# Microsoft Teams

Agent별 Microsoft App ID·client secret과 선택적 tenant ID를 저장한다.
앱은 Azure Bot 등록이나 endpoint 변경을 수행하지 않는다. 운영자가 Teams 채널을 연결하고
messaging endpoint를 `/api/teams/messages/[agent]`로 지정한다.
설정·응답은 [API](../API.md#레지스트리연동-오퍼레이션), 요청 인증은
[SECURITY](../SECURITY.md#머신-호출자의-요청-인증), 공통 실행은 [메시징 파이프라인](messaging.md)을 따른다.

## 전달 인증

`agentTeams.ts`는 App ID·tenant ID를 GUID로 검증해 소문자로 저장한다.
masked·빈 client secret은 기존 값을 유지한다. 저장은 Microsoft를 호출하지 않으며
연결 테스트는 저장된 credential로 app token을 받아 확인한다.

`infrastructure/teams/client.ts`의 `verifyRequest`는 다음을 검사한다.

| 경계 | 검사 |
|---|---|
| 서명 | RS256, Bot Framework discovery가 제공한 JWKS의 키 |
| issuer·audience | `https://api.botframework.com`, 이 봇의 App ID(GUID 대소문자 무관) |
| 시간 | 유한한 exp와 선택적 nbf, 5분 skew |
| 답변 주소 | token의 serviceurl과 activity의 serviceUrl 정규화 값이 같아야 함 |

Emulator token은 받지 않는다. 서명 키는 하루 캐시하며 조회 시도는 실패해도 최소 1분 간격으로
제한한다. 동시 호출은 같은 조회를 기다리며 metadata HTTP 실패와 만료된 캐시 키는 인증에 쓰지 않는다.

app token은 지정한 tenant 또는 기본 `botframework.com` tenant에서 받는다.
캐시는 App ID·tenant·secret hash로 구분하고 만료 1분 전에 폐기한다.
credential을 교체하면 이전 token으로 연결 테스트를 성공 처리하지 않는다.

## 답을 전달하기

`replyChannel.ts`는 공통 `createEditInPlaceReply`에 activity 전송·갱신과 한도를 연결한다.
답은 `textFormat: markdown`으로 보내고 진행 상태는 typing activity로 표시한다.

- 편집은 2초, typing 갱신은 3초 간격이다. 마지막 쓰기에서 커서를 제거한다.
- 텍스트는 20,000 code unit 안에서 나누고 첫 activity만 질문을 인용한다.
  열린 코드 펜스는 파일 링크·warning을 붙이기 전에 닫는다.
- 이미지는 data URI 첨부로 보내며 1MiB를 초과하면 전송하지 않고 warning을 남긴다.
- 마감 실패는 아직 전송하지 못한 꼬리만 별도 게시한다. 지속적인 API 장애에서
  답변 전달 완료를 보장하지 않는다.

전송 응답은 JSON과 비어 있지 않은 문자열 activity ID를 검증한다.
[REST 전송 응답](https://learn.microsoft.com/en-us/azure/bot-service/rest-api/bot-framework-rest-connector-api-reference#send-to-conversation)이
잘못되면 빈 ID로 성공 처리하거나 후속 편집 주소를 만들지 않고 오류를 전달한다.
수치와 소유자는 [CONFIGURATION](../CONFIGURATION.md#코드에-고정된-제한)을 따른다.

## 어떤 activity가 봇을 향한 것인가

라우트는 인증 후 `classifyTeamsActivity`로 판정하고 처리할 activity만 dedup claim한다.

| 입력 | 판정 |
|---|---|
| message가 아님, 봇 자신의 메시지 | 무시 |
| sender·conversation·serviceUrl이 없거나 텍스트·실제 첨부가 모두 없음 | 실행하지 않음 |
| 개인 chat | 실행 |
| 이 봇 mention이 있는 채널·그룹 메시지 | 실행 |
| 나머지 | 무시 |

이 봇을 가리키는 mention entity의 철자만 제거하고 다른 텍스트는 보존한다.
메시지의 HTML 사본인 text/html 첨부는 별도 파일로 읽지 않는다.
claim은 Agent·App ID·conversation ID·activity ID로 구분한다.
ACK 후 유실을 자동 재실행하지 않으며 외부 효과의 exactly-once를 보장하지 않는다.

## 히스토리

앱은 Bot Framework에서 과거 activity를 조회하지 않는다. `runRememberedTurn`이 Telegram과
같은 [transcript 계약](telegram.md#히스토리)으로 질문·답과 파일만 전달한 턴을 기록한다.
읽기 실패·문맥 생략은 warning, 기록 실패는 로그로 확인한다.

conversation은 `teams:{conversation.id}`다. actor와 화자 식별은 aadObjectId를 우선하고
없으면 from.id를 사용한다. tenant ID도 필수이며
[연결한 Studio 사용자](messaging.md#호출자-인증)의 현재 계정·Agent 접근 권한을 확인한다.
`callerContext`를 켠 Agent만 activity의 표시 이름을 모델·transcript에 제공한다.
여러 화자가 있으면 현재 질문과 과거 사람 턴에 라벨을 붙인다.

## 첨부

붙여 넣은 그림은 image/*의 contentUrl을 사용하고 bytes로 실제 형식을 판정한다.
개인 chat의 공유 파일은 file.download.info의 downloadUrl·이름·타입을 사용한다.
다른 형식도 이름을 남겨 읽을 수 없는 첨부임을 보고한다.

bot token은 검증된 conversation의 HTTPS service origin에만 붙인다.
다른 주소는 token 없이 fetchPublicUrl의 SSRF·redirect 검사를 통과하며 다운로드 bytes를 제한한다.
원본 보관·출력 파일 참조는 [문서 설계](documents.md#채널-간-파일-참조)를 따른다.
회귀 검사는 tests/teamsClient.test.ts·tests/teamsReplyChannel.test.ts와 공통 메시징 검사다.

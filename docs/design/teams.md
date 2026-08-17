# Microsoft Teams

공유 [메시징 파이프라인](messaging.md) 위에 얹은 프로젝트별 봇: Bot Framework 가 어떻게
인증되는지, 스트리밍이 없는 곳에서 답이 어떻게 전달되는지, 봇이 받는 activity 중 어느 것이
봇을 향한 것인지, 그리고 히스토리를 돌려주지 않는 플랫폼에서 후속 질문이 맥락을 어떻게
나르는지 — Telegram 과 같은 질문에, Teams 의 답으로.

설정 엔드포인트와 messaging 엔드포인트가 무엇으로 답하는지는
[API.md](../API.md#레지스트리연동-오퍼레이션) 에, 토큰이 어떻게 검증되는지는
[SECURITY.md](../SECURITY.md#머신-호출자의-요청-인증) 에 있다.

봇은 **프로젝트별**이다: 운영자가 Azure Bot(Bot Framework) 을 등록하고 Teams 채널을 켠 뒤,
그 **Microsoft App ID** 와 **클라이언트 시크릿**을 프로젝트의 연동 탭에 붙여 넣고, Azure 에서
봇의 messaging endpoint 를 `/api/teams/messages/[project]` 로 가리킨다. Telegram 과 달리
이 플랫폼이 발급하는 것도 등록하는 것도 없다 — Azure 에는 endpoint 를 가리키는 호출이
없어서 콘솔은 주소를 보여 주고 운영자가 붙여 넣는다. *연결 테스트*는 저장된 자격 증명으로
토큰을 받아 보는 것이고, 그것이 한 쌍이 동작한다는 증거다.

## 인증 — 토큰이 전부다

Bot Framework 는 배달마다 자기가 서명한 bearer 토큰을 실어 보내고, 그 검증이 endpoint 가
믿는 것의 전부다 (`src/infrastructure/teams/client.ts` 의 `verifyRequest`): RS256 이어야
하고, 서명 키는 서비스가 공개한 것(`login.botframework.com` 의 OpenID 구성 → JWKS, 하루
캐시하되 모르는 `kid` 는 다시 가져온다 — 서비스는 키를 돌린다) 이어야 하며, 발급자는
`https://api.botframework.com`, 대상(audience)은 이 봇의 App ID, `exp`/`nbf` 는 5분 skew
안에서 유효해야 하고, **`serviceurl` 클레임이 activity 가 말하는 `serviceUrl` 과 같아야
한다.** 마지막 조건이 요점이다: 답은 activity 의 `serviceUrl` 로 — 이 앱의 토큰을 붙여서 —
나가므로, 어느 대화에서 가로챈 토큰이 다른 주소를 보증하게 두면 이 앱의 토큰이 그 주소로
간다. Emulator 는 다른 키로 서명하므로 받지 않는다: 이 endpoint 는 실제 서비스에 답한다.

바깥으로 나가는 호출은 App ID·시크릿을 Microsoft identity platform 에 내고 받은 토큰을
쓴다(멀티테넌트 앱은 `botframework.com` 테넌트, 단일 테넌트 앱은 자기 테넌트; 만료 1분
전까지 캐시). 실패는 Microsoft 의 설명(`AADSTS…`)을 그대로 이름 붙이고 시크릿은 절대
싣지 않는다.

## 답을 전달하기

Bot Framework 에도 스트리밍 호출은 없다: 답은 대화에 보낸 activity 를 제자리에서 갱신하는
것이고, 진행 상황은 Teams 가 몇 초 보여 주는 `typing` activity 다. 그래서 이것은 Telegram 과
공유하는 edit-in-place 기계(`src/application/messaging/editInPlaceReply.ts` — 페이싱, 넘칠 때
다음 메시지로 잇기, 거부된 쓰기의 재시도 간격, 마감이 독자에게 빚진 것)에 Teams 의 호출과
상한을 알려 준 것이다 (`src/application/teams/replyChannel.ts`). Teams 자신의 것은 둘이다.
봇에게 **Markdown 을 네이티브로 렌더**하므로(`textFormat: "markdown"`) 답은 모델이 쓴
그대로 나가고 마감에서 렌더하는 것이 없다 — 거부될 HTML 이 없다. 그리고 그림은 별도
업로드가 아니라 **메시지 안에**, Teams 가 inline 으로 그리는 `data:` URI 첨부로 간다 (몇 MB
까지; 그 위는 경고로 말한다). 메시지 하나는 20,000자에서 끊어 다음 메시지로 잇는다 — Teams
가 받는 28KB 언저리 아래에서 Markdown 과 첨부에 여유를 둔 값이고, 그만큼 긴 답은 어차피
둘로 나뉘는 편이 읽기 좋다.

## 어떤 activity 가 봇을 향한 것인가

함수 하나, `classifyTeamsActivity` (`src/application/teams/engagement.ts`), 그리고 **dedup
claim 보다 앞서 라우트에서 실행된다** — Slack·Telegram 과 같은 비용 계약이다.

판단의 대부분은 Teams 가 한다. 채널이나 그룹 채팅의 봇은 (이 플랫폼이 요청하지 않는
resource-specific consent 없이는) 자기를 @멘션한 메시지만 받고, 개인 채팅은 전부를 보낸다.
그래서 깔때기는 짧다:

1. **메시지가 아님** — 멤버 추가, 리액션, 설치 — 아무것도 하지 않는다;
2. **봇 자신의 메시지** — 아무것도 하지 않는다. 자기 자신에게 답하는 런은 멈추는 법이 없다;
3. **개인 채팅** — 그 안의 모든 메시지는 봇을 향한 것이다;
4. **봇을 멘션한 채널·그룹 메시지** — 답한다. 텍스트에서 `<at>…</at>` 구간만 빼고 — Teams
   가 entity 로 표시한 그 철자만이며, 사람이 친 `<at>` 이 아니다 — 나머지 줄바꿈은 그대로;
5. 그 밖에는 아무것도 하지 않는다.

Teams 는 메시지의 HTML 렌더링을 `text/html` 첨부로도 함께 보내는데, 그것은 텍스트를 다시
보낸 것이지 첨부가 아니다. 텍스트도 (진짜) 첨부도 없는 메시지는 무시한다.

## 히스토리

Bot Framework 도 봇에게 각 activity 를 한 번 주고 히스토리는 주지 않는다. 그래서 Telegram 과
같은 `ConversationTranscriptRepository` 를 같은 규칙으로 쓴다
([telegram.md#히스토리](telegram.md#히스토리) — 최신 50턴·100,000자 예산, 텍스트 없는 턴은
그것이 실은 것으로 기록, 이름은 `callerContext` 옵트인 버전만 쓰고 읽음). 도우미는
`src/application/messaging/transcriptHistory.ts` 하나다.

**conversation** 은 Teams 가 부르는 그것이다: `teams:{conversation.id}`. Teams 가 이미 이
플랫폼이 원하는 선을 긋는다 — 개인 채팅은 존재하는 내내 id 하나, 채널 *스레드*는 채널 id 에
`;messageid=…` 가 붙은 자기 id(스레드 안의 답장은 그 대화를 잇고 채널의 새 글은 새 대화를
연다), 그룹 채팅은 그 안의 모두에게 하나. 아무것도 유도할 필요가 없고 `conversationOf` 가 id
를 안전하게 나른다.

**누가 묻고 있는지**는 버전이 옵트인했을 때만, activity 가 나르는 만큼만: 보낸 사람의 표시
이름이다(`callerFrom` 이 프롬프트에 안전하게 만든다). Teams 는 봇에게 email 을 주지 않으므로
Teams 런은 artifact 를 project 만으로 분류한다. actor 는 사람의 Entra(Azure AD) object id 다 —
대화마다 달라지는 `from.id` 와 달리 사람을 가로질러 같다.

## 첨부

바이트를 나르는 모양은 둘이다. 메시지에 붙여 넣은 그림은 `contentUrl` 이 대화의 서비스
호스트에 있는 `image/*` 첨부이고 봇의 토큰이 필요하다; 개인 채팅에서 공유한 파일은
사전 인증된 `downloadUrl` 과 파일 이름·타입을 실은 `file.download.info` 봉투다. **봇의
토큰은 대화의 서비스 호스트로만 간다** — 첨부 주소는 activity 가 실어 온 신뢰할 수 없는
입력이고, 그것이 이름 댄 호스트에 토큰을 보내는 것은 이름 댄 쪽에 토큰을 건네는 것이다.
그 밖의 첨부는 이름을 붙여 파이프라인이 "읽을 수 없는 첨부"로 보고하게 한다.

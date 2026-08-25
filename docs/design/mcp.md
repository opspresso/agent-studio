# MCP

레지스트리 항목, 프로토콜을 소유하는 세션, 런이 서버에게 자기 자신에 대해 알리는 것,
그리고 항목을 계속 도달 가능하게 유지하는 세 가지: discovery 캐시, 루프백 위의 managed
컨테이너, 그리고 project 별 OAuth.

보안 쪽 절반 — SSRF 가드, 루프백 예외, 모든 OAuth 검사, 그리고 서버가 호출자에 대해 알 수
있는 것 — 은 [SECURITY.md](../SECURITY.md#mcp-oauth) 다. 조절값(knob)은
[CONFIGURATION.md](../CONFIGURATION.md#mcp) 다.

```ts
McpServer { name, url, description?, content?, source?, runtime?: 'remote' | 'managed',
            headers: Record<string, string>,   // 저장 시 암호화, 읽을 때 마스킹
            auth?,
            // managed 전용; `environment` 는 `headers` 처럼 저장 시 암호화
            image?, args?, endpointPath?, containerPort?, environment?, envRefs?,
            createdAt, updatedAt }
```

`description` 은 한 줄 요약이며 **모델이 보는 유일한 필드**다 — 시스템 프롬프트의 서버
표에서 한 행이 된다. `content` 는 콘솔에만 표시되는 마크다운 운영자 노트다; Skill 의
content 와 달리 모델에는 결코 닿지 않는다. description 은 표로 렌더링될 때 이스케이프되므로,
여러 줄로 된 레거시 값이 표를 깨뜨릴 수 없다.

레지스트리 항목은 plugins sync 를 통해서도 들어온다: Plugin 의 `mcp.json` 이 자기 서버들을
선언하고, `type: "streamable-http"` 항목만 바인딩된다 — `stdio` 는 저장소가 제공한 명령을
호스트에서 실행한다는 뜻이므로, 보고하고 건너뛸 뿐 절대 실행하지 않는다
(`src/domain/plugin/types.ts` 의 `classifyMcpJsonServer` 가 유일한 transport 결정이다).
닫힌 mcp.json 스키마에는 description 필드가 없으므로, 각 서버의 모델용 description 과 운영자
노트는 Plugin 의 `org.opspresso.agent-studio/mcp/<server>.md` 확장 문서에 실려 온다 — 스펙이
정의하는 역도메인(reverse-domain) 클라이언트 확장 관례다. 여기서 걸린 것은 Skill 때보다
크다: 항목은 암호화된 헤더와 발견된 OAuth 블록도 함께 들고 있으므로, mcp.json 에 선언된
헤더는 절대 임포트되지 않고(버려진 이름은 보고된다), 호출자가 이름을 지정한 덮어쓰기조차
문서가 소유한 필드만 교체하며, 각 URL 은 직접 입력된 URL 과 똑같은 아웃바운드 가드를 거친다
— 거부는 실패한 sync 가 아니라 건너뜀이다.

Agent 런은 시스템 프롬프트에 **"Connected MCP Servers"** 표(서버 이름, description, alias
된 tool 이름)를 덧붙여, 모델이 어떤 tool 그룹이 어느 서버에 속하는지 알게 한다; 도달할 수
없거나 tool 을 노출하지 않는 서버는 생략된다.

**런이 하는 모든 요청은 자신을 호출한 project 의 이름을 밝힌다.** `X-Tenant-Id`
(`src/application/execution/mcpTools.ts` 의 `TENANT_ID_HEADER`)로 나가므로, 멀티테넌트
서버는 project 별 등록 없이도 자기 데이터를 project 단위로 스코프한다. 이 값은 헤더 병합
**이후** 에 찍힌다 — 그래서 레지스트리 항목도, 버전의 override 도 어떤 철자로든 다른
project 의 tenant 를 사칭할 수 없다 — 그리고 OAuth 가용성 검사 **이후** 이므로, 연결을 쓸 수
없는 서버를 인증하는 수단으로 이 메타데이터가 인정되는 일은 결코 없다. 뒤에 project 가 없는
호출자는 아무것도 보내지 않는다: 카탈로그 probe 와 "Test connection" 은 tenant 를 싣지
않는다. 같은 헤더 맵에 실려 가기 때문에 [discovery 캐시](#discovery-캐시) 의 키도 project
별로 나뉘고, 그래서 tenant 마다 다른 tool 을 노출해도 되는 서버는 tenant 별로 캐시된다.
**그리고 자신의 conversation 의 이름도 밝힌다.** `X-Conversation-Id`(같은 파일의
`CONVERSATION_ID_HEADER`)로, 런이 `conversationKey` 를 가진 경우 그것을 실어 보낸다 —
memory 서버가 한 스레드의 작업 노트와 project 의 공유 지식을 구분하는 데 필요한 헤더다.
tenant 처럼 예약되어 있고 병합 이후에 찍히지만, 세션의 identity 헤더가 아니라 *context*
헤더(`McpServerConfig.contextHeaders`)에 실린다. 그래서 모든 요청에 도달하면서도
**discovery 캐시 키에는 결코 들어가지 않는다**: conversation 은 서버가 어떤 tool 을
노출하는지에 대해 아무것도 결정하지 않으며, 그것으로 키를 잡으면 바뀌지도 않은 카탈로그를
위해 스레드마다 전체 discovery 비용을 치르게 된다. 전체 계약은
[SECURITY.md](../SECURITY.md#mcp-서버가-호출자에-대해-듣는-것) 에 있다.

## Transport 와 세션

Tool 로딩은 MCP streamable HTTP(`tools/list`, `tools/call` JSON-RPC)를 쓴다. 프로토콜에는
**소유자가 하나** 있다. `McpSession`(`src/infrastructure/mcp/session.ts`) 이며 — 엔진의
`ToolManager` 도, 레지스트리의 "Test connection" probe 도 그 위에서 돈다.

세션은 **`@modelcontextprotocol/client`** 위의 어댑터이고, 그 이유는 `2026-07-28`
리비전이다: 이 리비전이 `initialize` 핸드셰이크를 없앴으므로, 클라이언트는 이제 서버가 어느
era 를 구현하는지 감지해서 핸드셰이크나 요청별 `_meta` 봉투 중 하나를 말해야 한다. 모든
연결은 **`server/discover`** 로 시작한다; 여기에 답하는 서버와는 상태 없이(statelessly)
대화하고, `-32601` 로 답하는 서버에는 대신 `initialize` 핸드셰이크를 건넨다. 이 클라이언트가
모르는 리비전만 지원하는 서버는 자기가 말하는 것을 이름 붙여 `-32022` 로 답하는데,
`unusableServerReason` 은 그것을 도달 불가 호스트가 아니라 *이 클라이언트를 올려야 한다* 로
보고한다.

**대신 리비전을 고정(pin)하는 쪽도 시도했다가 되돌렸다.** 그쪽이 더 싸다 — 핸드셰이크,
세션 id, 그리고 그 둘레의 만료 복구가 전부 사라지고, 그와 함께 이중 era 클라이언트가 조용히
틀릴 수 있는 이음매도 사라진다. 대가는 아직 옮겨오지 않은 모든 서버이고, MCP 서버란 남의
릴리즈 일정 위에 놓인 남의 배포다: 이 앱이 올라갔다는 이유로 동작을 멈춘 레지스트리 항목은
그 소유자가 고칠 수 없는 실패다. 어떤 항목도 발맞춰 올릴 필요가 없도록 이 이음매를 여기에
남겨 둔다.

SDK 는 어댑터 계층의 의존성이고, 프로토콜 클라이언트가 있어야 할 자리가 거기다;
[AGENTS.md](../../AGENTS.md#dependency-direction) 의 규칙이 그것을 `application` 과 `domain`
밖에 붙들어 둔다. SDK 가 의견을 갖지 않는 것은 세션에 남으며, 아래 각각은 한 번씩 결함이었던
것들이다: SSRF 가드(transport 의 `fetch` 로 주입되므로, 운영자가 준 MCP URL 이라도 메타데이터
서비스를 지목할 수 없다), 한 응답이 메모리로 끌어올 수 있는 양의 상한, 아래의 lazy connect,
그리고 만료된 세션의 재시도 — SDK 는 이것을 구현하지 않는다.

**SDK 는 다른 모든 의존성과 마찬가지로 caret 범위(`^2.0.0`)를 따르지만, 그 동작 중 넷은
여기서 하중을 받고 있고 어느 것도 semver 로 보장되지 않는다**: `LATEST_PROTOCOL_VERSION` 이
어느 리비전을 가리키는지(2026 era 로 올라가면 핸드셰이크 폴백이 무용지물이 된다),
`mode: "auto"` 가 무엇으로 폴백하는지, `listMaxPages` 가 잘라내지 않고 throw 한다는 것,
그리고 `unusableServerReason` 이 읽는 `SdkErrorCode` 값들. 따라서 SDK 를 올리는 것은 —
lockfile 갱신을 포함해 — 그냥 통과시킬 의존성 업데이트가 아니라 저 넷을 대조해 확인해야 할
프로토콜 변경이다.

- Tool 이름 충돌은 역방향 매핑을 갖는 `_1`/`_2` 접미사 alias 를 받고, 같은 aliasing 이
  **provider** 라면 거부했을 이름도 실어 나른다: MCP 는 128자와 점을 허용하지만
  (`admin.tools.list` 는 스펙 자신의 예시다) 함수 이름은 `[A-Za-z0-9_-]{1,64}` 다. 그 tool 을
  조용히 버리는 대신, 충돌 alias 와 똑같이 이름을 규격에 맞는 것으로 정규화한다 — 서버는
  여전히 자신이 공표한 이름으로 호출된다. alias 를 만들 재료가 아무것도 없는 이름만
  거부된다. Tool
  결과는 100,000자로 제한된다.
- 서버는 init 시점에 **병렬로** 접촉한다(그렇지 않으면 도달 불가 서버 하나가 자기 타임아웃
  전체를 time-to-first-token 에 더한다). 반면 alias 할당은 설정된 순서를 지키므로 이름은
  결정적이다.
- 세션은 첫 요청 전에 등록되고, 런이 끝나면 `DELETE` 로 해제된다(`ToolManager.close()`,
  실행 파사드의 `finally` 에서 호출된다 — discovery 자체가 실패했거나 취소된 경우를 포함해서).
- **`Mcp-Session-Id` 를 실은 채 `404`** 로 답을 받은 요청은, 서버가 그 세션을 잊었고
  transport 가 새 세션을 요구한다는 뜻이다: 연결을 버리고, 새 연결 뒤에서 요청을 **한 번**
  재생한다. 재생이 안전한 이유는 404 가 세션 조회 실패이기 때문이다 — 서버는 무엇이든
  실행하기 전에 메시지를 거부했으므로, 404 를 받은 `tools/call` 에는 반복될 효과가 없었다.
  한 번으로 제한하는데, 그러지 않으면 정말로 사라진 엔드포인트에 영원히 재연결하게 된다.
  **자기 세션이 아직 현재 세션인 호출자만 그것을 버린다**: 모델의 한 응답이 자기 MCP 호출들을
  한꺼번에 보내므로 여럿이 같은 죽은 id 를 들고 있을 수 있고, 각자 차례로 리셋하면 다른
  호출자가 시작한 연결을 버리고 호출자마다 서버 쪽 세션을 하나씩 찍어내게 된다. 이것이
  없으면 서버의 세션 TTL 보다 오래 사는 런은 — 여기 런은 최대 10분까지 간다 — 남은 tool 호출을
  전부 잃고, 모델은 `HTTP 404` 를 읽으며 돌아갈 길이 없다. 이건 세션 자신의 코드다: SDK 에는
  그런 복구가 없다. 프로토콜 `2026-07-28` 은 세션을 아예 찍어내지 않으므로, modern 연결에서는
  이 재시도가 구조적으로 도달 불가이고 teardown 도 `DELETE` 를 보내지 않는다.
- 핸드셰이크 이후의 요청은 제안한 프로토콜 버전이 아니라 **서버** 가 합의한 버전을 밝힌다.
  핸드셰이크 자신은 *본문* 에서 제안한다: 헤더는 사용 중인 리비전을 이름 붙이는 것이고,
  서버가 답하기 전까지는 사용 중인 리비전이 없다. 그보다 앞선 era probe 는 이 클라이언트가
  말하는 가장 새로운 리비전을 싣는데, 그것이 바로 묻고 있는 대상이다.
- `2026-07-28` 연결에서는 모든 POST 가 자기 본문을 **`Mcp-Method`** 로, 무언가를 이름으로
  지목하는 요청은 **`Mcp-Name`** 으로, tool 이 `x-mcp-header` 로 표시한 파라미터는
  `Mcp-Param-*` (SEP-2243) 로 미러링한다. 그래야 게이트웨이나 rate limiter 가 본문을 파싱하지
  않고도 라우팅하고 계측할 수 있다. 출력 가능한 ASCII 밖의 이름은 Base64 로 인코딩되어
  이동한다(`=?base64?…?=`). **2025 era 교환에는 이 중 어느 것도 나타나지 않으며**, 그것은
  누락이 아니라 의도적이다: 스펙은 중간자에게, 서버가 검증했음을 보장하는 버전과 대조할 수
  없는 미러링 값은 거부하라고 말한다. 그러니 그런 검증을 약속한 적 없는 서버에 그 값을 보내는
  것은 안 보내는 것보다 나쁘다. 미러링은 SDK 가 소유하며, `x-mcp-header` 선언이 제약을 깨는
  tool 을 배제하는 것도 포함한다 — 잘못된 tool 하나가 나머지 전부를 잃게 두지 않기 위해서다.
  **tool 의 정의는 호출에 함께 넘긴다.** SDK 는 자기가 직접 보낸 `tools/list` 의
  `inputSchema` 에서 `Mcp-Param-*` 를 끌어내는데 — discovery 캐시가 따뜻하면 아무것도 보내지
  않은 경우가 잦기 때문이다. 그러지 않으면 캐시된 카탈로그 위의 런은 값이 본문에 들어 있는
  헤더를 빠뜨리게 되고, 그것으로 라우팅하는 서버는 그 요청을 거부할 수밖에 없다.
- **`resultType: "input_required"`** 로 표시된 결과 — 서버가 답하기 전에 승인이나 빠진 인자를
  필요로 한다는 뜻이다(MRTR, 프로토콜 `2026-07-28`) — 는 "no content" 검사로 흘러가지 않고
  그 자체의 실패로 보고된다. 흘러갔다면 운영자를, 자기 프로토콜이 말한 그대로 행동하고 있는
  서버를 들여다보라고 보내는 셈이 된다. 이 클라이언트는 그런 요청에 답하지 않는다. 이 필드가
  없는 결과는 스펙이 요구하는 대로 평범한 결과다.
- tool 의 **이미지** 결과(`image` 블록, 그리고 이미지 mime 타입을 가진 `resource` blob)는
  버려지지 않고 바이트로 돌아온다: 엔진이 그것을 등록해 사용자에게 스트리밍하고, 후속 user
  메시지로 그 턴에 붙인다 — 마지막 단계는 모델이 이미지 입력을 받는 경우에만 한다. 텍스트만
  받는 모델이라면 그 파트를 거부해 턴을 실패시킬 것이기 때문이다. 전달 자체는 모델에 달려
  있지 않다: 스크린샷을 요청한 사람은 모델이 아니며, 결과 텍스트는 그림이 대화 속이 아니라
  그 사람에게 갔다고 말한다.
- **다른 모든 content 타입은 프로토콜이 정의한 대로 읽는다.** `resource_link` 는 자기 URI 와
  그것을 식별하는 정보가 된다 — 페이로드가 아니라 모델이 요청할 수 있는 포인터다. `audio`
  블록은 이름이 붙는 데서 그친다. 한 턴은 텍스트와 이미지만 나르므로, 모델에게는 녹음이
  존재한다고 알려 주고 모델은 전사를 요청할 수 있다.
- **스키마를 깨는 결과는 통째로 거부된다.** 클라이언트가 결과 전체를 검증하므로, tool 하나가
  객체가 아닌 `inputSchema` 를 선언하면 그 서버는 카탈로그 전부를 잃고, 스키마가 모르는
  타입의 content 블록은 그 호출을 실패시킨다. 파싱되는 것은 읽고 나머지는 이름만 남기던
  수제(hand-rolled) 클라이언트에서 바뀐 점이다 — 맞바꾼 것은, 잘못된 응답이 조용히 얇아지는
  대신 보고된다는 것과, 블록 타입을 추가하는 리비전에는 SDK 업그레이드가 필요해진다는 것이다.
  이것은 "도달 불가"(`unusableServerReason`)에서 제외한다. 서버는 살아서 답하고 있고, 고칠
  곳은 이쪽 아니면 저쪽이지 결코 네트워크가 아니기 때문이다.
- **`tools` capability 를 선언하지 않은 서버에는 카탈로그를 아예 묻지 않는다.** 스펙은 tool
  을 가진 서버라면 반드시 선언하라고 요구하며, SDK 는 `tools/list` 를 보내지 않고 빈 목록을
  반환한다. 그것은 조용한 손실이 되므로, 런은 둘 중 어느 쪽이 일어났는지 말한다: 비어 있음
  경고가 읽는 것이 `McpSession.declaresTools` 다.
- **페이징이 끝나지 않는 카탈로그는 그 전부를 잃는다.** 집계 순회는 페이지 상한에서 throw
  하고 부분 결과를 남기지 않는다. 수제 구현은 가진 페이지를 반환하고 남은 꼬리를 경고했었다 —
  그래서 이제 상한은 공짜가 아니고, 그보다 낮은 값이 아니라 SDK 자신의 기본값인 64 에 놓이며,
  거기에 도달하면 이 클라이언트가 쓸 수 없는 서버로 보고된다. 수렴하지 않는 커서에 대한 진짜
  방어는 discovery 데드라인이다.
- **서버가 content 블록을 하나도 보내지 않았을 때 `structuredContent` 를 읽는다.** 그것을
  텍스트 블록으로 직렬화하는 것은 SHOULD 일 뿐이므로, 건너뛴 서버도 여전히 답하고 있는 것이다
  — 그 결과는 예전에 "no content" 로 보고됐는데, 성공한 호출에 대한 실패 보고였다. 둘 다 있을
  때는 content 블록이 이긴다. 텍스트 블록이 곧 그 직렬화이기 때문이다. 설명할 것이 아무것도
  없는 `isError` 결과는 비어 있음을 보고하는 대신 **판정** 을 유지한다; 빈 `content` 배열은
  실패가 아니라 할 말 없이 성공한 호출(무언가를 지운 삭제)이며, 더 이상 문자열 `[]` 로
  모델에 닿지 않는다.
- **tool 호출에서 온 401** 은 discovery 에서 온 401 과 똑같이 그 연결에 재연결 플래그를
  붙이며, 그래야만 한다: discovery 는 캐시되므로, 캐시가 따뜻한 런은 그 서버로의 첫 요청을
  *첫 tool 호출에서* 하게 되고, 마지막 discovery 이후에 회수된 토큰은 다른 어디에서도 드러날
  수 없다. 몇 번의 호출을 거부당하든 서버당 한 번만 기록되고, 런이 세션을 해제할 때 적용된다.
  모든 tool 실패는 tool 과 서버의 이름도 함께 밝힌다 — 한 런이 여럿을 바인딩할 수 있고, 맨몸의
  `HTTP 500` 은 그중 어느 것도 가리키지 못한다.

## Discovery 캐시

Discovery 는 `url + headers` 단위로 캐시된다(`discoveryCache.ts`). 히트하면 세션은 연결되지
않은 채로 남고 첫 tool 호출에서 lazy 하게 연결하므로, **tool 을 하나도 호출하지 않는 턴은 MCP
요청을 아예 하지 않는다** — 예전 chat 은 서버마다 메시지마다 핸드셰이크 전체를 치렀다. 헤더가
키의 일부이므로 한 tenant 의 tool 목록이 다른 tenant 에게 답하는 일은 결코 없다.

실패도 짧게, 그리고 하나의 값(`DiscoveryFailure`)으로 캐시된다. 그래서 재생된 실패는 살아
있던 실패가 그랬던 것과 똑같이 자기를 설명한다 — "도달 불가" 가 아닌 두 가지 해석을 포함해서:
401 은 *project* 에게 재연결을 요구하고, 쓸 수 없는 서버는 이쪽 아니면 저쪽에서의 수정을
요구한다.

`tools/list` 에 캐싱 힌트 `ttlMs` (SEP-2549)를 보내는 서버는 자기 항목의 수명을 스스로 정한다
— 자기 카탈로그는 자기가 알고, 로컬 기본값은 남의 것에 대한 추측일 뿐이기 때문이다 — 다만
별도의 상한에 묶인다. **페이지로 나뉜** 카탈로그에서 그 힌트는 첫 페이지의 것이다. 이
클라이언트는 예전에 페이지들 중 가장 짧은 값을 취했다: SDK 의 페이지별 호출은 커서를 넘겨
선택되는데, 첫 페이지에는 커서가 없다. 두 knob 에 대한 전체 논거와 그 값은
[CONFIGURATION.md](../CONFIGURATION.md#mcp) 에 있다.

## Managed 서버

`runtime: "managed"` 는 **이 앱이 자기 호스트 위에서 직접 띄우는** 컨테이너이며, 호스트의
Docker CLI 로(`MANAGED_MCP_RUNTIME=docker`, 유일한 런타임) 시작되고 `127.0.0.1:<port>` 로
도달한다. 그 주소는 URL 정책이 거부하는
주소다 — 운영자가 타이핑한 무언가에 대해서는 그게 맞다 — 그래서 신뢰는 대신
**출처(provenance)** 에 기댄다: 프로비저너가 포트를 바인딩한 뒤 그 주소를 기록했다는 사실이다. 그
우회로가 좁다는 것 자체가 보안 속성이다;
[SECURITY.md](../SECURITY.md#managed-루프백-예외) 를 보라.

저장된 행은 `image`, `args`, `endpointPath`, `containerPort` 와 컨테이너의 환경을 싣는다 —
재시작이 필요로 하는 전부다. 재시작 시점에는 다시 물어볼 운영자가 없기 때문이다. 환경이 두
경로로 들어오는 것은 의도적이다: `envRefs` 는 호스트의 env 파일을 절대 경로로 가리켜
`--env-file` 로 건네지므로 그 값들은 이 테이블에 아예 들어오지 않고, `environment` 는 달리 있을
곳이 없던 값들을 들고 있으며 다른 모든 저장 자격증명과 마찬가지로 저장 시 암호화된다. 여기에
`PORT` 는 거부되는데, 그것은 런타임이 소유하기 때문이다.

`containerPort` 는 컨테이너가 리슨할 것으로 기대되는 포트다: 프로비저너는
`127.0.0.1:<port>:<containerPort>` 매핑을 게시하고 `-e PORT=<containerPort>` 를 써 넣어 — 운영자가
env 파일에 둔 `PORT` 보다 `-e` 가 이기므로 매핑이 쓰는 쪽이 이긴다 — 이미지가 그것을 따르게
한다. 인자 안의 `{{PORT}}` 는 실제 리슨 포트가 되므로, `PORT` 환경변수를 따르지 않는 이미지도
그대로 동작한다. 값이 없는(저장되기 전의) 항목은 게시되는 포트 자신으로 매핑한다.

같은 이름의 생성·재시작·workload 변경은 container를 건드리기 전에 process-wide claim으로
직렬화한다. DB의 conditional create만으로는 늦다. 두 요청이 모두 같은 이름으로 `rm`과 `run`을
마친 다음 row 쓰기에서 승패가 갈리면, 승자의 row가 패자의 container 설정을 가리키기 때문이다.
등록 쓰기가 실패한 생성은 시작한 container를 제거하며, 제거까지 실패하면 원래 실패와 함께
운영 오류로 드러낸다.

**재배포에서 살아남기.** 포트 매핑은 앱 컨테이너가 아니라 호스트의 루프백에 게시되므로, 이
앱을 교체해도 컨테이너의 주소는 그대로다 — 그 대신 앱 프로세스가 그 루프백을 봐야 하고(호스트에서
돌거나 호스트 네트워크를 공유), 같은 이유로 **호스트당 앱 인스턴스 하나** 가 전제다. `reconcile`
(`src/application/mcp/managedMcpUseCases.ts`)은 부팅 시 `instrumentation.ts` 에서 발화되고
결코 await 되지 않으며, 모든 managed 항목을 probe 해서 답하지 않는 것들을 재시작한다.
`status` 가 **도달 가능성을 liveness 와 분리해서** 보고하는 것도 같은 이유다: 후자만 보고했던
것이 닿을 수 없는 컨테이너를 보이지 않게 만들었다.

## OAuth

레지스트리 항목은 등록 시점에 한 번 발견된 `auth` 블록을 실을 수 있다; **런 경로는 well-known
문서를 결코 가져오지 않는다.**

배치(placement) 결정이 곧 아키텍처 결정이다: 자격증명은 **project 별** 이고, 자기 자신의
`PROJECT#<name> / MCPCONN#<server>` 아이템에 들어간다 — 버전(설정 이력의 스냅샷)에도 아니고,
project 아이템(그 `updatedAt` 은 publish 의 낙관적 동시성 조건이다)에도 아니다. 그 분리가
공유된 레지스트리 항목 하나가 project 마다 다른 provider 앱을 상대할 수 있게 하며, 레지스트리는
admin 소유인데 connection 은 owner 소유인 이유도 그것이다.

connection 은 서버를 통제(gating)하는 것이 아니라 자격증명을 **공급** 한다. 해석된 토큰은
dispatch 시점에 적용되는 마지막 **자격증명** 이며 — 레지스트리 항목의 헤더와 바인딩의 override
위에 얹힌다 — 그래서 버전은 project 의 connection 자리에 자기 `Authorization` 을 대신 넣을 수
없다. (`X-Tenant-Id` 는 그 뒤에 찍히지만 아무것도 인증하지 않는다.) 쓸 수 있는 connection 이
없으면 서버는 여전히 그 헤더들이 들고 있는 것으로 돈다; 그것들이 아무것도 들고 있지 않을
때에만 경고와 함께 버려진다. 어떤 항목에서 OAuth 를 발견하는 것은 그것을 인증할 방법을
*더하는* 일이지 운영자가 이미 설정해 둔 방법을 빼앗는 일이어서는 안 된다. 그래서 항목 하나가
정적 헤더를 쓰는 project 와 OAuth 를 쓰는 project 를 나란히 상대할 수 있다.

토큰 갱신은 `MAX_RUN_DURATION_MS` 에서 파생된 여유(margin) 안에서만 일어난다. 그래야 토큰이
런 도중에 만료될 수 없고 *동시에* 헤더가 런 사이에 바이트 단위로 동일하게 유지된다 — 매 런마다
갱신하면 매 런마다 discovery 캐시 키가 바뀐다.

**클라이언트 자신이 어디서 오는가** 는 프로토콜 `2026-07-28` 에서 바뀌었다. 이 리비전은 동적
등록(dynamic registration)을 폐기하고 **Client ID Metadata Documents** 를 택한다: `client_id`
는 클라이언트가 호스팅하는 HTTPS URL 이고, authorization 서버가 그것을 가져간다. 등록은 그
뒤에 남아, 달리 아무것도 제공하지 않는 서버들을 위해 쓰인다 — 2025 era authorization 서버는
`registration_endpoint` 를 광고할 뿐 문서 지원은 없고, 그것들을 거부하면 그 소유자들은 잘
되던 연결을 위해 앱을 손으로 등록하게 된다. 이 배포는 배포 단위로 하나가 아니라 project 마다
하나를 게시하는데(`/api/mcps/oauth/client-metadata/{project}`), 그 문서가 바로 사람이 연결을
승인할 때 보는 것이기 때문이다 — 하나뿐이라면 어느 project 가 요청하는지 알 길 없이
"Agent Studio" 에 접근 권한을 달라고 요구하는 셈이 되는데, 등록 방식은 자기가 만든 모든
클라이언트에 project 이름을 붙였었다. 아무것도 요청하지 않고 아무것도 저장하지 않는다:
예전에 등록하고 시크릿을 받아 암호화하던 흐름이 이제는 이미 알고 있던 URL 을 적을 뿐이다.

**메타데이터를 어디서 읽는가.** authorization 서버의 문서는 명세가 정한 순서의 세 주소에서
찾고(`authorizationServerCandidates`), 경로가 있는 issuer 의 root 문서는 다른 issuer 의 것이라
시도하지 않으며, `issuer` 가 맞지 않는 문서는 쓰지 않는다(RFC 8414 의 요구대로 문자열을
code-point 단위로 그대로 비교한다). **알려진 한계**: Microsoft Entra 의 `…/common/v2.0`
은 테넌트 issuer 로 답하므로 그 문서는 거부된다 — 리소스가 테넌트 issuer 를 직접 광고해야 한다. resource metadata 는 well-known
서버 자신의 401 이 `WWW-Authenticate` 로 지목하는 주소를 먼저 읽고, 주소가 없을 때만 well-known
경로 둘을 순서대로 읽는다 — challenge 가 있으면 그것이 authoritative 하다는 MCP discovery 규칙을
따른다. 프로브는 어차피 클라이언트가 처음 보낼 `initialize` 다. 런타임의 401/403 도 같은
헤더를 SDK 의 요청별 `InsufficientScopeError` 로 읽어 `insufficient_scope` 가 이름 댄 scope 를
연결에 합친다. 한 turn 의 tool 호출은 병렬이므로 session 전체의 마지막 challenge 를 읽지 않는다.
등록은 토큰 요청이 쓸 인증 방식으로 하고 서버가 기록한 방식을 연결에 적는다.

프로토콜 수준의 검사(PKCE, `resource`, `iss`, issuer 바인딩 — 메타데이터 문서 클라이언트에서는
이것이 뒤집힌다)는 [SECURITY.md](../SECURITY.md#mcp-oauth) 에 있다.

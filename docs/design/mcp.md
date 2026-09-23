# MCP

전역 registry의 서버를 Agent 설정에 연결하고 SDK Runtime에 도구로 제공한다.
서버 주소·설명은 registry, 도구 선택·헤더 override는 Agent 설정, OAuth grant는 Project가 소유한다.
HTTP 형태는 [API](../API.md#mcp-oauth), 설정은 [CONFIGURATION](../CONFIGURATION.md#mcp),
인가·SSRF·OAuth 검사는 [SECURITY](../SECURITY.md#mcp-oauth)를 따른다.

## Registry와 binding

`McpServer`는 이름·URL·설명·운영 노트·암호화된 header, 선택적 OAuth와 managed 설정을 저장한다.
`description`은 모델의 Connected MCP Servers 표에, `content`는 콘솔에 표시한다.
실제로 도달할 수 있고 허용된 도구가 있는 서버만 프롬프트에 설명한다.

Agent 설정의 `mcpList`는 서버 이름, `tools`, `headers`, 선택적 `sourceOutputs`를 가진다.
URL은 registry에서 온다. 기존 binding의 header 생략은 보존, `{}`는 제거,
문자열은 추가·교체, `null`은 registry 기본값 제거다.
마스킹과 endpoint fingerprint 계약은 [API 바인딩](../API.md#mcp-바인딩과-agent-헤더-오버라이드)을 따른다.
저장된 바인딩의 이름·헤더·도구 제한·파일 매핑이 유효하지 않으면 Agent 설정 읽기를 거절한다.
잘못된 항목을 건너뛰어 도구를 조용히 잃지 않는다.

Plugin sync는 streamable-HTTP 서버만 가져오며 header를 가져오지 않는다.
모델용 설명과 운영 노트는 Plugin의 `org.opspresso.agent-studio/mcp/<server>.md`를 사용한다.
파일 응답 매핑은 opaque source reference로 변환할 때 사용한다.
[Plugin 동기화](capabilities.md#plugin-동기화)와 [오디오 설계](audio-processing-spec.md#범용-설정과-도구)를 보라.

### 실행 신원

`application/mcpMetadataHeaders.ts`가 세 예약 header를 소유한다.
저장된 header의 모든 대소문자 표기를 OAuth 가용성 검사 전에 제거하고 서버가 결정한 값을 붙인다.

| Header | 의미 | discovery cache |
|---|---|---|
| `X-Tenant-Id` | 호출하는 Project 이름 | 신원 키에 포함 |
| `X-User-Email` | 확인한 user·project-token 이메일 또는 표면이 해석한 이메일 | 신원 키에 포함 |
| `X-Conversation-Id` | 표면과 호출자 범위로 구분한 대화 주소 | 요청 문맥으로만 전달 |

이 값은 credential을 대신하지 않는다. MCP 서버는 자기 Bearer/OAuth와 함께 인가해야 한다.
시스템 probe에는 사용자·대화가 없으며 registry Test와 프로젝트 도구 조회는 요청 사용자 email을
사용한다. 프로젝트 도구 조회도 tenant header는 보내지 않는 현재 차이가 있다.
각 probe와 런의 정확한 범위는 [보안 계약](../SECURITY.md#mcp-서버가-호출자에-대해-듣는-것)에 있다.

## Transport 와 세션

`infrastructure/mcp/session.ts`의 `McpSession`이 프로토콜을 소유한다.
ToolManager와 registry probe는 이 세션을 공유하고 SDK Runtime에는 준비된 alias·도구 스냅샷을 제공한다.

현재 `@modelcontextprotocol/client`에 `versionNegotiation: { mode: "auto" }`를 사용한다.
`server/discover` probe는 `2026-07-28`을 제안하며, 인식하지 못하는 서버는 legacy
`initialize` 협상으로 연결한다. legacy 제안 revision은 SDK의 `LATEST_PROTOCOL_VERSION`에서 온다.
서버가 지원하는 revision을 알지만 현재 SDK로 말할 수 없으면 업그레이드가 필요한 서버로 보고한다.

| 경계 | 동작 |
|---|---|
| 네트워크 | transport에 bounded fetch를 주입한다. 연결·목록·호출·해제가 같은 URL·응답 크기 정책을 지난다 |
| 연결 준비 | 서버에는 병렬 연결하되 alias 배정은 binding 순서를 유지한다 |
| 도구 이름 | provider 함수 이름 규격에 맞게 정규화하고 충돌에는 suffix를 붙인다. 호출 시 원래 이름으로 역변환한다 |
| 목록 | `tools` capability가 없으면 묻지 않고 그 이유를 알린다. 페이지 상한 초과는 discovery 전체 실패이며 부분 목록을 성공으로 쓰지 않는다 |
| legacy 세션 소실 | session ID를 보낸 요청의 404만 한 번 재연결·재시도한다. 같은 세션을 잃은 동시 호출은 새 연결을 공유한다 |
| modern 요청 | SDK가 `Mcp-Method`·`Mcp-Name`·허용된 `Mcp-Param-*`를 만든다. 캐시된 tool definition도 호출에 넘긴다 |
| 서버 추가 입력 요구 | `input_required`를 구체적인 도구 실패로 보고한다. elicitation·sampling·roots를 자동 수행하지 않는다 |
| 401·scope 부족 | 해당 요청의 typed challenge로 연결을 재인증 상태로 표시하고 필요한 scope를 보탠다 |
| 취소·종료 | 호출자의 취소를 실패 캐시에 넣지 않는다. 해제는 제한 시간 안에서 best-effort로 수행하며 modern 연결은 legacy DELETE를 보내지 않는다 |

연결·목록·호출·해제의 제한은 [CONFIGURATION](../CONFIGURATION.md#코드에-고정된-제한)에 있다.
legacy 404 재시도는 서버가 세션을 찾지 못해 효과 실행 전에 거절했다는 프로토콜 계약에 기대며
일반적인 도구 실패를 다시 실행하는 정책이 아니다.

SDK 갱신은 protocol 변경으로 검토한다. 협상 revision, auto fallback, `listMaxPages`의
throw 동작과 `SdkErrorCode` 매핑을 확인한다.
검사는 `toolManager.test.ts`, `mcpClientMetadata.test.ts`, `mcpDiscoveryCache.test.ts`,
`mcpProtocolStub.ts`의 서버 fixture를 사용한다.

### 결과 해석

`toolManager.ts`는 검증된 결과를 모델용 텍스트·이미지·파일로 나눈다.

| MCP 결과 | 앱 처리 |
|---|---|
| text | 도구 결과 예산 내 텍스트 |
| image 또는 image resource blob | 제한된 bytes를 사용자에게 전달하고 이미지 지원 모델의 문맥에도 연결 |
| 그 밖의 resource blob | UTF-8이면 텍스트, 그렇지 않으면 크기 한도 내 파일 출력 |
| resource link | URI와 설명을 포인터로 제공하며 자동으로 내려받지 않는다 |
| audio | 존재를 알리는 설명. 일반 모델 턴에 오디오 bytes를 넣지 않는다 |
| structuredContent | content가 비었거나 공백 text뿐이면 JSON 텍스트로 전달한다. 비어 있지 않은 text나 미디어가 있으면 content가 우선한다 |
| 빈 content | 빈 성공과 `isError` 실패를 구분한다 |
| schema를 어긴 결과 | 해당 응답을 거절하고 오류를 설명한다 |

파일과 이미지의 저장은 [실행 브래킷](execution.md#artifacts)이 담당한다.
`sourceOutputs`가 지정된 도구는 모델용 길이 제한보다 먼저 비공개 파일 참조를 추출한다.
응답에 알려지지 않은 content 타입이 추가되면 SDK 변경이 필요할 수 있다.

## Discovery 캐시

캐시 키는 URL과 신원 header다. 사용자·프로젝트별 도구 목록을 공유하지 않는다.
대화 header는 key에 포함하지 않는다. 캐시가 맞으면 세션을 열지 않고 준비할 수 있으며
실제 도구 호출 시 lazy 연결한다.

서버 `ttlMs` hint는 첫 페이지에서 읽고 배포 상한 안에서 적용한다.
로컬 TTL이 0이면 캐시를 끄며 서버 hint가 다시 켜지 못한다.
실패도 짧게 캐시하고 인증 실패·프로토콜 미지원·응답 검증 실패를 구분해 재생한다.
편집 무효화는 프로세스 로컬이므로 다중 인스턴스는 TTL에 따라 갱신된다.

## Managed 서버

`MANAGED_MCP_RUNTIME=docker`와 registry 설정이 있는 배포에서 앱이 호스트 Docker CLI를 호출한다.
`127.0.0.1:<port>:<containerPort>` 매핑을 게시하고 그 주소를 등록한다.
이 주소는 사용자 입력의 사설 URL 허용과 구분되는 managed provenance 예외다.

행에는 image·args·endpointPath·containerPort·암호화 environment를 저장한다.
Docker에는 argv 배열과 process가 만든 0600 임시 env 파일을 넘기며 호스트 파일 경로를 받지 않는다.
`PORT`는 runtime이 지정하고 args의 `{{PORT}}`를 실제 listen 포트로 치환한다.
자원·파일시스템·capability 제한은 [보안 계약](../SECURITY.md#managed-루프백-예외)을 따른다.

같은 이름의 생성·재시작·변경을 process-wide claim으로 직렬화한다.
생성 후 DB 저장 실패, 안전하지 않은 주소, 삭제된 행과의 경합에서는 새 workload를 정리하고
cleanup 실패도 숨기지 않는다. Docker와 DB를 하나의 원자적 transaction으로 취급하지 않는다.

앱은 호스트 loopback과 Docker daemon에 접근해야 하며 호스트당 앱 인스턴스 하나를 전제로 한다.
앱 교체가 호스트 포트 매핑을 옮기는 것은 아니다. 부팅의 `reconcile`은 서버를 probe하고
도달하지 못한 컨테이너를 재시작하며 listen을 막지 않는다.
running과 reachable을 별도로 확인한다. [운영](../OPERATIONS.md#재배포-이후의-관리형-mcp)을 보라.

## OAuth

관리자는 서버에서 discovery한 `auth`와 공유 OAuth 앱을 관리하고,
프로젝트 소유자는 그 앱으로 자기 계정의 grant를 연결한다.
access/refresh token과 연결 revision은 프로젝트별 연결 행에 보관하며 Agent 실행 설정과 분리한다.

실행 경로는 well-known 문서를 다시 가져오지 않는다. 저장된 메타데이터로 grant를 해석하고
필요하면 갱신한다. 공유 client secret은 registry에서 읽어 회전을 반영하고,
Client ID가 달라지면 기존 grant를 거절한다. 개별 등록 client secret은 해당 connection에 남는다.

credential 선택은 기존 client, 사용할 수 있는 Client ID Metadata Document,
dynamic registration 순서다. 프로젝트별 공개 metadata URL은 설정한 공개 base로만 만든다.
제공자가 가져올 수 없는 주소이면 다른 지원 경로를 사용하거나 구체적인 설정 오류로 거절한다.

refresh는 남은 실행 시간을 고려한 여유 구간에서 수행한다.
갱신은 revision CAS로 저장하고 경쟁에서 진 호출은 동일 issuer·resource의 유효한 승자 grant만 사용한다.
일시 5xx·timeout은 grant를 폐기하지 않으며 실제 인증 거절은 재연결이 필요한 상태로 바꾼다.

OAuth는 credential을 공급한다. 유효한 token이 있으면 정적·binding Authorization보다 우선하고,
연결이 없더라도 별도 정적 credential이 있으면 사용할 수 있다.
PKCE·resource·issuer·state·콜백 소유권, Google·Slack metadata의 제한된 예외와 내부 URL 경계는
[SECURITY의 OAuth 계약](../SECURITY.md#mcp-oauth)을 따른다.

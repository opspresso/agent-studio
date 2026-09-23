# 보안

인증·인가, 시크릿, 네트워크, 모델 입력과 저장 데이터의 보안 경계를 설명한다.
설정만으로 보장하는 것과 배포 환경이 책임지는 것을 구분한다.

관련 문서: 여기서 언급하는 변수는 [CONFIGURATION.md](CONFIGURATION.md), 엔드포인트별 인가는
[API.md](API.md), 조각들이 어떻게 맞물리는지는 [ARCHITECTURE.md](ARCHITECTURE.md).

## 인증

Better Auth의 `advanced.cookiePrefix`는 `agent-studio`다. 기본 세션 쿠키는
`agent-studio.session_token`이며 HTTPS 설정에서는 `__Secure-`가 붙는다. 페이지 게이트도 같은
접두어를 사용한다. Agent Memory의 `agent-memory` 쿠키와 분리하며 이전 `better-auth` 쿠키는
읽지 않는다. 접두어 변경을 배포하면 기존 브라우저 세션은 다시 로그인해야 한다.

Better Auth 1.7은 앱의 커넥션 풀 위에서 라이브러리 자신의 Postgres 어댑터로 돈다.
`user`, `session`, `account`, `verification` 은 그것이 소유하는 테이블이고(`migrations.ts` 가
만든다), email·token 의 유일성은 테이블의 유니크 제약이다.

계정의 식별자는 `providerId + accountId`이며 이 조합에 unique index를 둔다. `issuer`는
기존 값을 보존하는 nullable 이력 컬럼이고 새 계정에는 쓰지 않는다. 같은 계정 키가 여러 행에
있으면 업그레이드를 중단한다. 서로 다른 사용자를 자동 병합하거나 provider를 임의로 바꾸지 않는다.

로그인 수단은 **전부 선택**이고 설치가 고른다 (`src/lib/config.ts` 의 `authProviders`,
그대로 `auth.ts` 와 로그인 페이지로):

| 수단 | 켜는 것 | 성질 |
|---|---|---|
| Keycloak | `KEYCLOAK_ISSUER` + `KEYCLOAK_CLIENT_ID` + `KEYCLOAK_CLIENT_SECRET` | Better Auth의 Keycloak helper와 `genericOAuth`로 discovery를 읽고 PKCE(S256)를 쓴다. 콜백 `/api/auth/callback/keycloak` |
| 표준 OIDC | `OIDC_ISSUER` + `OIDC_CLIENT_ID` + `OIDC_CLIENT_SECRET` | `genericOAuth`로 discovery 문서에서 찾고 PKCE를 쓴다. 콜백 `/api/auth/callback/oidc` |
| Google | `GOOGLE_CLIENT_ID` + `GOOGLE_CLIENT_SECRET` | 콜백 `/api/auth/callback/google` |
| 이메일 + 비밀번호 | `AUTH_PASSWORD=true` | **가입 폼이 없다**(`disableSignUp`): 신원 제공자가 보증하는 사람은 첫 로그인으로 사용자가 되지만, 비밀번호 계정은 아무도 보증하지 않으므로 부트스트랩 관리자(`BOOTSTRAP_ADMIN_EMAIL`/`PASSWORD`, 부팅 때 한 번)와 관리자가 의도적으로 만든 계정뿐이다. 첫 관리자와 제공자가 죽었을 때의 비상 접근용이다 |

Keycloak·표준 OIDC·Google을 함께 설정하면 각 로그인 버튼을 표시한다. Keycloak은 discovery의
issuer·JWKS가 있어야 등록하며 ID 토큰의 서명·issuer·audience와 요청별 nonce를 Better Auth가
검증한다. 로그인 버튼은 설정의 존재를 나타내므로 discovery 실패 시에도 표시되지만 인증은
실패한다. 제공자 복구 뒤 앱을 재시작해 discovery를 다시 읽는다. Keycloak issuer는 배포 운영자가
환경 변수로 지정하며 사내 주소를 허용한다. 브라우저와 서버 모두 그 주소에 접근할 수 있어야 한다.
Keycloak role을 앱 tier로 매핑하지 않는다. 기존 관리자 설정과 멤버 tier 정책을 적용한다.
Keycloak으로 로그인한 사용자의 앱 로그아웃은 앱 세션만 종료하며 Keycloak SSO 세션은 유지한다.

`STAGE=alpha|prod`는 로그인 수단이 하나도 없으면 부팅을 거부한다(`assertAccessControlConfig`);
`local` 은 `scripts/dev-session.ts` 가 세션을 만들어 주므로 없어도 된다. 로그인은 수단과
무관하게 `ALLOWED_EMAIL_DOMAINS` 로 제한된다. 사용자 생성과 세션 생성 양쪽의 훅에서, 그래서
이미 있는 사용자도 도메인이 목록에서 빠지면 다음 로그인에 거절된다. 빈 목록은 모든 도메인을
허용한다. `STAGE=alpha|prod` 도 그 상태로 정상 부팅한다
([부팅 시 검증](CONFIGURATION.md#부팅-시-검증) 참고).

admin 전용 멤버 목록은 Better Auth 의 user 행을 읽는다. `createdAt` 은 가입 시각이고,
`lastLoginAt` 은 세션 생성에 성공한 뒤 갱신된다. 그 이전부터 있던 사용자는 다시 로그인하기
전까지 마지막 로그인 값이 없다. 타임스탬프 갱신 실패는 로그에 남지만, 신원 제공자 로그인에
성공한 것을 인증 실패로 바꾸지는 않는다.

### 두 개의 게이트, 의도적으로

| 표면 | 게이트 | 무엇을 결정하는가 |
|---|---|---|
| 페이지 | `src/proxy.ts` | 로그아웃 상태의 방문자를 `/login?next=…` 로 리다이렉트 |
| API 라우트 | `withAuth` / `withMemberAuth` / `withAdminAuth` (`src/lib/session.ts`) | 세션이 없으면 401. member gate는 tier를, admin gate는 아래의 effective admin 판정을 사용한다. 실패는 403이며 성공하면 `SessionUser`를 건넨다 |

`src/shared/pageAccess.ts` 는 어떤 페이지가 공개인지에 대한 단일 소유자다. `/`, `/login`, `/guide`.
가이드는 로그인 없이 읽는 정적 안내이며, 가이드에서 연결하는 프로젝트·설정 페이지와 API는
각자의 인증·권한 검사를 유지한다.
`src/proxy.ts`와 브라우저의 만료 세션 redirect가 같은 판정을 읽는다. matcher 가 닿는 나머지
전부는 세션을 요구하므로 **새 라우트는 기본이 보호 상태** 다. 그 방향은
의도적이다. 공개 페이지를 목록에 넣는 것을 잊으면 사용자가 1분 안에 신고하는 리다이렉트가
생기지만, 비공개 페이지를 넣는 것을 잊으면 조용히 실패한다.

페이지 게이트는 세션 쿠키의 유효성이 아니라 *존재* 를 확인한다. 유효성까지 확인하려면 모든
내비게이션마다 세션을 읽어야 하고, 그러고도 그것은 인가 결정이 아니다. 인가는 실제로
데이터를 만지는 요청을 보는 `withAuth` 와 `assertProjectWritable` 에서 서버 측에 남는다.
따라서 존재하지만 유효하지 않은 쿠키는 페이지에 도달하고 그 뒤의 API 에서 401 을 받는다.
브라우저의 공통 응답 경계는 같은 origin의 `/api/*` 401을 받으면 현재 path·query·fragment를
`next`로 보존해 `/login`으로 full navigation한다. Root layout이 이미 세션을 유효하지 않다고
판정한 보호 페이지도 같은 경로를 탄다. 게이트가 없애는 것은 평범한 로그아웃 상태이며,
그 방문자에게 콘솔 shell이나 API error box를 렌더링하지 않는다.

`/api` 는 matcher 밖에 있다. 그 라우트들은 스스로 인증하며, 프로그램 호출자에게는 HTML
리다이렉트가 아니라 반드시 401 로 답해야 한다.

`next` 파라미터는 주소창에서 오므로 `/login` 은 그것을
`safeNextPath`(`src/shared/safeNextPath.ts`)로 되읽는다. `//host` 와 `/\host` 를 거부하지
않으면 로그인 플로우가 오픈 리다이렉트가 된다.

로그인 오류는 `signInError.ts`의 코드로 전달하고 로그인 페이지가 자기 문구로 표시한다.
알 수 없는 `error` 값은 일반 오류로 바꾸며 제공자의 텍스트나 허용 도메인 목록을 그대로 반사하지 않는다.

## 인가 모델

**Project 는 공유 카탈로그이되, 공개 범위(visibility)를 갖는다.** `public`(기본값이자
`visibility` 필드가 없는 기존 행의 의미)은 로그인한 사용자라면 누구나 읽고 실행하고 복제할
수 있다. `private` 은 그 범위를 소유자와 `memberEmails` 의 초대 목록으로 좁힌다. 쓰기는
이 축과 무관하게 언제나 소유자-또는-admin 이다. 판정의 유일한 정의는
`src/domain/project/access.ts` (`mayAccessProject`)이고, admin 오버라이드를 합친 형태가
`assertProjectAccessible` / `userMayAccessProject` (`projectUseCases.ts`)다. 새 읽기·실행
표면은 이 둘 중 하나를 지나며, `visibility` 나 `memberEmails` 를 직접 비교하는 두 번째
판정을 만들지 않는다.

**세 부류의 표면이 세 가지로 다르게 게이트된다.** 사람이 세션으로 들어오는 콘솔·chat 은
`assertProjectAccessible` 로 막는다. API token, trigger, webhook, 그리고
소유자가 직접 연결한 Telegram·Teams bot 은 *자격 증명 자체가 접근권* 이라 visibility 를 묻지
않는다. token 은 소유자로서 행동하고, bot 배선은 소유자의 선택이다. Slack bot 만 그 중간에
있다: workspace 의 누구나 말을 걸 수 있으므로, private project 의 bot 은 `users.info` 의
이메일로 묻는 사람을 식별해 초대 여부를 확인하고, 이메일을 공유하지 않는 workspace 의
사용자는 거절한다 (`slackSenderMayAccess`, 런, `!mute`·`!stop` 명령, native 중단 이벤트, thread-start 인사가 같은
게이트를 지난다). 앱이 서명한 메시지(키워드로 깨운 알림 등)는 통과한다: 그 키워드는
소유자 자신의 설정이라 trigger 와 같은 소유자-배선 자동화다. 조회된 주소는 판정에만
쓰이고 프롬프트에는 닿지 않는다. 초대 목록 자체(`memberEmails`)는 제3자 주소의 명부이므로
응답에서도 소유자·admin 에게만 나간다 (`sanitizeProject`).

private project 를 local subagent 로 *바인딩* 하는 것도 읽기다: 편집자가 접근할 수 없는
project 는 Agent 설정 저장 시점에 거절된다 (`assertSubagentProjectsAccessible`). 이미 바인딩된
참조는 project 가 뒤늦게 private 이 되어도 편집 가능성을 잃지 않는다. 실행 시점의 transfer
는 소유자의 token 과 같은 플랫폼 자신의 조립이다. 비용 대시보드의 project *합계* 는
visibility 이전처럼 열려 있다: 이름과 지출 집계는 카탈로그 운영의 일부로 남겨 둔 결정이다.

| 리소스 | 읽기 | 쓰기 |
|---|---|---|
| Project, Agent 설정 | 접근 가능한 사용자 (`assertProjectAccessible`, public 은 전원, private 은 소유자·초대 멤버·admin) | 소유자 또는 설정된 admin (`assertProjectWritable`) |
| Project trace | 소유자 또는 설정된 admin | — |
| Project Slack 설정 | 소유자 또는 설정된 admin | 소유자 또는 설정된 admin |
| Project API token, trigger, MCP 연결 | 소유자 또는 설정된 admin | 소유자 또는 설정된 admin |
| 호출자별 usage (`usage/actors`) | 소유자 또는 설정된 admin | — |
| Project usage 합계 | 로그인한 모든 사용자 | — |
| Skill / MCP 서버 / plugin | `member` tier 이상 (`withMemberAuth`; `guest` 는 403) | admin (`withAdminAuth`) |
| 앱 설정 | admin | admin |
| 모델 즐겨찾기 | 로그인한 사용자 본인 | 로그인한 사용자 본인 |
| 멤버 디렉터리 | admin | admin (tier 변경, `member.set-tier` 로 감사) |
| Chat | 소유자만 (소유자가 아니면 404) | 소유자만 |
| Workspace | 소유자와 현재 프로젝트 접근 검사 | 소유자; 실행·Git 승인은 활성화·정책·승인 상태도 검사 |
| 오디오 job·비공개 source 파일 | 작업/파일 소유자와 프로젝트 접근 검사 | 소유자 범위와 job/file 상태에 따른 조작 |
| 일반 Artifact | 생성·첨부 소유자 또는 프로젝트 소유자/admin | 같은 소유권 범위에서 삭제. 비공개 source 파일은 위 전용 경계 |

trace 와 Slack 설정은 *읽기* 도 게이트되는데, 다른 사용자의 런타임 입출력과 마스킹된 자격
증명의 가장자리를 노출하기 때문이다. project *합계* 는 카탈로그가 공유되므로 열어 둔다.
호출자별 내역은 개인을 지목하므로 `usage/actors` 는 그렇지 않다. capability 레지스트리는
`guest` tier 에서 제외되는데, 그것이 담는 것은 guest 자신의 작업에 필요한 무엇이 아니라 이
배포가 무엇에 닿을 수 있는지의 목록이기 때문이다. guest 도 그것들에 바인딩된 project 를
*실행* 은 하며, 해석(resolution)은 서버 측에서 일어난다. project 의 `preview` 도 같은 단에
있다. 레지스트리가 감췄을 해석된 capability 이름을 그대로 렌더링하기 때문이다.

### `isAdminEmail` vs `isConfiguredAdmin`

둘 다 `src/lib/runtime-settings.ts` 안에 있는 서로 다른 admin 질문이고, 뒤바꿔 쓰면 안 된다:

| 술어 | 질문 | `ADMIN_EMAILS` 가 비었다는 것의 뜻 |
|---|---|---|
| `isAdminEmail` | 공유 레지스트리와 앱 설정을 변경해도 되는가? | **제한 없음**. 로그인한 모든 사용자 |
| `isConfiguredAdmin` | 남이 소유한 project 를 써도 되는가? | **아무도 안 된다** |

첫 번째를 project 소유권에 쓰면 `ADMIN_EMAILS` 를 한 번도 설정하지 않은 배포에서 로그인한 모든
사용자에게 모든 project 의 쓰기 권한을 넘기게 된다. 두 플래그는 `GET /api/me` 가 브라우저로
함께 보낸다. `isAdmin` 과 `isConfiguredAdmin` 으로. "이 project 를 편집해도 되는가"에 대한
콘솔의 게이트가 `assertProjectWritable` 을 정확히 반영해야 하기 때문이다. 거기서 `isAdmin` 을
읽었더니 모든 사용자에게 모든 project 의 편집 폼이 열렸고, 저장은 전부 403 이 났다.

**멤버 tier 는 두 번째 소스를 더할 뿐, 두 번째 술어를 만들지 않는다.** 저장된 `tier` 가
`admin` 인 멤버는 *두* 술어가 부여하는 것을 모두 얻는다. 그 합성은 오직
`src/lib/memberAccess.ts` 의 것이고(`isEffectiveAdmin` / `isEffectiveConfiguredAdmin`), 위 두
목록 술어는 빈 목록에 대한 의미를 바이트 단위로 그대로 유지한다. `ADMIN_EMAILS` 에 설정된
주소는 로그인 시 또는 다음 멤버/프로필 읽기 때 저장된 `admin` tier 로 승격되고, 그 주소가
설정에 남아 있는 동안 tier 는 잠긴다. 목록에서 빼도 결코 강등되지 않는다. 다른 운영자가
명시적으로 더 낮은 tier 를 골라야 한다. tier 는 Better Auth 의 user 행에 있고(`input: false`
라 어떤 auth API 로도 사용자가 자기 것을 설정할 수 없다), 내부 어댑터 또는
`memberRepository.setTier` 의 단일 속성 조건부 업데이트로만 쓰이며, 세션에 실려 라우트
핸들러에 도달한다. 요청마다 새로 읽는다. 세션을 볼 일이 없는 이음매들(project 쓰기
오버라이드, 런 브래킷의 가드)은 email → tier 를 30초짜리 인스턴스별 캐시로 해석하고, 그 캐시는
tier 변경을 처리한 인스턴스에서 무효화된다. 각 tier 가 동시에 몇 개를 진행할 수 있는지, UTC
월 기준으로 얼마를 쓸 수 있는지, 무엇을 할 수 있는지(project 생성, API token 사용)는
`src/domain/member/tiers.ts` 의 `TIER_LIMITS` 다. 게이트는 tier 이름 비교가 아니라 그 파일의
`tierMay*` 술어를 거친다. project 생성도 별도의 effective-admin 우회 없이 그 tier capability 를
따른다.

월 상한은 멤버 자신의 일별 행을 UTC 월 1일부터 합산한다. 프로필 페이지가 읽는 것과 같은 창,
같은 행이다. 집계가 하나뿐이므로 페이지가 가드와 어긋나는 합계를 보고할 수 없다. 사람 모양의
한도는 `user` actor 에만 적용된다. 기계 호출자(Slack, webhook, schedule)에는 멤버가 없다.
**project token** 은 소유자의 email 을 싣지만 의도적으로 소유자의 개인 예산이 아니라 *자기
project* 의 한도에서 지출한다. token 은 서비스 자격 증명이다. 그것이 우회가 되지 않게 하는
것은 token 게이트다. API token 권한이 없는 tier 는 token 을 발급할 수도 없고(소유자 범위,
admin 포함) 이미 있는 token 으로 인증할 수도 없다. `authenticateExecution` 은 모든 bearer
요청에서 소유자의 현재 tier 를 다시 확인하고 403 으로 답하므로, 강등은 그 소유자의 token 을
멈춘다. 다만 이 검사는 `getMemberTier`의 인스턴스별 30초 캐시를 사용하므로 다른 인스턴스에는
그만큼 전파가 늦을 수 있다. 멤버 행이 없으면 기본 `guest`로 거절하고, 캐시를 갱신할 때 tier 저장소를 읽지 못하면 503으로
fail-closed 한다. 권한 저장소 장애가 이미 제한된 credential 을 다시 활성화해서는 안 된다.

admin 오버라이드는 스무 곳 남짓한 호출자가 인자로 꿰어 넘기는 대신 `assertProjectWritable`
*안에서* 확인된다. 규칙은 "소유자 또는 admin"이고, 한 호출자가 넘기는 것을 잊은 플래그는 그
경로에서만 조용히 소유자 전용으로 규칙을 좁힐 것이다. 함수 이름은 소유자가 아니라 그 규칙을
따라 붙었다. 진짜로 **소유권** 이 필요한 것(attribution, 누구의 자격 증명으로 디스패치할지,
누구에게 알릴지)은 `project.ownerEmail` 을 읽는다.

오버라이드의 두 가지 귀결은 없는 셈 치지 않고 처리한다:

- **기록된다**. `project.admin-override` 감사 행과
  `[authz] admin … is acting on project …` 라인. 그 쓰기가 누가 했는지를 알려 줬을 행 자체를
  파괴할 수 있고, project 의 API token 은 *그 소유자로서* 인증하므로 admin 의 reveal 은 그 둘에
  더해 `secret.reveal` 행을 남긴다.
- 그것이 필요로 하는 설정 읽기는 **fail-closed** 다. 설정 저장소 장애는 소유자가 아닌 사람의
  결정적인 403 을 500 으로 바꾸는 대신 오버라이드를 거부한다.

## 저장된 시크릿

저장되는 모든 자격 증명. MCP 서버 헤더, Agent별 헤더 오버라이드, MCP OAuth 의
access/refresh token·client secret·인가 중인 PKCE verifier, Slack 봇 token 과 서명 시크릿,
Telegram 봇 token 과 webhook 시크릿, Teams(Azure Bot) 클라이언트 시크릿, project API token, webhook trigger 시크릿, 그리고 시크릿인 앱
설정(LLM API 키와 plugins 저장소의 GitHub token)은 `AES_ENCRYPTION_KEY` 로 AES-256-GCM
암호화된다(`src/infrastructure/crypto/secretEncryption.ts`). 새 값은 모두 `enc:v2:` 로 쓴다.
v2 는 row 와 field 정체성을 AES-GCM AAD 로 묶으므로 암호문만 다른 위치로 옮기면 인증에
실패한다. 기존 `enc:v1:` 값은 다시 저장하거나 재발급하기 전까지 그대로 읽는다.

Project API token 과 webhook trigger secret 은 각각 project 이름과
`project + triggerId` 에 묶인다. Slack 의 bot token·signing secret, Telegram 의 bot
token·webhook secret, Teams 의 app password 는 `project + integration + field` 를 쓴다.
MCP registry header 는 항목 이름과 header 이름에, managed MCP 의 environment 는
항목 이름과 변수 이름에 묶인다. HTTP header의 override 병합만 이름의 대소문자를 무시하고,
AAD 는 environment와 같은 공통 map 규칙에 따라 저장된 키 철자를 그대로 쓴다.

Agent의 MCP header override는 `project + agent + server + header`에 묶인다. 현재 설정을
같은 Agent에서 수정해도 암호화 문맥은 유지되며 다른 Agent로 복제할 때는 시크릿을 복사하지
않는다.

### 읽을 때의 마스킹

읽기는 **길이를 보존하는 마스크** 를 반환한다. 콘솔이 값을 보여 주지 않으면서 *어떤* 자격
증명이 설정돼 있는지는 보여 줄 수 있게 하기 위해서다:

| 평문 길이 | 드러나는 부분 |
|---|---|
| 9자 미만 | 없음 (`*` × 길이) |
| 9자 이상 | 앞 4자와 뒤 4자 |

드러난 두 가장자리가 만나는 일은 결코 허용되지 않는다. 가장자리를 드러내려면 평문이
필요하므로 마스킹은 복호화를 한다. 그것을 호출하는 admin/소유자 게이트가 걸린 읽기 뷰
안에서만이고, 복호화 실패는 에러를 내는 대신 값을 통째로 감춘다. 아무것도 드러나지 않을 만큼
짧은 값은 아예 복호화되지 않으며, 그 판단은 암호문 길이로 내린다(AES-GCM 은 평문 길이를
보존한다).

### 쓸 때의 마스크

업데이트 시 마스킹된 값이나 빈 값은 **저장된 시크릿을 보존한다**. 저장된 상대가 없는 키에 온
마스킹된 값은 **버린다**. 마스크는 이미 있는 시크릿을 확인해 줄 수만 있고, 만들어 낼 수는
없다. 헤더 오버라이드 맵의 `null` 은 명시적 제거로 그대로 통과한다. 제거는 시크릿이 아니다.
새로 입력한 값은 `enc:v1:` 또는 `enc:v2:` 로 시작하더라도 평문으로 취급해 항상 새로 암호화한다. 암호문 접두사는
저장소에서 읽은 값의 형식일 뿐, API 입력이 신뢰할 수 있는 저장 값이라는 증거가 아니다.
Agent별 MCP 문자열 오버라이드는 저장 당시 registry URL 의 fingerprint 와 함께 보관한다. 같은
이름의 URL 이 바뀌거나 fingerprint 가 없는 예전 값이면 옛 시크릿을 보내지 않는다. 새 endpoint
용 자격 증명을 다시 입력해야 한다.

### reveal 엔드포인트

이 앱이 발급하는 시크릿 중 둘은 평문으로 되읽을 수 있다:

| 시크릿 | 엔드포인트 | 누가 |
|---|---|---|
| Agent API token | `POST /api/projects/{name}/token/reveal` | 소유자 또는 admin |
| Webhook trigger 시크릿 | `POST /api/projects/{name}/triggers/{trigger}/reveal` | 소유자 또는 admin |

둘 모두 **읽는데도 POST** 다. 응답 본문이 살아 있는 자격 증명이므로 캐시, 브라우저 기록,
프리페치 바깥에 머물러야 한다. 모든 reveal 은 호출자의 email 과 함께 **감사 행** 을 남기고, 그
옆에 서버 측 로그 라인도 남긴다. 행은 나중의 질문이 조회하는 것이고, 라인은 감사 저장소 자체가
불가용할 때 살아남는 것이다.

따라서 둘은 해시가 아니라 **암호화해서** 저장되며, 이는 의도된 트레이드오프다. 데이터스토어만으로는
하나도 쓸 수 없지만, 데이터스토어 *더하기* `AES_ENCRYPTION_KEY` 면 쓸 수 있다. **그 키를 테이블
덤프와 살아 있는 project 자격 증명 사이에 서 있는 것으로 다뤄라.** reveal 이 생기기 전에 발급된
project token 은 대신 SHA-256 해시로 저장돼 있다. 검증은 되지만 다시 보여 줄 수는 없으므로
콘솔이 재발급을 제안한다.

### 발급한 시크릿의 접두사

이 앱이 발급하는 시크릿은 GitHub 의 `ghp_`/`gho_` 처럼 제품과 종류를 밝히는 접두사를
지녀(`src/shared/generatedSecret.ts`), 유출된 문자열이 무엇을 여는지 추적할 수 있다:

| 접두사 | 시크릿 |
|---|---|
| `ast_` | Project API token (소유자 관리) |
| `asw_` | Webhook trigger 시크릿 (소유자 관리) |
| `asg_` | Telegram webhook 시크릿 (project 마다 발행. Telegram 에게만 건네고 결코 reveal 하지 않는다) |

랜덤 부분은 32바이트(256비트)이므로 접두사가 잡아먹는 엔트로피는 문제가 되지 않는다. 검증은
접두사를 결코 보지 않으므로 예전 표기로 발급된 token. `ad*_`, 그 이전의 `sk_proj_`. 도 계속
동작한다.

project token 의 표시용 마스크는 생성 시점에 계산돼 암호문 옆에 저장되므로, token 을 나열하는
데는 복호화 비용이 들지 않는다. 그 마스크는 접두사와 가장자리 문자만 실어 나르며, token 을
복원하기에 충분한 적은 결코 없다.

## 머신 호출자의 요청 인증

세션 쿠키가 없는 호출자는 표면별 자격 증명을 사용한다:

| 표면 | 자격 증명 | 검증 |
|---|---|---|
| 실행 엔드포인트 (`predict`, `chat/completions`, `agent`) | `Authorization: Bearer ast_…` | 복호화 후 상수 시간 비교(레거시 token 은 해시 비교), 경로의 `{name}` 으로 범위 제한. **project 소유자로서** 실행된다 (`authenticateExecution`) |
| Slack 이벤트 | Slack 서명 시크릿 | HMAC + `timingSafeEqualString`, 5분 리플레이 윈도, project 별 시크릿 |
| Telegram webhook | `X-Telegram-Bot-Api-Secret-Token` | 이 플랫폼이 webhook 을 등록할 때 쓴 project 별 시크릿(`asg_…`)과 `timingSafeEqualString` 비교. Telegram 이 배달마다 그대로 되돌려주며, 그 밖에 확인할 서명은 없다 |
| Teams messaging endpoint | Bot Framework bearer 토큰 (JWT) | RS256 서명을 서비스가 공개한 JWKS(`login.botframework.com`) 로 검증하고, 발급자 `https://api.botframework.com`, audience = 그 봇의 App ID, `exp`/`nbf`(5분 skew), 그리고 **`serviceurl` 클레임 = activity 의 `serviceUrl`** 을 요구한다. 답은 그 주소로 이 앱의 토큰을 붙여 나가므로. Emulator 토큰은 받지 않는다 (`src/infrastructure/teams/client.ts`) |
| Webhook trigger | `X-Trigger-Secret` 또는 GitHub `X-Hub-Signature-256` | 프로젝트 시크릿의 `cipher.decryptEquals` 또는 원본 UTF-8 body의 HMAC-SHA256 상수 시간 비교. GitHub 헤더가 있으면 서명 검증을 강제하고 일반 시크릿으로 폴백하지 않는다. 서명된 ping은 실행하지 않으며 GitHub delivery ID로 중복을 차단한다 |
| Workspace GitHub webhook | `X-Hub-Signature-256`과 `X-GitHub-Delivery` | 별도 배포 시크릿으로 검증하고 PR/CI 메타데이터만 갱신한다. Git 실행 승인이 아니다 |
| CronJob 틱. schedule 스캔(`/api/triggers/scan`), 카탈로그 재색인(`/api/catalog/reindex`), plugins sync(`/api/plugins/sync/scan`) | `X-Scan-Token` | `SCHEDULE_SCAN_TOKEN` 과 `timingSafeEqualString` 비교. 설정돼 있지 않으면 503 으로 답하고, 거부된 token 은 셋 모두에서 경고를 로그에 남긴다 |

**하나의 token 이 세 틱을 모두 연다.** 세 endpoint 전체에 쓰기 권한을 주는 배포 credential이다. CronJob 이 어떤 schedule 이
도래했는지 물을 수 있게 해 주는 그 문자열이 plugins sync 도 실행하고, 그 sync 는 두 레지스트리
skill 과 MCP 서버. 를 모두 쓴다. 저장소가 선언한 이름을 채택하고 provenance 를 그것으로 다시
쓴다. 그것은 프로브가 아니라 쓰기 자격 증명으로 범위를 잡고 회전시켜라.

trigger 시크릿은 활성화 플래그를 읽기 **전에** 비교된다. 비활성 trigger 가 틀린 시크릿에 활성
trigger 와 다르게 답할 수 없게 하기 위해서다. 그 차이는 어떤 trigger 가 존재하는지에 대한
오라클이다.

상수 시간 비교는 소유자가 하나, `src/shared/timingSafe.ts` 이고
`tests/architecture.test.ts` 가 고정한다.

리플레이 억제는 Slack `event_id`, Telegram의 project·bot·`update_id`,
Teams의 project·App ID·conversation·activity ID를 키로 한 조건부 claim을 사용한다.
완료 claim은 중복을 막고, 실패 또는 만료된 처리 lease는 재전달 시 다시 claim할 수 있다.
ACK 후 실행하는 과정과 외부 도구 효과를 하나의 transaction으로 묶지는 않으므로
end-to-end exactly-once를 보장하지 않는다. 플랫폼이 재전달하지 않으면 유실 이벤트를
스스로 복구하는 worker도 없다. Project webhook의 멱등 계약은 [Trigger 설계](design/triggers.md)를 따른다.

## 인바운드 요청 크기

JSON 본문은 schema 검증 전에 bounded reader를 지난다. 관리·편집 요청은 Skill 전체 파일 한도에서
파생한 editor 한도, 이미지·문서를 실을 수 있는 실행 요청은 attachment 한도에서 파생한 turn
한도를 쓴다. 모델 등록은 editor 한도를 사용한다. webhook 네 종류는 서명 검증에 필요한 raw
본문을 공통 1MB 한도 아래에서 읽는다. 선언된 `Content-Length`가 한도를 넘으면 body를 읽지 않고
413을 답하고, chunked body는 누적 바이트가 한도를 넘는 즉시 stream을 취소한다.
256KiB prose allowance를 넘는 큰 실행 본문은 프로세스 단위의 **바이트 예산**에 과금된다.
예산은 최대 turn 본문 두 개 분량이고, 요청은 자기가 실제로 읽은 바이트만큼만 쓴다. 과금은
파싱부터 run 또는 stream이 입력을 놓을 때까지 유지되고, 연결에서 분리되어 계속 도는 chat은
내부 drain 완료까지 유지한다. 일반 text turn은 아무것도 쓰지 않는다. 예산이 모자라면 body를
취소한 뒤 `Retry-After`를 포함한 429를 답한다.

예산은 요청 수가 아니라 메모리에 유지하는 큰 본문의 바이트를 센다.
정확한 상한과 소유 파일은 [고정 제한](CONFIGURATION.md#코드에-고정된-제한)을 따른다.

`tests/architecture.test.ts`는 API route의 직접 `request.json()`과 `request.formData()` 호출을
거부한다. Zod의 필드 크기 검사는 파싱 뒤의 값 규칙이지, 파싱 전에 발생하는 메모리 할당 제한이
아니다.

## Session mutation과 CSRF

Cookie session으로 인증하는 `POST`·`PUT`·`PATCH`·`DELETE`는 `Origin`이 request origin 또는
설정된 `PUBLIC_BASE_URL` origin과 정확히 같아야 한다. Origin이 없거나 `null`이거나 URL로
해석되지 않으면 403이다. 세 session wrapper가 일반 console API를 한 번에 보호하고, project
실행 API는 bearer project token을 먼저 검증한 뒤 cookie session으로 fallback할 때 같은 검사를
적용한다. bearer token, webhook signature처럼 cookie를 쓰지 않는 머신 호출에는 CSRF
검사를 적용하지 않는다.

리버스 프록시 밖의 origin과 앱이 보는 request origin이 다르면 `PUBLIC_BASE_URL`을 반드시
설정하라. 이 값은 외부 callback URL뿐 아니라 어떤 browser origin이 session cookie를 쓸 수
있는지 결정한다.

## 응답 헤더

[`next.config.ts`](../next.config.ts)는 일반 경로에 framing 차단 CSP,
`X-Frame-Options: DENY`, `nosniff`, `strict-origin-when-cross-origin`을 적용한다.
일반 콘솔에는 script/style의 로드를 제한하는 CSP가 없으므로 이 정책이 script injection까지
차단한다고 보지 않는다.

`/api/artifacts/{id}/view`와 `/api/objects/*`는 이 규칙에서 제외하고 각 route가 자체 sandbox
정책을 설정한다. 오류 응답에도 헤더가 필요하다. 라우트의 CSP를 바꿀 때는 전역 헤더가
덮어쓰지 않는지 실제 응답을 확인한다. 파일별 정책은 [데이터 노출과 보존](#데이터-노출과-보존)을 따른다.

## 아웃바운드 요청 (SSRF)

운영자가 등록한 MCP 서버 URL은 `src/infrastructure/net/ssrfGuard.ts`가
**등록 시점과 디스패치 시점 모두** 에서 검증한다. 거부되는 것: `http(s)` 가 아닌 스킴,
userinfo 를 실은 URL(`https://user:pass@host`, 주소 안의 자격 증명은 여기서 무언가를 인증하는
방식이 아니고, 호스트를 다른 것처럼 읽히게 만드는 상투적 수단이다), 그리고
사설·루프백·링크로컬(클라우드 메타데이터 주소 `169.254.169.254` 포함) 또는 그 밖의 예약 대역으로
해석되는 호스트.

IPv6 는 주소 하나에 철자가 여럿이므로, 텍스트가 아니라 8개 그룹으로 펼친 값으로 판정한다.
IPv4 를 안에 담는 접두사(IPv4-mapped, IPv4-compatible, NAT64 `64:ff9b::/96`, 6to4
`2002::/16`)는 통째로 막지 않고 **담긴 IPv4 로** 판정한다 — IPv6 전용 망에서 공인 주소에
닿는 정상 경로가 그것이기 때문이다. `64:ff9b::8.8.8.8` 은 통과하고 `64:ff9b::10.0.0.1` 은
거부된다.

이 registry의 공개 주소 디스패치는 `fetchPublicUrl`(`src/infrastructure/net/publicFetch.ts`)을 지난다.
배포가 지정한 LLM·인증·스토리지·카탈로그 endpoint까지 모두 이 가드로 검사하는 것은 아니다.
그 주소들은 배포 설정의 신뢰 경계다. 공개 registry 요청에는 다음 검사를 적용한다:

- DNS 는 **모든 요청과 모든 리다이렉트 홉마다** 다시 해석하고 다시 확인한다. 등록과 사용
  사이의 DNS 리바인딩 창을 (완전히 닫지는 못하지만) 좁힌다.
- 커넥션은 확인된 주소에 고정된다.
- 네이티브 리다이렉트 추종은 꺼져 있고 **교차 출처 리다이렉트는 거부한다**. 저장된 자격 증명이
  다른 호스트로 전달될 수 없게 하기 위해서다.
- 디스패처는 커넥션 재사용을 위해 `origin|pinned address` 별로 풀링된다. 이것이 캐시하는 것은
  **전송 계층뿐** 이다. 가드는 여전히 요청마다 돌기 때문에, 사설 주소로 해석되기 시작한
  호스트는 풀링된 디스패처에 닿기 전에 거부되고, 다른 곳으로 해석되는 호스트는 다른 키를
  받는다.

**모델 입력의 이미지는 URL로 가져가지 않는다.** 실행 API는 지원하는 이미지
바이트를 요청 안에 인라인으로 받으며, LLM 채널은 모든 `image_url`이 bounded `data:` URL인지
마지막으로 다시 확인한다. `https://`만 검사한 뒤 원격 URL을 제공자에게 그대로 넘기면 요청은 이
앱이 아니라 제공자 네트워크에서 발생한다. 그 경로에는 `fetchPublicUrl`의 DNS·주소·redirect
검사가 닿지 않으므로 허용하지 않는다. 모델이 웹의 이미지를 읽어야 하면 `FetchUrl` 도구가 이
앱의 아웃바운드 경계로 바이트를 가져와 같은 inline 형식으로 돌려준다.

공개 URL 이면 무엇이든 허용된다. 신뢰하는 엔드포인트만 등록하라. Registry endpoint URL 은
query parameter 와 fragment 를 받지 않는다. 둘은 멤버가 읽는 registry view 와 운영 로그에서
자격 증명을 노출하기 쉬우므로, 인증 정보는 encrypted header 또는 OAuth 연결에 둔다. 이전 행에
남은 query 와 fragment 는 dispatch 에만 쓰이고 reader-facing view 에서는 제거한다. 이 규칙은
**주소가 실제로 바뀔 때만** 적용한다. 저장된 주소를 그대로, 또는 콘솔이 보여 준 redacted 형태로
되돌려 보내는 저장은 이동이 아니므로 거절하지도, 저장된 credential 을 버리지도 않는다
(`resolveRegistryUrlPatch`). 그러지 않으면 편집 폼이 자기가 읽은 값을 되돌려 보내는 것만으로
레거시 항목이 다른 endpoint 를 가리키게 되고, 원래 주소는 다시 입력할 수도 없다.
LLM 채널도 endpoint 와 credential 을 한 보안 단위로 취급한다. 기본 채널의 URL 또는 provider
채널의 URL·인증 방식을 바꾸면 마스킹된 기존 key 를 새 주소로 옮기지 않고 새 key 입력을 요구한다.
기본 URL override 와 key override 를 함께 비우는 것은 둘 다 env 쌍으로 되돌리는 명시적 예외다.

MCP 클라이언트는 `@modelcontextprotocol/client` 위에서 돌고, 가드는 그 옆에 놓이는 대신 그 안으로
**주입된다**. 트랜스포트에 `fetch` 로 주어지는 것이
`boundedFetch`(`src/infrastructure/mcp/session.ts`)이므로 프로브, 핸드셰이크, 모든 도구 호출,
세션 해제까지 전부 같은 경계를 지난다. SDK 를 자기 `fetch` 에 맡겨 두면 운영자가 넣은 URL 을
곧장 네트워크로 가져갈 것이다. 같은 래퍼가 응답 바이트 상한도 함께 나르는데, SDK 에는 그런 개념
자체가 없다.

### 선언된 내부 호스트

클러스터에서 이 앱이 부르기로 *되어 있는* MCP 서버들은 구조상 사설이다. Kubernetes Service 는
가드가 거부하는 ClusterIP 로 해석된다. `MCP_INTERNAL_HOST_SUFFIXES` 는 배포가 그 이름들이
무엇인지 밝히는 방법이다:

```
MCP_INTERNAL_HOST_SUFFIXES=agent-mcps.svc.cluster.local
```

로컬 앱의 MCP를 연결하려면 `localhost`를 명시적으로 추가한다. 예를 들어
`MCP_INTERNAL_HOST_SUFFIXES=agent-mcps.svc.cluster.local,localhost`는
`http://localhost:3100/api/organizations/opspresso/mcp`를 허용한다. `localhost`는 정확히
그 호스트만 허용하며 하위 도메인과 IP 주소는 포함하지 않는다. 기본값은 계속 차단이며,
이 MCP 설정을 추가해도 모델의 `FetchUrl` 허용 목록은 바뀌지 않는다.

선언된 접미사 아래의 호스트는 그 질문이 던져지는 모든 곳에서 public URL 가드를 건너뛴다.
항목을 등록할 때와 편집할 때, 콘솔의 "Test connection" 프로브, admin 이 항목의 OAuth 메타데이터를
읽을 때, project 자신의 도구 목록, 그리고 디스패치. 각각 `skipsUrlGuard` 를 통해서다. **차단된
주소 대역이 넓어지는 것은 아니다**. 다른 모든 항목은 여전히 원래 받던 검사를 받는다. 이것은
가드를 느슨하게 하는 것이 아니라 managed 루프백 옆에 놓인 두 번째 좁은 예외다.

내부 주소 예외도 자동 redirect 추종은 허용하지 않는다. MCP 세션·OAuth 메타데이터·내부
`FetchUrl`은 `src/infrastructure/net/redirectPolicy.ts`의 `fetchSameOrigin`을 통해 최대 5회만
같은 출처로 이동한다. 공개 URL도 같은 redirect 규칙을 사용하며, 각 요청 직전에 DNS를 검증하고
확인된 주소로 연결한다. 다른 출처로 이동하는 응답은 본문을 해제한 뒤 거부한다.

이름을 맞추는 술어는 하나다. `src/domain/security/internalHosts.ts` 의
`isDeclaredInternalHost`. 그리고 목록은 둘이다. `MCP_INTERNAL_HOST_SUFFIXES` 는 이 앱이
부르기로 되어 있는 서비스를, [`URL_FETCH_INTERNAL_HOST_SUFFIXES`](#모델이-고른-url) 는 모델이
읽어도 되는 페이지를 말하고, 두 목록은 의도적으로 서로를 모른다. 술어가 domain 의 중립 모듈에
있는 이유가 그것이다: `skipsUrlGuard`(MCP 쪽, provenance 와 합친 형태) 옆에 두면 `FetchUrl`
리더가 MCP 모듈을 import 하게 되는데, 그 리더는 MCP 목록을 읽어서는 안 된다.

그 좁음이 설계의 전부이고, 각 부분은 `tests/internalHosts.test.ts` 가 고정한다:

- **설정으로만.** 목록은 환경에서 온다. 레지스트리 항목이 자기 예외를 스스로 지정할 수 없고,
  의도적으로 런타임 설정이 *아니다*. 아웃바운드 경계를 넓히는 일은 그때 admin 을 쥔 사람이
  제출하는 폼이 아니라 배포를 거쳐야 한다.
- **레이블 단위로 고정.** `agent-mcps.svc.cluster.local` 은
  `mcp-url-fetch.agent-mcps.svc.cluster.local` 을 허용하고 `evil-agent-mcps.svc.cluster.local`
  은 거부한다. 단순한 "…로 끝난다"였다면 통과시켰을 아슬아슬한 경우다. 앞에 붙은 점은
  허용되며 같은 뜻이다.
- **단일 레이블 접미사는 없다.** `local` 이나 `internal` 은 이름 공간 하나를 통째로 허용하게
  된다. 의도라기보다 오타일 가능성이 훨씬 높으므로 존중하지 않는다. 명시한 `localhost`만
  정확한 호스트 일치로 허용하며, 접미사로 확장하지 않는다.
- **IP 리터럴은 결코 안 된다.** 그 예외는 누군가 게시한 이름을 위한 것이다. 주소에는 맞출 이름이
  없으므로, 사설 주소는 여전히 provenance 로 자기 길을 얻어야 한다.
- **`http(s)` 만**, 그리고 userinfo 로 호스트 검사를 지나쳐 접미사를 밀반입할 수 없다.

그 대가: 그 접미사 아래의 호스트는 admin 이 저장할 수 있는 어떤 URL 로도 도달 가능해지고, 그것이
바로 가드가 평소에 없애는 능력이다. 그 서버들을 실제로 돌리는 네임스페이스만큼 접미사를
구체적으로 유지하라.

### managed 루프백 예외

managed MCP 서버(`runtime: "managed"`)는 이 앱이 자기 호스트에서 직접 띄운 컨테이너이고
`127.0.0.1:<port>` 로 닿는다. 운영자가 타이핑한 것이라면 가드가 정확히 거부할 주소다. 신뢰는
대신 **provenance** 에 놓인다. 프로비저너가 포트를 바인딩한 뒤 그 주소를 기록했다.

`isManagedLoopback`(`src/domain/mcp/types.ts`)이 이 우회가 적용되는지를 결정하는 유일한
자리이고, 의도적으로 좁다. 항목은 `managed` 를 주장해야 하고 **그리고** 리터럴 루프백 주소를
지녀야 한다:

- `127.0.0.1` 로 해석되는 호스트명은 거부된다. 확인과 요청 사이에 다른 곳으로 해석될 수 있다.
- 루프백을 가리키는 `remote` 항목은 거부된다. 그 주소는 타이핑된 것이다.
- 레지스트리는 managed 항목의 URL 을 옮기기를 거부한다.
- 라이프사이클 use case 는 프로비저너가 보고하더라도 루프백이 아닌 주소를 저장하기를 거부하고,
  그것이 지목한 컨테이너를 정지시킨다. 정지까지 실패하면 원래 거부와 cleanup 실패를 함께
  드러내며 컨테이너가 정리됐다고 주장하지 않는다.

프로비저너는 이미지 레퍼런스, 포트, 그리고 선택적인 **argv 배열** 을 받는다. 셸 명령은 결코 받지
않는다. 유일한 런타임인 Docker 프로비저너(`MANAGED_MCP_RUNTIME=docker`,
`src/infrastructure/mcp/dockerProvisioner.ts`)는 argv 를 `execFile` 로 Docker CLI 에 배열째
넘기고, 구조적으로 쓰이는 값. 이름(`MANAGED_NAME`), 이미지 레퍼런스, 환경 키·값, argv,
endpoint path. 은
`src/domain/mcp/provisioner.ts`의 패턴으로 API 입력과 Docker 실행 양쪽에서 검사한다. 항목을
편집할 수 있는 운영자가 그것으로 호스트에서 임의 코드를 돌릴 수는 없어야 한다. 호스트 파일
경로는 입력으로 받지 않으며, 저장된 환경 값만 프로세스가 만든 0600 임시 env file 로 전달한다.

컨테이너는 각각 메모리와 memory+swap을 모두 512MiB, CPU 1개, PID 256개로 제한하고 Linux
capability를 모두 버리며 `no-new-privileges`로 실행된다. root filesystem은 read-only이고
`/tmp`만 `noexec,nosuid` 64MiB tmpfs로 쓸 수 있다. 따라서 managed image는 영속 로컬 쓰기를
가정하면 안 된다. 한 호스트에는 managed 항목을 8개까지만 만들 수 있고 서로 다른 이름의 동시
생성도 count-then-create 구간에서 직렬화된다. 기존 항목의 restart·reconcile은 이 상한 때문에
막히지 않는다.

### MCP 서버가 호출자에 대해 듣는 것

`application/mcpMetadataHeaders.ts`가 저장된 예약 header를 제거하고 확인한 신원을 붙인다.
다른 대소문자 표기도 같은 이름으로 취급하며 OAuth 가용성 검사 전에 제거한다.
사용자가 정적 header를 저장해 다른 사람·프로젝트·대화를 사칭할 수 없다.

| Header | 의미·범위 |
|---|---|
| `X-Tenant-Id` | 실행 Project 이름. 프로젝트별 도구 목록과 discovery cache를 구분한다 |
| `X-User-Email` | user·project-token의 정규화 이메일 또는 Slack이 확인한 이메일. 신원 cache key에 포함한다 |
| `X-Conversation-Id` | 대화 주소. 요청의 context header이며 discovery cache key에 포함하지 않는다 |

이메일은 MCP discovery부터 평문으로 전송하며 PII 필터가 가리지 않는다.
서버 등록은 사용자 이메일과 복원된 도구 인자 공개를 포함하는 신뢰 결정이다.
이 header만으로 인증되지 않으며 서버는 별도 Bearer·OAuth grant와 함께 위임 신원을 검증해야 한다.

registry Test와 프로젝트 도구 조회는 요청 사용자 email을 전송한다.
카탈로그·managed health probe에는 사용자·대화가 없다.
프로젝트 도구 조회는 OAuth와 override를 사용하지만 tenant header는 보내지 않는 현재 차이가 있다.
따라서 tenant마다 도구 목록이 다른 서버에서는 probe와 런의 목록이 다를 수 있다.

API 대화 주소의 caller 부분은 배포 키로 만든 digest다.
이메일의 평문 hash가 아니지만 동일 사용자를 연결할 수 있는 가명이지 익명화는 아니다.
메신저·Chat의 주소 형식은 [관측성 설계](design/observability.md#사용량과-비용-귀속)를 따른다.
firing이나 대화 ID 없는 요청은 대화 header를 보내지 않는다.

### 모델이 고른 URL

위의 모든 것은 **운영자가 등록한** 주소에 관한 것이고, 거기서는 등록 시 검증이 첫 번째 통제이며
디스패치 시 확인이 두 번째다. 그 사이의 창을 닫는 것이 아니라 좁힌다. `FetchUrl` 빌트인에는
첫 번째 통제가 없다. 주소를 지목하는 것은 모델이고, 모델은 자기가 읽는 텍스트에 설득당한다.
`src/infrastructure/net/httpResource.ts` 가 그런 주소를 요청하는 유일한 자리이며, 그 규칙들은
심층 방어가 아니라 하중을 지고 있다:

- **MCP 의 내부 호스트 예외는 결코 참조하지 않는다.** `MCP_INTERNAL_HOST_SUFFIXES` 는 이 앱이 자기
  클러스터의 MCP 서비스에 닿을 수 있게 하려고 존재한다. 여기서 그것을 존중하면 프롬프트 인젝션
  하나가 `http://mcp-argocd.agent-mcps.svc.cluster.local/` 을 읽는 일로 바뀐다. 어댑터가
  `skipsUrlGuard` 를 import 하거나 그 목록·`process.env`·`lib/config` 에 닿기만 해도
  `tests/architecture.test.ts` 가 실패한다.
- **자기 목록은 따로 있다. `URL_FETCH_INTERNAL_HOST_SUFFIXES`.** 사내 위키나 내부 API 가
  구조상 사설 주소인 설치형 네트워크를 위한 것이고, composition root 가 주입하며 배포로만
  넓어진다. 그 접미사 아래의 호스트(`isDeclaredInternalHost`, 같은 술어, 같은 주의: 레이블
  경계, 단일 레이블 거부, IP 리터럴 거부, `http(s)` 만)는 **주소 가드 없이** 요청되지만, 나머지는
  그대로다: 같은 15초 타임아웃, 같은 두 헤더, 같은 리다이렉트 상한(5)이고, 리다이렉트는
  네이티브 추종 없이 홉마다 확인되어 **선언된 집합을 벗어나거나 출발 origin 을 벗어나면
  거부된다**. 예외가 리다이렉트 한 번으로 넓어져서는 안 되는 유일한 것이기 때문이다. 빈
  목록(기본)은 모든 모델 선택 URL 이 가드를 마주한다는 뜻이다. 그 대가는 MCP 목록의 것과
  같다: 접미사 아래의 모든 페이지가 프롬프트 인젝션 하나로 읽힌다. 정말로 모델이 읽어도 되는
  존만큼 좁게 선언하라.
- **아무것도 인증하지 않는다.** 테넌트 헤더 없음, MCP OAuth token 없음, Slack token 없음,
  호출자 헤더 전달 없음. 항상 GET 이고 본문은 결코 없다. 교차 출처 리다이렉트는 애초에 붙지
  않은 것을 전달할 수 없고. `fetchPublicUrl` 이 어차피 그것을 거부한다.
- **거부는 일반화된다.** `PublicFetchError` 는 자기가 거부한 호스트를 지목한다. 그것을 모델에게
  건네면 도구가 어떤 내부 이름이 존재하는지에 대한 오라클이 된다. 호출자는 "그 주소는 여기서
  도달할 수 없다"를 받고, 상세는 origin 만 로그로 간다. URL 자체가 자격 증명인 경우가 많다.
- **런당 제한된다.** `MAX_URL_FETCHES_PER_RUN`(20)은 요청의 *개수* 를 제한하는데, 다른 어떤
  예산도 그렇게 하지 않는다. "많은 요청, 전부 실패"는 네트워크 스윕이 취하는 모양이다.
- **기본은 꺼짐.** Agent가 `parameters.urlFetch` 로 옵트인한다. 그 capability 는 주입된
  의존성에서 파생되므로 Playground 프리뷰와 런이 서로 어긋날 수 없다.

**이것이 막지 못하는 것.** 공개돼 있지만 민감한 호스트. 파드의 이그레스 주소를 신뢰하는 IP
허용목록 기반 SaaS. 는 가드를 통과한다. 유출도 마찬가지다. `https://attacker.example/?leak=…`
을 요청하도록 설득당한 모델은 평범한 아웃바운드 요청을 하는 것이고, PII 필터링은 도움이 되지
않는다. fetch 에는 *복원된* 인자가 필요하기 때문이다(마스킹된 URL 은 해석되지 않는다). 이것은
아래에서 MCP 도구 인자에 대해 이미 말한 것과 같은 한계다. 차이는 URL 이 마찰이 더 적은 통로라는
점이다.

이 HTTP 요청은 앱 프로세스에서 수행한다. SSRF 가드와 별개로 배포의 egress 정책을 적용하고,
허용한 내부 페이지와 IP 기반 신뢰 서비스가 모델에 노출될 수 있음을 고려한다.

## MCP OAuth

관리자는 registry에 OAuth 메타데이터와 선택적 공유 client를 등록하고,
프로젝트별 connection은 사용자 grant를 보관한다.
실행 경로는 well-known 문서를 다시 읽지 않고 저장된 계약으로 token을 해석한다.
발견·연결·callback의 HTTP 형태는 [API](API.md#mcp-oauth), refresh 수명은
[MCP 설계](design/mcp.md#oauth)를 따른다.

### 메타데이터와 주소

protected-resource 문서는 MCP 주소의 401 challenge가 지정한 URL을 우선한다.
challenge가 없으면 well-known 후보를 읽는다. resource 문서는 그 MCP 항목의 내부 호스트
예외를 사용할 수 있지만, 문서가 지목한 authorization server까지 같은 예외를 주지는 않는다.
authorization·token·registration endpoint는 HTTPS와 URL 정책으로 검사한다.

resource identifier는 문서를 찾은 대상과 일치해야 한다. 제한된 예외는
`https://mcp.slack.com/mcp`가 공식 well-known 문서를 지목할 때
문서의 `resource: https://mcp.slack.com`을 허용하는 조합이다.
다른 origin·경로 조합으로 일반화하지 않는다.

authorization server는 RFC 8414 path-inserted, OpenID path-inserted, OpenID path-appended
순서로 발견한다. 경로를 가진 issuer에서 root 문서로 후퇴하지 않으며 문서의 issuer를 검증한다.
Google discovery는 광고 주소 `https://accounts.google.com/`에 대해 메타데이터의
`https://accounts.google.com`만 추가로 허용한다. callback의 `iss`에는 이 예외를 적용하지 않는다.
Entra의 common endpoint처럼 문서가 다른 tenant issuer를 돌려주면 일치 검사를 통과하지 못하므로
resource가 사용할 tenant issuer를 직접 광고해야 한다.

registry URL 변경은 이전 `auth`를 폐기한다. 새 주소의 Discover가 필요하며 이전 연결을 같은
이름이라는 이유로 재사용하지 않는다. OAuth 메타데이터와 공유 앱 저장은 읽은 auth에 대한
조건부 쓰기로 동시 변경을 보호한다.

### Client·인가·콜백

| 검사 | 구현 계약 |
|---|---|
| client 선택 | 기존 credential → 사용할 수 있는 Client ID Metadata Document → dynamic registration → 설정 오류 |
| PKCE | S256 필수. 광고하지 않는 서버는 기본 거절하며 배포의 `MCP_OAUTH_ALLOW_UNADVERTISED_PKCE`만 예외를 허용 |
| state | 일회용·10분 만료. verifier, client, issuer, resource와 redirect URI를 함께 보관 |
| redirect URI | 서버 공개 base의 고정 callback. Tools의 수동 값도 같은 주소여야 함 |
| resource | authorization과 token 요청에 대상 resource를 포함 |
| callback issuer | code 교환 전에 pending state의 issuer와 문자 그대로 비교. provider가 지원을 광고했는데 `iss`가 없으면 거절 |
| 오류 callback | issuer를 검증할 수 없는 응답의 `error_description`을 그대로 전달하지 않음 |
| callback 권한 | 현재 프로젝트 쓰기 권한과 client·resource를 다시 확인 |
| token endpoint 인증 | 등록한 인증 방식을 연결에 저장·사용. basic은 client ID와 secret을 form encoding 후 Base64. secret 없는 client는 `none` |
| 동적 등록 | `application_type: "web"`을 명시하고 token 요청과 같은 인증 방식으로 등록 |

등록 client credential은 발급 issuer에, token은 발급 당시 resource에 묶인다.
이 필드가 없는 연결이나 pending state를 현재 registry에 속한다고 추측하지 않는다.
새 연결이 필요하다고 알리고 grant 사용·인가 완료를 거절한다.

공유 앱은 `clientFromRegistry`와 Client ID를 기록하고 code 교환·refresh 때 현재 Secret을 읽는다.
Secret 회전은 기존 grant에 반영하지만 Client ID의 교체·제거는 기존 grant를 차단한다.
개별 동적 등록 Secret은 해당 프로젝트 connection에 보관한다.

### 공개 Client ID 문서

`/api/mcps/oauth/client-metadata/{project}`는 authorization server가 쿠키 없이 가져가는 문서다.
secret은 없고 client 이름·client ID URL·고정 redirect URI를 제공한다.
요청 Host 대신 설정된 공개 base로 주소를 만든다. 이 URL을 실제 client ID로 선택하는
인가 준비 단계에서 HTTPS·공개 도달 가능 조건을 확인한다.

project 존재 여부는 조회하지 않는다. 모르는 이름에도 문서를 제공하는 것이 인가를 만들지는 않으며,
실제 callback은 저장된 state·연결·프로젝트 권한을 요구한다.
공개 base가 없거나 provider가 가져갈 수 없는 주소면 metadata 방식 대신 지원되는 등록 경로를
사용하거나 설정 오류를 반환한다.

metadata client는 자기 호스팅 URL이므로 등록 client와 달리 issuer 변경 때 client ID 자체를
폐기할 필요는 없다. 다만 grant의 issuer·resource 검사는 그대로 적용한다.
배포의 공개 base가 달라지면 새 문서 주소로 갱신한다.

### 갱신과 dispatch

refresh 결과는 connection revision을 비교해 저장한다.
refresh token을 생략한 응답은 이전 값을 유지하고 새 값이 있으면 교체한다.
경쟁에서 진 요청은 원래 issuer·resource에 속한 connected 상태의 승자 grant만 사용한다.

인증 거절만 `needs_reauth`로 표시하고 5xx·timeout은 연결을 유지한다.
403 `insufficient_scope`는 그 요청의 typed challenge에서 scope를 얻어 재인가에 보탠다.
병렬 도구 호출의 결과를 세션 전체의 마지막 challenge로 해석하지 않는다.

token은 registry·Agent header보다 우선하는 마지막 credential이다.
grant를 사용할 수 없어도 별도의 정적 credential이 있으면 서버를 호출할 수 있고,
인증할 방법이 없으면 warning과 함께 제외한다.
예약 신원 header는 credential로 계산하지 않는다.

## Workspace와 코딩 작업

Workspace는 chat 소유자에게만 공개되며 실행·승인은 현재 프로젝트 접근도 다시 확인한다.
Workspace 설정 쓰기는 프로젝트 소유자·관리자에게 한정하고 revision 조건과 프로젝트 수명 경계로 보호한다.
Agent의 도구 활성화는 해당 프로젝트에서 서버 GitHub 계정을 정책 범위 내 사용하는 것을 허용한다.
Runtime 모델 선택은 관리자에게 한정하며 도구를 끄면 새 실행·Git 승인을 거절한다.
등록 저장소·정확한 소유자 허용은 DB에서 현재 값을 읽으며 일반 Agent가 수정하지 않는다.
소유자 허용은 해당 계정의 향후 저장소도 포함하므로 관리 화면에서 그 범위를 명시한다. 조회 실패는
접근을 거절하고 `selected`의 빈 목록은 모든 Git 대상을 차단한다. `all`은 서버 GitHub 권한
안에서 모든 저장소를 허용한다. `new`의 자동 등록은 서버의 실제 생성 성공에만 적용하고 MCP 결과나
모델이 주장한 생성 사실·시각을 권한 근거로 사용하지 않는다. 생성 receipt와 등록은 원자적으로 저장하며
불명확한 생성은 반복하지 않는다. 저장소 정책은 Sandbox 자원·네트워크나
서버 GitHub 자격증명, 개별 게시 승인을 변경하지 않는다. 변경은 `settings.update` 감사에 기록한다.
Sandbox에는 호스트 mount, Docker socket, 배포 자격증명과 장기 Git 자격증명을 전달하지 않는다.
Git 메타데이터는 root 소유로 두고 Agent의 실행 계정은 작업 파일만 수정한다.
GitHub App의 private key는 서버에 남고 clone/push에 발행하는 token은 저장소·권한·만료가 제한된다.
계정 토큰 모드는 서버의 임시 bare Git 저장소에서 인증하고 Sandbox에는 자격증명 없는 bundle만
전달한다. 서버에서는 저장소 checkout·hook·build script를 실행하지 않는다.
공개 Git endpoint는 HTTPS와 DNS pinning을 사용하고 내부 호스트 예외는 배포의 별도 목록을 따른다.

효과는 검토한 tree/HEAD와 사용자 결정에 묶인 승인 레코드를 먼저 claim한 뒤 실행한다.
종료·삭제가 먼저 기록되면 pending/실행 claim을 거절한다. 종료된 Workspace의 새 Git 검토는
소유자·살아 있는 Chat·프로젝트와 action lease를 원자적으로 확인한 뒤 복원하며 삭제는 되돌리지 않는다.
main 병합은 PR 소유 범위와 CI를
재확인하고 GitHub의 정확한 head SHA 조건을 사용한다. 배포는 허용된 main workflow와
승인한 inputs로만 요청한다. 전송 오류 이후의 불확실한 효과는 자동 재실행하지 않는다.
main 직접 푸시는 검토한 main SHA와 게시된 작업 HEAD를 대조하고 `force: false`로 실행한다.
검사 미보고는 `none`으로 승인 화면에 표시하고, 대기 중·실패한 검사와 구분한다. 모든 main 반영은
GitHub 브랜치 규칙을 따르며 권한·보호 규칙을 우회하는 옵션을 제공하지 않는다.
`/api/workspaces/github/webhook`은 서명과 delivery ID로 PR 메타데이터만 갱신하며 승인 권한이 없다.
프로젝트 Trigger인 `/api/webhook/{project}`는 별도 프로젝트 시크릿으로 실행을 시작한다.
관리자가 `githubReview`를 활성화하면 서명된 PR 이벤트에 대해 설치의 GitHub 연결로 리뷰 댓글을
게시할 수 있다. 공유 자격 증명 위임 설정은 관리자만 변경하며, 접근 가능한 저장소 전체 또는
명시적 저장소 목록으로 한정한다. PR의 본문·URL이 게시 목적지를 결정하지 않는다. 공급자 API가
확인한 base repository·PR 번호·commit_id에 COMMENT만 게시하고 모델에는 Skill 읽기만 제공한다.
프로젝트 Webhook Secret은 선택 범위의 리뷰를 요청할 권한이므로 승인한 GitHub 저장소에만 등록한다.
Webhook·Schedule·메신저·project-token actor에는 user 전용 Workspace 빌트인을 제공하지 않는다.
승인·CI 결과의 Chat 재개는 원래 소유자·프로젝트 접근·Workspace 선택과 SDK Session을 다시 확인한다.
그 결과 이벤트는 새 사용자 요청이나 다음 Git 동작에 대한 승인으로 취급하지 않는다.

## SDK Session과 승인 상태

SDK Session 이력과 승인 대기 RunState는 `runtime_sessions`에 별도로 저장한다. 같은 배포의
`AES_ENCRYPTION_KEY`를 사용하며 대화 ID와 소유자를 인증 데이터에 묶은 암호문만 읽는다.
원문 상태에는 모델/도구 이력과 각 Agent의 PII 복원 매핑이 포함될 수 있다. DB 접근 권한과
암호화 키를 분리해 관리하고 백업·복구 시 같은 키를 유지하라.

승인은 Chat 소유자가 정확한 revision과 항목 ID를 지정한다. 동일 출처 session 변경 검사,
프로젝트 접근 재확인, 실행 lease와 Session CAS를 함께 적용한다. 승인 상태는 도구 실행 전에
pending에서 running으로 선점한다. 중복·낡은 결정, 변경된 설정과 연결은 거부하며 승인 후
중단된 실행은 자동으로 반복하지 않는다. 삭제 tombstone은 늦게 끝난 실행의 재생성을 막는다.

SDK tracing은 로컬 processor가 이름·시간·상태·사용량만 수집한다. SDK의 공개 exporter를
설치하지 않으며 원문 모델/도구 입력·출력과 credential을 native span으로 내보내지 않는다.
배포가 선택한 OTLP exporter와 실행 오류/경고 기록의 접근 범위는 기존 운영 정책을 따른다.

## PII 필터링, 그리고 그것이 멈추는 곳

`parameters.piiFiltering`은 Agent별 선택 기능이다. SDK 모델 요청의 텍스트와 system prompt에서
탐지한 값을 `[[PII:…]]`로 치환하고 표시할 응답에서 복원한다. 스트리밍의 토큰 경계와
하위 Agent의 치환 매핑도 유지한다. 소유 코드는 `application/llm/pii.ts`,
`runtime/model.ts`, `runtime/tools.ts`다.

| 경계 | 전달·보관하는 내용 |
|---|---|
| 텍스트 모델 요청·모델에 돌아가는 도구 결과 | 탐지한 PII를 치환한다 |
| MCP·FetchUrl·파일 생성/편집·Workspace 등 실제 도구 dispatch | 복원한 인자를 사용한다. 수신 시스템은 그 값을 본다 |
| Agent의 GenerateImage·EditImage prompt | 치환된 인자를 이미지 모델에 전달한다. 사용자에게 보이는 prompt는 복원한다 |
| 하위 Agent 요청 | 치환된 메시지와 필요한 매핑을 전달한다 |
| 사용자 응답·Chat 화면 기록·생성 파일 | 복원한 내용이다. 저장 익명화 기능이 아니다 |
| capability embedding·rerank | 최근 요청과 제한된 recall 문맥을 준비 단계에서 원문으로 보낸다 |
| 자동 Memory recall | 최신 요청을 연결된 MCP에 원문으로 보낸다. 회상 결과가 모델 prompt에 들어갈 때는 필터를 지난다 |
| MCP 신원 헤더 | 확인한 이메일 등 플랫폼 메타데이터를 평문으로 전달한다. 필터 대상이 아니다 |

이미지 bytes의 개인정보 제거는 보장하지 않는다.
일반적인 이름·이미지 속 개인정보·패턴에 맞지 않는 값도 탐지 대상이 아니다.
탐지 범위는 email, 전화번호, 한국 주민/외국인등록번호의 지원 형식, Luhn 검사를 통과한
13–19자리 결제 카드 번호다. 범용 DLP로 사용하지 않는다.

preview는 모델을 호출하지 않아도 recall·discovery를 수행할 수 있으며 조립한 원문을 보여준다.
준비 단계의 원문 전송이 허용되지 않는 환경에서는 해당 capability와 연결을 선택하지 않아야 한다.
외부 제공자가 동일한 계정인지와 무관하게 각 채널의 전송·보존 정책을 확인한다.

회상된 기억과 첨부·도구 결과는 신뢰할 수 없는 텍스트다. `rememberedBlock`은 기억을
`<recalled>` 경계와 인용문으로 감싸 지시와 구분하지만 prompt injection을 제거하지 않는다.
무엇을 기억하고 누가 검색할 수 있는지는 연결된 Memory 서버의 저장·권한 정책이 소유한다.

## 호출자 컨텍스트

`parameters.callerContext` 로 Agent별 옵트인. 켜져 있으면 Slack 런은 누가 묻고 있는지를 모델에게
알려 주고. 표시 이름, 시간대, 아바타의 URL. 한 스레드에 사람이 둘 이상이면 화자마다 라벨을
붙인다. Telegram 런과 Teams 런은 각자의 이벤트가 실어 오는 것으로 같은 일을 한다. 보낸 사람의
이름, 그리고 그 밖에는 아무것도 없다. 둘 다 시간대도 email 도 넘겨주지 않는다.

**이름은 `piiFiltering` 이 마스킹하지 않는 PII 다.** 그 패턴들은 email, 전화번호,
등록번호/카드 번호에 맞고 사람의 이름은 그 어느 것에도 맞지 않으므로, 호출자 블록이 싣는 것은
필터링이 켜져 있어도 쓰인 그대로 모델에 도달한다. 그래서 그 블록은 **email 을 싣지 않으며**,
그래서 이것이 기본 동작이 아니라 Agent별 옵트인이다. 켜는 것은 실제 사람의 이름을 프롬프트에,
그리고 제공자가 로깅하는 무엇에든 집어넣겠다는 결정이다.

옵트인은 모델에 넣을 이름·시간대·아바타를 위한 프로필 조회를 게이트한다. Slack 의 private
project 접근 검사와 artifact 소유자 식별에 필요한 email 조회는 옵트인과 독립적으로
`users.info` 를 호출할 수 있다. 그 email 은 모델의 caller 블록에 들어가지 않는다.
이름이 메시지와 함께 도착하는 Telegram 에서는 옵트인하지 않은 이름이 대화 트랜스크립트에 쓰이지도
않는다([데이터 노출과 보존](#데이터-노출과-보존) 참고). **transfer 는 호출자를
자식에게 실어 나르고**(`RunOrigin`), 거기서 자식 Agent 자신의 옵트인이 다시 결정한다. 그래서
이름은 몇 홉 떨어져 있든 그것을 요청한 Agent에만 도달하고, 소유자가 한 번도 옵트인하지 않은
project 는 그것을 결코 보지 않는다. 해석된 프로필은 워크스페이스별로 메모리에
캐시되고(1시간, 실패는 1분), 크기가 제한되며, 결코 영속되지 않는다.

**표시 이름은 공격자가 통제한다.** 누구나 자기 것을 무엇으로든 설정할 수 있고, 그것이 시스템
프롬프트에 실린다. 공유 스레드의 화자 라벨을 통해, 자기 대화만이 아니라 *다른 사람의* 대화
안에서. `callerFrom`(`src/domain/execution/actor.ts`)은 `RunCaller` 가 만들어지는 유일한
자리이고 따라서 그 이름을 안전하게 만드는 유일한 자리다. 제어 문자는 제거하고, 공백은 한 줄로
접고, 이름은 60자로 제한하며, 아바타는 `https:` URL 일 때만 받아들인다. 그것이 프롬프트
인젝션을 불가능하게 만들지는 않지만. 메시지 본문도 신뢰되지 않는다. 신원 메타데이터가 독자가
볼 수 없는 지시를 숨길 자리가 되는 것은 막는다.

## Slack 출력 알림

LLM 답변과 tool 결과는 Slack mrkdwn으로 전달되므로 텍스트 안의 mention token은 단순한 표시가
아니다. `<@U…>`는 사용자를, `<!subteam^…>`은 사용자 그룹을, `<!channel>`·`<!here>`·
`<!everyone>`은 넓은 청중을 실제로 알릴 수 있다. 그 텍스트는 질문·외부 문서·도구 결과에 의해
영향받으므로 알림 권한으로 취급하지 않는다.

`neutralizeSlackMentions`(`src/domain/slack/outboundText.ts`)가 알림 가능한 완전한 token만
escape한다. `slackClient`는 `chat.postMessage`, `chat.update`, 그리고 stream의 text/chunk 축을
Slack에 쓰기 직전에 모두 이 함수를 통과시킨다. 따라서 streaming 실패 뒤 edit로 물러나거나
마감 시 남은 답을 다시 보내는 경로도 같은 규칙을 받는다. 일반 Markdown, URL link, channel
reference, 알림을 만들지 않는 date token은 보존한다.

## Slack 워크스페이스 읽기

`parameters.slackWorkspace` 로 Agent별 옵트인. 켜져 있으면 런은 자기 project 의 봇이 설치된
워크스페이스의 채널 히스토리, 스레드, 사용자 이름을 읽을 수 있다.

**Project 는 공유 카탈로그다** (private project 라면 그 접근 범위 안에서). 따라서 project 를
실행할 수 있는 사람은 누구나 그 봇이 읽을 수 있는 것을 읽을 수 있다. 봇이 초대된 모든
채널이며, `groups:history` 가 적용되는 비공개 채널도 포함이다. 그것이 이것을 Slack 에 연결된 모든 project 가 갖는 capability 가 아니라 Agent별
옵트인으로 만든 이유 전부다. 켜는 것은 어떤 채널의 내용을 그 채널 자신의 멤버보다 더 넓은
사람들에게 닿게 하겠다는 결정이다.

두 가지는 빠뜨려서가 아니라 구조적으로 거부된다:

- **쓰기 없음.** `chat:write` 는 봇에게 부여돼 있고. 답장 전송에 필요하다. 의도적으로 어떤
  도구에서도 닿을 수 없다. 런은 자기가 쓰지 않은 텍스트에 조종된다. 글도 올릴 수 있는 런은,
  어떤 채널에 심어 둔 메시지가 봇으로 하여금 다른 곳에서 말하게 만들 수 있는 런이다.
- **email 은 모델에 도달하지 않는다.** `users:read.email` 이 부여돼 있는데도 그렇다.
  `SlackUser` 와 `SlackUsers` 는 이름, 직함, 시간대, 상태 문구, 아바타로 답한다. 동료가
  프로필을 클릭해서 보는 전부다. 주소는 결코 답하지 않는다. 그것은
  [호출자 컨텍스트](#호출자-컨텍스트)가 이미 적용하는 규칙이고, 이유도 같다. email 은 Slack 밖에서
  사람을 식별하며, 어떤 답도 잘 쓰이기 위해 그것을 필요로 하지 않는다.

  이메일은 private 프로젝트 접근 판정, MCP 위임 신원과 Artifact의 개인 귀속에 별도로 사용한다.
  Slack actor는 발신자의 Slack 사용자 ID다. `ownerEmail`을 해석해도 actor를 email로 바꾸거나
  개인 user tier 예산으로 다시 분류하지 않는다. `toUserDetail`은 이메일을 모델용 도구 결과에
  복사하지 않는다. 이 조회는 모델 표시 문맥을 제어하는 `callerContext`와 독립적이다.

*안으로* 실려 오는 것은 첨부된 문서와 똑같은 방식으로 신뢰되지 않는다. 채널의 메시지는 그 채널에
있는 누구든 쓴 것이고, 그것이 텍스트로 모델에 도달한다. PII 필터링은 다른 것과 마찬가지로 그
도구 결과에도 적용되며(`parameters.piiFiltering`), 턴별 도구 결과 예산이 그 크기를 제한한다.
트랜스크립트의 길이는 Slack 이 정하는 것이므로, 통째로 청구되는 대신 fit 을 거친다.

리더는 봇 token 을 쥐고 있고, 그것은 생성 시점에 바인딩된다. 워크스페이스를 지목하는 도구 인자는
모델이 워크스페이스를 고르게 만들 것이고, 그것이 올바른 모양인 요청은 없다.

## 첨부 문서

문서의 텍스트는 턴 안으로 들어가므로, **누구든 첨부할 수 있는 것은 무엇이든 말할 수 있다.**
Slack 채널에서 그것은 묻는 사람만이 아니다. 봇이 볼 수 있는 곳에 파일을 떨어뜨릴 수 있는
누구든이다.

이에 대해 하는 일: 모든 문서는 `framedDocument`(`src/application/llm/documentParts.ts`)가
감싸며, 파일의 이름을 밝히고 어디서 끝나는지를 표시하고 그 구간을 데이터로 다루고 결코 지시로
다루지 말라고 모델에게 말한다. 이름은 JSON 이스케이프되므로 조작된 파일명이 끝 표시를 위조할 수
없다.

**그것은 완화이지 해결이 아니다.** 어떤 문구도 주입된 텍스트를 안전하게 만들지 못하고, 메시지
본문은 이미 신뢰되지 않았다. agent 의 권한을 그에 맞춰 잡아라. 첨부를 읽는 agent 는 파일을 든
낯선 사람에게 주지 않을 권한을 쥐고 있어서는 안 된다.

알아 둘 만한 다른 속성들:

- **문서는 읽힐 뿐, 실행되거나 렌더링되지 않는다.** 추출은 텍스트만 내놓는다. HTML 은
  마크업과 활성 내용을 제거한 텍스트로 읽히며, 스크립트를 실행하거나 외부 리소스를 가져오지 않는다.
- **문서를 대신해 무언가를 가져오는 것은 없다.** 첨부 안의 URL 은 다른 것과 마찬가지로 텍스트일
  뿐이다. Agent가 바인딩한 도구만이 그것에 작용할 수 있고, 그 도구 자신의 가드 아래에서 그렇다.
- **텍스트는 PII 필터를 지난다.** Agent가 옵트인하면 턴의 나머지와 마찬가지이고, 한계도 같다
  (email, 전화번호, 한국 등록번호, 카드 번호, 이름은 아니다).
- **Chat은 원본과 추출문을 분리해 보관한다.** 턴당 최대 40,000자의 추출문과 파일 참조는
  소유자 전용 chat 행에 남고, 원본은 `source: attachment`인 artifact로 저장한다. 원본은
  기존 artifact와 같은 소유자·project owner·admin 읽기 정책, artifact 보존 기간과 오브젝트
  접근 모드를 따른다. 원본은 chat 삭제만으로 삭제되지 않으며 artifact 삭제·보존 정책이 소유한다.

## 데이터 노출과 보존

- Trace 는 **제한된 메타데이터만** 저장한다. 문자 수, token, 비용, 소요 시간, subagent 의
  trace id. 원본 프롬프트와 도구 결과는 영속되지 않지만, trace 의 `error` 와 `warnings` 는 실패
  텍스트를 그대로 최대 1,000자까지 보관하고, 제공자나 도구의 에러 문자열은 내용을 품을 수 있다.
- **런의 추론은 켠 Agent에서 복원된 채로 저장된다.** `parameters.reasoningTrace` 를 켠 Agent는
  assistant 메시지에 그 런의 사고를 남기는데(`AssistantChatMessage.reasoning`, 메시지당 최대
  40,000바이트), 그것은 `content` 와 같은 출처. 즉 **마스킹이 풀린** 텍스트다. PII 필터는
  *모델이 보는 것*을 제한하지 콘솔에 저장되는 것을 제한하지 않으므로(`content` 도 마찬가지다),
  `piiFiltering` 을 켠 Agent에서도 추론은 걸러지지 않은 채 chat 행에 앉는다. 추론은 요청을 모델
  자신의 말로 되풀이하는 자리라 입력이 실어 온 것을 그대로 품기 쉽다. 옵트인인 이유가 이것이고,
  보존 기간은 chat 행과 같다(`RETENTION.chatDays`).
- `/api/metrics` 는 project, 사용자, model 을 지목하지 않는다. 메트릭 라벨은 히스토그램의
  `le` 와 build 정보의 유한한 `version`·`stage`뿐이다.
- 로그 라인은 런의 correlation id 를 실을 뿐, 프롬프트 내용은 결코 싣지 않는다.
- Trace, usage 행, chat, trigger 배달 행은 모두 `expiresAt` 을 지니고
  schedule-scan 틱의 sweep 이 지운다. scan 호출이 없는 배포에서는 이 DB sweep이 실행되지 않는다.
  [OPERATIONS.md](OPERATIONS.md#행-보존) 참고.
- **메시징 파일 참조 기록**은 Slack·Telegram·Teams에서 대화·actor별로 생성 파일 ID와
  이름만 7일간 보관한다. URL이나 바이트는 기록하지 않는다. 최근 20개 기록, 기록당 20개
  파일, 런당 20,000자로 제한하며 참조를 얻어도 `File` 도구의 권한 검사를 통과해야 한다.
- **Telegram·Teams 대화 트랜스크립트** 는 project 의 봇과 주고받은 모든 턴의 *텍스트* 를 7일간
  보관한다. 대화별로 질문과 답을. 두 플랫폼 모두 히스토리를 돌려주지 않아 후속 질문이 그 앞의
  질문을 실어 날라야 하기 때문이다. 그것은 chat 메시지처럼 저장된 사용자 텍스트다. chat 과 달리
  그 대화의 다음 런 외에는 아무것도 그것을 읽지 않는다. 보낸 사람의 플랫폼 사용자 id(Telegram
  user id, Teams 는 Entra object id)는 턴 옆에 저장되고, 보낸 사람의 *이름* 은 Agent가 `callerContext` 에 옵트인했을 때만 저장되며, 옵트인을 끈
  Agent는 이전에 저장된 이름도 읽지 않는다. 행은 project 파티션에 있어 project 를 지우면 함께
  지워진다.
- **생성된 이미지** 는 `S3_BUCKET_NAME` 이 설정돼 있으면 추측할 수 없는 UUID 키 아래 저장되고,
  chat 행은 주소가 아니라 **오브젝트 키** 를 보관한다. 읽기 시점에 키가 주소가 되며, 수명은
  독자에 맞춰 고른다. chat 뷰에는 15분, 메시징 답변에 포함된 링크에는 7일(SigV4
  pre-sign 의 상한이고, proxied 토큰도 같은 값을 쓴다). 그 링크는 그것이 함께 온 답을 이미 읽을
  수 있던 청중이 쥔다(`src/shared/artifactUrlTtl.ts`). 주소의 *모양* 은
  `ARTIFACT_ACCESS_MODE` 가 정한다:
  - **`proxied`**. 스토어는 앱에게만 닿고 독자는 앱의 주소
    `PUBLIC_BASE_URL/api/objects/<key>?exp=<unix>&sig=<hmac>[&dl=<filename>]` 를 받는다
    (`src/infrastructure/storage/objectUrlToken.ts`). **그 라우트는 세션을 요구하지 않으며
    그것이 계약이다**: 주소를 쥐는 것은 `<img>` 태그와 Slack 메시지라 쿠키를
    낼 수 없다. 토큰이 자격 증명이다. 키·만료·파일명을 함께 덮는 HMAC-SHA256
    이고, 서명 키는 `AES_ENCRYPTION_KEY` 에서 HKDF(`agent-studio/object-url/v1`)로 파생되어 그
    바이트가 저장된 토큰을 암호화하는 바이트와 결코 같지 않다. 증명하는 것은 *이 배포가 이
    키에 대해 이 수명과 이 파일명으로 발행했다* 는 사실뿐이다. 파일명은 장식이 아니라 서명에
    묶여 있어 `dl` 을 떼어 다운로드를 인라인 보기로 바꿀 수 없고, 만료와 서명 불일치는 하나의
    403 으로 답한다(둘을 구별해 주면 위조자에게 어느 쪽을 고칠지 알려 준다). 없어진 오브젝트는
    404, 읽기는 `MAX_PROXIED_OBJECT_BYTES` 에서 끊기며, `Cache-Control: private` 의 max-age 는
    토큰의 남은 수명을 넘지 않는다. 바이트는 콘솔의 origin 에서 나가므로 브라우저가 문서로
    렌더할 수 있는 타입(HTML, SVG, 텍스트)은 `/view` 와 같은 `sandbox; default-src 'none'` 아래
    불투명 origin 에 놓이고, 래스터 이미지와 PDF 만 `frame-ancestors 'none'` 으로 끝난다.
    `next.config.ts` 가 이 주소를 콘솔 헤더에서 제외하는 이유가 그것이다.
  - **`authenticated`**. 스토어의 pre-signed URL. 스토어가 브라우저에서 닿아야 하고 버킷은
    비공개로 남는다.
  - **`public`**. 영구적인 직접 URL. 명시적인 공개 읽기 버킷 정책을 요구하고 URL 을 얻은
    누구에게나 바이트를 노출한다. 애플리케이션 인증은 여전히 갤러리 메타데이터와 삭제를
    보호하지만 오브젝트는 보호하지 않는다. **주소가 보기가 아니라 다운로드인 곳에서는 어쨌든
    미리 서명한다**. 브라우저가 저장할 파일 이름은 `ResponseContentDisposition` 이 실어
    나르는데 S3 는 익명 GET 에서 그것을 거부하므로, 서명되지 않은 링크는 오브젝트를 UUID 키로만
    저장할 수 있다.
  - 레거시 행은 공개 `url` 을 지니고 있을 수 있고 그대로 되읽힌다. 그것을 다시 쓴다고 해서 이미
    공개인 그 오브젝트들에 누가 닿을 수 있는지는 아무것도 바뀌지 않는다. 공개 노출 여부는 현재 bucket policy·ACL이 결정한다. 앱의 metadata나 access mode만 바꿔서는
    기존 객체를 비공개로 전환하지 못한다. 정책을 닫으면 옛 공개 URL도 더는 접근되지 않을 수 있다.
  - **페이지는 오브젝트 주소로 나가지 않는다.** `SAVABLE_TYPES` 에 포함된, 사람이 읽도록 만든
    artifact 만 `/view` 를 통해 앱이 바이트로 답한다. 서명한 오브젝트 URL 은 sandbox 헤더를 실을 수 없고,
    한 번 건네지면 그것을 연 사람의 권한보다 오래 살며, `public` 모드에서는 영구다. 임의의
    마크업이 실행되는 영구 주소는 저장소가 아니라 호스팅이다. `/view` 는 삭제와 같은 조건으로
    매 요청을 인가하고, `Content-Security-Policy` 의 `sandbox` 로 문서를 불투명 오리진에
    놓는다. HTML 원문은 별도의 iframe에만 들어가고 콘솔의 쿠키·스토리지·DOM에 닿지 못한다.
    `nosniff`와 `no-referrer`도 함께 적용한다.
  - **HTML은 미리보기를 여는 즉시 격리된 iframe에서 실행한다.** 원문을 선언된 charset으로 엄격하게
    디코딩하고, 전체 내용을 이스케이프한 `srcdoc` 속성으로 전달한다. 바깥 화면에는 제품의
    제어 코드만 실행되며, 원문 script·이벤트·canvas·SVG는 iframe 안에서 보존한다.
    HTTP CSP와 iframe 모두 `sandbox allow-scripts`를 적용하고 `allow-same-origin`,
    top-navigation, popup, form, download 권한을 주지 않는다. iframe을 제거하면 실행 상태를
    버리고, 다시 시작하면 원본을 새 iframe에 넣는다. 코드 오류나 상태를 저장 성공과 혼동하지 않는다.
  - **격리와 통신 제한의 범위를 구분한다.** HTML의 `INTERACTIVE_HTML_VIEW_POLICY`는
    fetch/XHR/WebSocket, 외부 script·CSS·image·font, worker, 외부 프레임 이동과 폼 제출을
    제한한다. `frame-src 'none'`은 inline srcdoc을 허용하면서 네트워크 frame 탐색을 막는다.
    내부 목차 링크는 기준 URL을 `about:srcdoc`으로 지정해 처리하며, `base-uri about:`으로
    외부 기준 URL을 거절한다. 카메라·마이크·위치 등은 Permissions Policy로 제한한다. 이 정책은 WebRTC 등 모든
    브라우저 통신이나 CPU·메모리를 강제 격리하지 않는다. 미리보기 열기는 HTML 코드 실행을 포함하므로 신뢰하는 파일을 다룬다는 전제로 사용한다. 완전한 무통신·자원 격리가 필요하면 별도의 실행 환경이 필요하다.
    iframe에서 보고한 오류는 현재 iframe의 Window를 확인한 뒤 고정 안내로만 표시한다.
    차단된 리소스와 외부 이동도 고정 안내로 표시하고, 스크립트 오류를 우선한다.
    오류 원문·주소를 부모 화면에 렌더하거나 서버로 보내지 않으며 특권 API·인증 정보는 전달하지 않는다.
  - **정적 view는 스크립트를 실행하지 않는다.** `ARTIFACT_VIEW_POLICY`에는 어떤 `allow-*`도
    붙이지 않는다. Markdown은 raw HTML을 텍스트로 내보내고, CSV는 이스케이프된 표,
    SVG는 `<img>`로 표시한다. HTML 실행 정책은 이 경로에 적용하지 않는다.
  - **전역 헤더와의 충돌을 검사한다.** `next.config.ts`는 자체 CSP를 사용하는 두 경로를 제외한다.
    새 파일 응답이나 정책 변경도 [응답 헤더](#응답-헤더)의 경계를 유지해야 한다.

  - **일반 런 Artifact의 object 만료는 저장소 정책이 담당한다.** 틱은 메타데이터 행을 지우며
    `artifacts/`의 bytes에는 별도 lifecycle을 적용한다. 비공개 `source-files/`는 worker가 파일별
    보존 기한을 검사하고 본문을 삭제 표식으로 교체하므로 같은 일괄 만료 규칙을 적용하지 않는다.
    [INSTALL.md](INSTALL.md#오디오-worker)의 저장소 정책을 따른다.
- **비공개 파일 Artifacts**는 같은 `S3_BUCKET_NAME`을 사용하지만 일반 object 접근 경로로 읽거나
  URL을 발급할 수 없다. `source-files/` 키는 일반 어댑터와 bearer URL 검증에서 거절하며,
  소유자·프로젝트·파일 상태·만료를 확인하는 다운로드·미리보기 경로만 사용한다.
  `public` 모드에서는 가져오기 전에 비공개 파일 쓰기를 거절한다. 실제 bucket policy와 ACL의
  익명 읽기 차단은 배포 환경이 소유한다.
- **Artifact 행** 은 런이 만들어 낸 모든 오브젝트를 지목하고, 그것이 저장된 이미지나 문서를
  나열하고 지울 수 있게 만드는 전부다. 언급할 만한 귀결이 셋 있다:
  - 행은 갤러리를 읽을 수 있게 하려고 **프롬프트의 500자 발췌** 를 보관한다. 그것은
    `ARTIFACT_RETENTION_DAYS` 동안 사는 사용자 텍스트이며, 그것을 실어 온 chat 메시지보다 오래
    남는다. PII 필터링은 *모델* 이 보는 것을 한정할 뿐, 저장되는 것을 한정하지 않는다.
  - project 의 artifact 탭은 그 project 의 소유자와 admin 이 읽을 수 있다. trace 가 쓰는 것과
    같은 규칙이고, 이유도 같다(다른 사람의 런타임 출력을 담고 있다). 실제로는 trace 보다 더 넓은
    노출이다. Agent trace는 항상 기록하고 기본 30일을 보관하지만, artifact 는 모든 오브젝트이고 180일을
    보관한다.
  - artifact 를 지우면 오브젝트를 먼저, 행을 나중에 지우므로 중단된 삭제는 재시도로 수렴한다.
    chat 메시지는 그 키의 사본을 자기 안에 갖고 있으므로 트랜스크립트는 그 뒤로 이미지를 사용할
    수 없음으로 렌더링한다. 확인 문구가 그 사실을 미리 말해 준다.

## 운영 노트

- **고쳐 쓰지 말고 회전시켜라.** 유출된 project token과 trigger 시크릿은 콘솔에서
  회전시킨다(`POST …/token`, `rotateSecret: true` 를 실은
  `PUT …/triggers/{id}`). 이전 값의 무효화 시점은 아래의 캐시 전파 범위를 따른다.
- **설정 전파는 즉시가 아니다.** 강등된 admin의 권한 변경는 그 쓰기를 처리하지 않은
  인스턴스에서 설정 캐시가 만료될 때까지 계속 동작한다(`SETTINGS_CACHE_TTL_MS`, 기본 5초).
  인스턴스 간 즉시 취소에는 공유 무효화 신호가 필요한데, 아직 없다. 쓰기를 처리한 인스턴스는
  캐시 세대를 쓰므로, 이미 진행 중이던 읽기가 무효화된 항목을 다시 채울 수 없다.
- **인증 rate limit 은 클라이언트 IP 로 키잉하고**, 프록시 뒤에서 그것은
  `TRUSTED_PROXY_CIDRS` 로 해석된다.
  [CONFIGURATION.md](CONFIGURATION.md#인증과-접근-제어) 참고. 프록시 둘 뒤에서
  그것을 비워 두면 모든 요청이 같은 홉으로 해석돼 하나의 공유 버킷에 떨어지므로, 리미터는
  남용자가 아니라 함대 전체를 조인다.
- **AWS 자격 증명은 AWS 를 쓰는 기능에만 필요하고**(Bedrock, AWS S3 자체), 역할이나 표준
  `AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY` 쌍으로 온다. MinIO 같은 S3 호환 스토어의
  자격 증명은 그것과 다른 `S3_ACCESS_KEY_ID`/`S3_SECRET_ACCESS_KEY` 쌍이다. 한 프로세스가 둘 다 쓸 수 있다. 키를 이미지에 굽지 마라.
- **`AES_ENCRYPTION_KEY` 를 회전하면 저장된 시크릿만이 아니라 proxied 오브젝트 주소도 전부
  무효가 된다**. 서명 키가 거기서 파생된다. 발급된 링크가 무효화되고 기존 credential·SDK Session·Workspace checkpoint도 새 키로는
  복호화할 수 없다. 키 교체만으로 기존 암호문을 다시 암호화하는 자동 이관은 제공하지 않는다.

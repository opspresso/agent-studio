# 마일스톤

Agent Studio는 프로젝트·버전 관리, LLM/에이전트 실행, Skills/MCP/외부 에이전트,
Slack/A2A 연동, 사용량 집계와 트레이스를 갖추고 있다. 이 문서는 구현 이력이 아니라
프로덕션 운영에 남은 작업만 우선순위대로 관리한다.

기반 정리는 끝났다. 레이어 경계는 `tests/architecture.test.ts`가 강제한다 — 규칙 전부
허용 목록이 비어 있고, 이름 붙인 불변식은 저마다 소유 파일이 하나씩 지정돼 사본이
생기면 실패한다. 아래 기능 작업은 그 위에 얹는다: 새 어댑터는 포트 뒤로 가고, 조립은
AGENTS.md가 명명한 wiring site에서만 하며(목록은 그쪽이 정본이다 — 여기 복제했던
사본은 한 번 낡았다), 새 실행 정책은 실행 파사드 한 곳
(`src/application/execution/runProject.ts`)에 붙는다.

**규약**

- 각 마일스톤은 **완료 조건**을 자동으로 확인할 수 있어야 한다. 확인 방법이 정해지지
  않은 작업은 마일스톤에 넣지 않는다.
- "한 곳에만 있다"는 완료 조건은 **테스트로 고정한다** — `tests/architecture.test.ts`의
  single-owner 불변식이 그 자리다. 서술로만 남은 단일 소유는 다음 진입점이 생길 때
  조용히 깨진다.
- **선행**이 있는 마일스톤은 선행이 끝나기 전에 착수하지 않는다.
- 완료된 마일스톤은 이 문서에서 제거한다. 이력은 git log와 태그별 GitHub Release
  (`.github/workflows/release.yml`가 커밋 목록으로 생성)가 source다.
- 식별자는 **재사용하지 않는 slug**를 쓴다. 완료된 마일스톤을 지우는 규약 때문에 번호는
  반드시 재사용되고, 실제로 `M4`는 세 가지 서로 다른 기능을 가리킨 이력이 있다
  (API Reference 탭 → 프로젝트별 MCP 헤더 오버라이드 → 비용 임계값). 커밋 메시지의
  `(M4)`는 지금 어느 것도 가리키지 못한다.
- 동작 보존 작업은 기존 테스트를 수정해서 통과시키면 완료가 아니다.

---

## trigger-durability — Slack·webhook 발화의 급사 복구

**이유**: `schedule-trigger`가 남긴 스케줄러 결정문(ARCHITECTURE.md의 *Schedules*)은 세
소비자 — schedule, Slack 이벤트, webhook 딜리버리 — 를 놓고 평가했지만, 앞의 둘을 옮기는
일은 의도적으로 범위에서 뺐다: 배포 환경 결정 하나가 실행 경로 세 개의 재작성이 되기
때문이다. 그 결과 지금은 schedule 발화만 급사에서 복구된다 — scan이 lease 지난 `running`
row를 `failed`로 마감한다. Slack은 claim lease가 회수될 뿐 재처리가 없고, webhook은 이력
row가 `running`인 채 남는다(OPERATIONS.md의 multi-instance 표).

**선행**: 없음. 복구 패턴(claim + lease + 스캔 마감)은 schedule 쪽이 확정했고
`scanSchedules.ts`에 있다.

**범위**

- webhook 딜리버리의 잔류 `running` row를 schedule과 같은 lease 기준으로 `failed` 마감한다.
  schedule과 달리 webhook 트리거에는 cross-project 열거 인덱스가 없다 — 열거 경로(GSI 부여
  vs 프로젝트 순회)를 정하는 것이 이 작업의 설계 절반이다.
- Slack 이벤트의 재처리 여부를 결정하고 기록한다. 재처리 없음(현행)을 유지한다면 그 근거를
  결정으로 남긴다 — 재처리는 run의 비멱등성(도구 부수효과)과 충돌하는, schedule이 이미 한 번
  내린 판단이다.

**완료 조건**: 급사한 webhook 딜리버리 row가 lease 만료 뒤 `failed`로 마감되는 것을
테스트로 검증한다. Slack 재처리 결정이 문서에 있고 구현이 그 결정과 일치한다.

## image-store-hardening — 생성 이미지 저장소의 public-read 제거

**이유**: `S3_BUCKET_NAME`은 public-read 버킷에 업로드하고, 어떤 코드 경로도 오브젝트를
지우지 않으며 라이프사이클 룰도 함께 배포되지 않는다 — SECURITY.md(*Data exposure and
retention*)가 스스로 지적하는 예외다. 채팅 트랜스크립트나 Slack 메시지를 쥔 누구든 유효한
이미지 URL을 무기한 보유한다. 엔터프라이즈(SaaS/설치형) 전환의 기반 경화 단계.

**선행**: 없음.

**범위**

- 저장은 오브젝트 **키**를 기록하고 URL 서명을 조회 시점으로 옮긴다. 채팅 replay는 저장된
  URL을 provider가 직접 fetch하므로(chat AGENTS.md의 *Attachments are sent twice*), replay에
  넣는 서명의 유효기간이 런 지속시간(`MAX_RUN_DURATION_MS`)을 감당해야 한다 — 읽기 시
  재서명이 설계의 핵심이다.
- 이미지 만료를 `CHAT_RETENTION_DAYS`와 정합시킨다. 앱이 지우는지, 버킷 라이프사이클에
  위임하고 OPERATIONS.md 배포 체크리스트 요건으로 만드는지가 결정 대상.
- 기존 public URL로 저장된 행의 하위 호환(읽기 시 판별)을 명시한다.

**완료 조건**: 새 업로드가 공개 ACL 없이 저장되고, 채팅 read와 replay가 시간제한 서명 URL을
받는 것을 테스트로 검증한다. 보존 요건이 OPERATIONS.md 체크리스트에 오르고, SECURITY.md의
해당 예외 서술이 갱신된다.

## audit-log-entity — 감사 기록의 일급 엔티티 승격

**이유**: 민감 행위 — 시크릿 reveal 3종, 관리자 override 쓰기, 설정 변경, 토큰 발급·회전 —
는 지금 로그 라인으로만 남는다(SECURITY.md: "Every reveal is logged server-side"). 로그에는
보존·조회·내보내기 계약이 없어 "누가 언제 무엇을"이라는 감사 질문에 답하지 못한다.

**선행**: 없음.

**범위**

- `AuditEvent` 도메인 엔티티 + repository 포트: actor, action, target, detail, createdAt,
  `expiresAt`(보존 변수). 키는 `keys.ts`에 추가한다.
- 기록 지점: a2a-key/프로젝트 토큰/트리거 시크릿 reveal, `assertProjectWritable`의 admin
  override 경로, `PUT /api/settings`, 토큰·시크릿 발급/회전, 프로젝트·레지스트리 삭제.
  기존 로그 라인은 유지한다 — 로그와 감사는 소비자가 다르다.
- 조회는 admin 전용 API(기간 필터, `queryAll()` 페이지네이션). UI·내보내기는 별도 작업.
- 기록자는 단일 소유 모듈 하나로 만들고 `SINGLE_OWNERS`에 등록한다 — 기록 지점이 늘 때마다
  포맷이 복제되는 것이 이 작업이 막는 실패다.

**완료 조건**: 위 기록 지점 각각이 감사 행을 남기는 것을 테스트로 검증한다. 감사 기록자가
아키텍처 테스트의 single-owner 불변식에 등록된다. 행이 보존 변수로 계산된 `expiresAt`을
갖는 것을 테스트로 검증한다.

## unknown-model-fail-closed — 미등록 모델 실행의 거부 옵션

**이유**: 레지스트리에 없는 모델은 실행되고 $0로 계상된다(CONFIGURATION.md). 사내에선
대시보드 오염이지만, 과금이 실제 청구가 되는 순간 매출 누수가 된다. 기본 동작은
유지하되(기존 배포 호환), 배포가 거부를 선택할 수 있어야 한다.

**선행**: 없음.

**범위**

- 런타임 설정 하나(allow | refuse, 기본 allow) — `runtime-settings.ts` 경유, env fallback.
- refuse: 실행 admission에서 primary와 fallback 모두 레지스트리를 조회해 dispatch 전
  `ValidationError`로 거부한다(스트림 시작 전 HTTP 에러 계약). 검사 위치는 실행
  파사드(`runProject.ts`)의 버전 resolve 직후 한 곳.
- 버전 저장의 "경고와 함께 허용" 계약은 그대로 둔다 — 막는 것은 실행이지 편집이 아니다.
- allow는 현행과 byte-identical.

**완료 조건**: refuse 설정에서 미등록 primary/fallback 실행이 dispatch 전 거부됨을 테스트로
검증한다. allow 설정에서 기존 테스트가 무수정 통과한다.

## tenant-key-scheme — 테넌트 엔티티와 키 스킴

**이유**: 멀티테넌트 전환의 첫 단추. 모든 DynamoDB 키 문자열이 `keys.ts` 한 곳에서 나오므로
테넌트 축은 한 파일 + 마이그레이션 문제로 좁혀진다. 이것 없이 워크스페이스 권한·테넌트
설정을 먼저 만들면 전부 재작업된다. 설치형은 **테넌트 수 1인 같은 아티팩트**로 정의한다 —
분기된 코드 경로를 만들지 않는다.

**선행**: 없음 (위 세 건과 독립).

**범위**

- `Organization`(테넌트) 도메인 엔티티 + repository. 기존 배포는 기본 테넌트 하나로
  동작한다.
- `keys.ts`의 모든 키 빌더에 테넌트 스코프를 도입하고, GSI 파티션(`TYPE#*`, `USAGEDATE#`,
  `CHATOWNER#`, `TRACEPROJECT#`, `TYPE#SCHEDULE`)을 테넌트 스코프로 바꾼다.
- 기존 행의 마이그레이션이 설계의 절반이다: 재키잉 스크립트(복사+삭제) vs 이중 읽기(구 키
  fallback) 중 결정하고, 결정을 문서로 남긴다.
- 아키텍처 테스트에 불변식을 추가한다: 테넌트 스코프 없는 키 빌더가 존재하면 실패.

**완료 조건**: 아키텍처 테스트가 테넌트 미포함 키 빌더를 실패시킨다. 통합 체크가 서로 다른
두 테넌트의 동일 이름 프로젝트 격리를 검증한다. 단일 테넌트 배포의 마이그레이션 경로가
스크립트로 존재하고 통합 체크로 검증된다.

## workspace-authz — 공유 카탈로그의 워크스페이스 스코프 전환

**이유**: "로그인한 누구나 모든 프로젝트를 읽고 실행"(SECURITY.md의 authorization model)은
사내 플랫폼의 가정이고 멀티테넌트에선 성립하지 않는다. 전 구간에서 가장 침습적인 변경 —
모든 read gate가 움직인다 — 이라 별도 마일스톤으로 격리한다.

**선행**: `tenant-key-scheme`.

**범위**

- Membership 엔티티(user ↔ org, role). 역할 목록(예: admin / editor / viewer / billing)의
  확정이 설계 대상.
- 프로젝트 read/run/카탈로그 목록을 멤버십 검사 뒤로 옮긴다. **테넌트 안에서는 공유 카탈로그
  의미론을 유지한다** — 뒤집는 것은 테넌트 경계다.
- `assertProjectWritable`을 역할 기반으로 확장한다 — 단일 관문을 유지하고 호출자에 플래그를
  스레딩하지 않는다(SECURITY.md가 기록한 실패 그대로). `isAdminEmail`의 "빈 목록 = 전원
  허용" fail-open은 테넌트 문맥에서 제거한다.
- 기계 표면(프로젝트 토큰, Slack, A2A, 트리거)은 프로젝트 스코프 자격증명이라 의미가
  유지된다 — 단 usage/trace/actor 행이 테넌트 문맥을 갖는지 확인한다.
- SECURITY.md 권한 표를 갱신한다.

**완료 조건**: 타 테넌트 사용자의 프로젝트 read/run이 404/403임을 라우트 테스트로 검증한다.
역할별 허용 매트릭스가 테스트로 고정된다. 같은 테넌트 안의 기존 owner/admin 시나리오
테스트는 무수정 통과한다.

## tenant-settings-layer — 런타임 설정의 테넌트 레이어

**이유**: 설정 해석(DB override → env → default)은 앱 전역 하나다(CONFIGURATION.md의
resolution order). 테넌트별 허용 모델·관리자 목록·BYO LLM 채널·보존 기간 없이는 테넌트가
정책 주체가 될 수 없다.

**선행**: `workspace-authz` (테넌트 설정을 편집할 역할이 먼저 있어야 한다).

**범위**

- 해석 순서에 한 단을 추가한다: **테넌트 override → 앱 override → env → default.**
  `runtime-settings.ts`가 단일 소유를 유지한다.
- 테넌트 설정 행 + 기존 캐시 계약(`SETTINGS_CACHE_TTL_MS`, process-local 무효화 한계)을
  따른다.
- 테넌트가 오버라이드할 수 있는 키 목록이 설계 대상이다 — 허용 모델, 테넌트 관리자, LLM
  채널(BYO 키: 암호화 저장·마스킹 규약 준수), 보존 기간. 인프라 키(`STAGE`, DynamoDB, 부트
  필수값)는 불가. 목록은 한 곳에 정의한다.

**완료 조건**: 해석 순서(테넌트 > 앱 > env > default)를 테스트로 고정한다. 테넌트 A의
오버라이드가 B에 보이지 않음을 테스트로 검증한다. 오버라이드 가능 키 목록이 한 곳에
정의되고, 목록 밖 키의 테넌트 오버라이드가 거부됨을 테스트로 검증한다.

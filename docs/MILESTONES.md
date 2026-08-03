# 마일스톤

Agent Studio는 프로젝트·버전 관리, LLM/에이전트 실행, Skills/MCP/외부 에이전트,
Slack/A2A 연동, 사용량 집계와 트레이스를 갖추고 있다. 이 문서는 구현 이력이 아니라
프로덕션 운영에 남은 작업만 우선순위대로 관리한다.

기반 정리는 끝났다. 레이어 경계는 `tests/architecture.test.ts`가 강제한다 — 규칙 전부
허용 목록이 비어 있고, 이름 붙인 불변식은 저마다 소유 파일이 하나씩 지정돼 사본이
생기면 실패한다. 아래 기능 작업은 그 위에 얹는다: 새 어댑터는 포트 뒤로 가고, 조립은
AGENTS.md가 명명한 wiring site에서만 하며(목록은 그쪽이 정본이다 — 여기 복제했던
사본은 한 번 낡았다), 새 실행 정책은 **run bracket** 한 곳
(`src/application/execution/runBracket.ts`)에 붙는다.

실행 파사드가 아니다. top-level run을 admit하는 네 함수 중 `generateImage`는 파사드를
통과하지 않으므로(predict 라우트·A2A executor·트리거 러너가 그 모듈을 직접 부른다),
파사드에 붙인 정책은 이미지 런에 적용되지 않는다. bracket은 어떻게 시작됐든 모든 top-level
run을 감싸는 단일 소유자이고, 일일 비용 가드와 동시성 가드가 이미 거기 있다
(ARCHITECTURE.md의 *The run bracket*).

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

## trigger-durability — webhook 딜리버리의 급사 복구

**이유**: `schedule-trigger`가 남긴 스케줄러 결정문(ARCHITECTURE.md의 *Schedules*)은 세
소비자 — schedule, Slack 이벤트, webhook 딜리버리 — 를 놓고 평가했지만, 뒤의 둘을 옮기는
일은 의도적으로 범위에서 뺐다: 배포 환경 결정 하나가 실행 경로 세 개의 재작성이 되기
때문이다. 그 결과 지금은 schedule 발화만 급사에서 복구된다 — scan이 lease 지난 `running`
row를 `failed`로 마감한다. Slack은 claim lease가 회수될 뿐 재처리가 없고, webhook은 이력
row가 `running`인 채 남는다(OPERATIONS.md의 multi-instance 표).

**선행**: 없음. 복구 패턴(claim + lease + 스캔 마감)은 schedule 쪽이 확정했고
`scanSchedules.ts`에 있다.

**범위**

- webhook 딜리버리의 잔류 `running` row를 schedule과 같은 lease 기준으로 `failed` 마감한다.
  schedule과 달리 webhook 트리거에는 cross-project 열거 인덱스가 없다 — 열거 경로(GSI 부여
  vs 프로젝트 순회)를 정하는 것이 이 작업의 설계 절반이다. GSI를 부여하면 ARCHITECTURE.md의
  키맵에 반영한다.
- **Slack은 범위 밖이다.** 재처리는 schedule이 이미 내린 판단(run은 비멱등이고 도구에
  부수효과가 있다)에 걸리고, Slack에는 schedule의 "다음 발생"에 해당하는 자연스러운 재시도가
  없다. 급사한 Slack 이벤트가 남기는 것은 마감되지 않은 이력이 아니라 답을 받지 못한 사용자이고,
  그건 복구가 아니라 사용자에게 이미 보이는 실패다. 이걸 다루려면 자동 확인 가능한 완료 조건이
  따로 필요하므로, 규약대로 별도 slug가 생기기 전까지 마일스톤에 넣지 않는다.

**완료 조건**: 급사한 webhook 딜리버리 row가 lease 만료 뒤 `failed`로 마감되는 것을
테스트로 검증한다. 살아 있는 딜리버리는 마감되지 않는 것을 같은 테스트에서 검증한다 —
schedule 쪽이 `repairLostRuns`에서 이미 지키는 경계다.

## image-store-hardening — 생성 이미지의 공개 URL 제거

**이유**: 채팅 이미지는 서명 없는 공개 주소로 저장된다 — `storeImage`가 반환하는 것은
`https://<bucket>.s3.<region>.amazonaws.com/images/<uuid>.png`이고, 그게 동작하려면 버킷이
public-read여야 한다. 게다가 `CacheControl: public, max-age=31536000, immutable`이 붙고,
어떤 코드 경로도 오브젝트를 지우지 않으며 라이프사이클 룰도 함께 배포되지 않는다.
트레이스·usage·채팅·트리거 이력이 전부 TTL로 만료되는 배포에서 이미지만 만료되지 않고,
채팅 트랜스크립트나 Slack 메시지를 쥔 누구든 유효한 URL을 무기한 보유한다.
SECURITY.md(*Data exposure and retention*)가 스스로 "두 규칙의 예외"로 적어 둔 자리다.

**선행**: 없음.

**범위**

- 저장은 오브젝트 **키**를 기록하고 URL 서명을 조회 시점으로 옮긴다. 채팅 replay는 저장된
  URL을 provider가 직접 fetch하므로(chat AGENTS.md의 *Attachments are sent twice*), replay에
  넣는 서명의 유효기간이 런 지속시간(`MAX_RUN_DURATION_MS`)을 감당해야 한다 — 읽기 시
  재서명이 설계의 핵심이다.
- 이미지 만료를 `CHAT_RETENTION_DAYS`와 정합시킨다. 앱이 지우는지, 버킷 라이프사이클에
  위임하고 OPERATIONS.md 배포 체크리스트 요건으로 만드는지가 결정 대상.
- 기존 공개 URL로 저장된 행의 하위 호환을 명시한다 — 읽기 시 판별해서 그대로 넘긴다.
- Slack 업로드는 대상이 아니다. `handleSlackEvent`는 `slack.uploadImage`로 스레드에 직접
  올리고 이 버킷을 거치지 않는다. 이 마일스톤이 좁히는 것은 채팅 경로 하나다.
- 완료 시 SECURITY.md의 예외 서술과 OPERATIONS.md의 배포 체크리스트를 함께 갱신한다.

**완료 조건**: 채팅 메시지에 저장되는 값이 공개 URL이 아니라 오브젝트 키임을, 그리고 chat
read와 replay가 각각 유효기간을 가진 서명 URL을 받음을 테스트로 검증한다. replay용 서명의
유효기간이 `MAX_RUN_DURATION_MS`보다 긴 것을 테스트로 고정한다. 기존 공개 URL로 저장된 행이
계속 읽히는 것을 테스트로 검증한다.

## audit-log-entity — 감사 기록의 일급 엔티티 승격

**이유**: 민감 행위가 남기는 흔적이 고르지 않고, 남는 쪽조차 감사 기록이 아니다.

- 시크릿 reveal 3종과 `assertProjectWritable`의 admin override는 caller email과 함께 로그
  라인을 남긴다(SECURITY.md: "Every reveal is logged server-side").
- **`PUT /api/settings`와 프로젝트·레지스트리 삭제는 아무것도 남기지 않는다.** 설정 쓰기는
  `userEmail`을 받아 최신 상태에만 반영하고 이력을 쓰지 않으므로, 관리자 목록이나 LLM 자격증명이
  언제 누구 손에 바뀌었는지 되짚을 방법이 없다.

그리고 로그를 남기는 쪽조차 보존·조회·내보내기 계약이 없어 "누가 언제 무엇을"이라는 감사
질문에 답하지 못한다.

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
  키를 늘릴 때의 알려진 함정: `PUT /api/settings`의 zod 스키마는 키를 손으로 나열하므로,
  거기 빠뜨리면 요청이 400도 없이 조용히 버려진다. `toolsRepo`가 이미 그렇게 한 번 새어
  나갔다(`4d0c1d9`).
- refuse: 실행 admission에서 primary와 fallback 모두 레지스트리를 조회해 dispatch 전
  `ValidationError`로 거부한다(스트림 시작 전 HTTP 에러 계약 — SSE 라우트는 첫 chunk를 당겨본
  뒤에 응답을 만들므로 이 throw는 스트림이 아니라 400으로 나간다). 검사 위치는 **run bracket
  한 곳**이다: top-level run을 admit하는 네 함수가 모두 지나는 유일한 지점이고, 파사드는
  그렇지 않다.
- 이미지 런은 이미 닫혀 있다 — `generateImage`가 모델의 `imageGeneration` capability를 보고
  거부하는데 미등록 모델은 `getModelConfig`가 `undefined`라 같은 `ValidationError`에 걸린다.
  bracket에 붙이면 정책이 한 겹 더 얹힐 뿐 동작은 바뀌지 않는다.
- 버전 저장의 "경고와 함께 허용" 계약은 그대로 둔다 — 막는 것은 실행이지 편집이 아니다.
- allow는 현행과 byte-identical.

**완료 조건**: refuse 설정에서 미등록 primary/fallback 실행이 dispatch 전 거부됨을 테스트로
검증한다. 새 설정 키가 `PUT /api/settings`를 통해 실제로 저장되는 것을 테스트로 검증한다 —
위 함정이 조용히 재발하는 것을 막는 유일한 조건이다. allow 설정에서 기존 테스트가 무수정
통과한다.

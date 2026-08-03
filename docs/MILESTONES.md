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

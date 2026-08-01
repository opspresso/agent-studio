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

## context-budget — run이 컨텍스트에 쌓는 총량의 소유자

**이유**: 상한은 많지만 **합계를 보는 곳이 없다.** 지금 있는 것은 전부 항목별·turn별이다 —
tool 결과 `MAX_TOOL_RESULT_CHARS_PER_TURN`(200,000자, **turn당**), 이미지
`MAX_ATTACHMENTS`(4, turn당), transcript `MAX_TRANSFER_CONTEXT_CHARS`(8,000자), 그리고 채팅
진입에만 있는 `MAX_HISTORY_CHARS`/`MAX_HISTORY_MESSAGES`. 루프의 `messages` 배열은 turn마다
자라고 `maxTurn`은 기본 50이다. 즉 **한 run이 컨텍스트에 넣을 수 있는 총량에는 상한이 없다.**
transfer가 자식 답변을 넣는 `postContextMessages`는 상한이 아예 없는 자리다.

`contextWindow`는 이미 모델마다 정의돼 있다(`src/domain/llm/models.ts`). **엔진이 그것을 읽지
않는다** — 정보는 있는데 쓰이지 않는 상태다. 그래서 컨텍스트 초과는 예산 초과로 처리되지
못하고 provider의 400으로 나타나며, 첫 chunk 이후라면 재시도 없이 `{error}` chunk가 된다.
도구를 많이 쓰는 긴 run이 원인 불명으로 죽는다.

**진입점별 방어도 고르지 않다.** 채팅만 히스토리 예산을 갖고, predict / OpenAI 호환 /
Slack / A2A / webhook trigger는 받은 `messages`를 그대로 넘긴다. 같은 모델에 같은 크기의
입력을 주면서 한 경로만 보호된다.

**선행**: 없음. 종료 이유는 이미 명시적이다 — `RunTerminationReason`과 `chunkTermination`
(`src/domain/llm/types.ts`)이 소유하므로, 예산 소진을 이유로 루프를 끝내는 선택지는 값 하나를
더하는 일이다. 절단만으로 끝낼지, 종료까지 갈지는 설계 단계에서 정한다.

**범위**

- run 단위 누적 예산의 **단일 소유자**를 만든다. 모델의 `contextWindow`에서 유도하고,
  기존 항목별 상한은 그 아래에 남긴다 — 상한을 없애는 작업이 아니라 합계를 아는 작업이다.
- `postContextMessages`(transfer 답변, MCP 반환 이미지의 동반 메시지)를 예산 안으로 넣는다.
- 절단은 기존 규약대로 `warning`으로 보고한다. 조용히 버리지 않는다.
- 문자 수와 토큰의 관계를 어떻게 근사할지 결정하고 기록한다. 정확한 토큰 계산은 provider별
  tokenizer를 요구하므로, 보수적 문자 기반 근사로 시작할지 판단한다.
- **`messages` 밖의 컨텍스트 소비자를 예산이 어떻게 다루는지 결정한다** — 이미지 첨부(문자
  근사가 보지 못하는 provider 이미지 토큰), 도구 정의 JSON schema(한 run에 MCP 도구 최대
  120개 — 이것만으로 수만 토큰), 시스템 프롬프트와 스킬 테이블. 근사에서 제외한다면 그
  몫을 예산 여유분(headroom)으로 명시한다.
- **`fallbackModel`로 전환될 수 있는 run은 어느 모델의 `contextWindow`가 기준인지 정한다** —
  두 모델의 최솟값이 안전한 기본값이다.
- 진입점별 불균형을 정리한다 — 히스토리 예산을 모든 진입점이 지나는 자리로 옮길지, 아니면
  채팅 전용임을 근거와 함께 문서에 남길지 결정한다.

**설계 메모**: `MAX_TOOL_RESULT_CHARS_PER_TURN`이 200,000자라는 것은 **한 turn만으로도** 작은
컨텍스트 창을 넘길 수 있다는 뜻이다. 즉 이 마일스톤은 "긴 run"만의 문제가 아니라 per-turn
상한이 모델과 무관하게 정해져 있다는 문제이기도 하다. 예산을 모델에서 유도하면 두 문제가
같은 곳에서 해결된다.

**완료 조건**

- 작은 `contextWindow`를 가진 모델로 도구를 반복 호출하는 run이 provider 400 대신 예산
  절단과 `warning`으로 처리된다.
- transfer 답변이 예산에 포함된다 — 자식 답변을 크게 만든 fake로 절단이 보고되는 것을
  확인한다.
- 예산 계산은 한 곳에만 있다. `tests/architecture.test.ts`의 single-owner 불변식으로 고정한다.
- 예산에 여유가 있는 run의 요청 본문은 바이트 단위로 동일하다.

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

# Agent 추천

새 Chat과 Workspace의 입력 중인 요청에서 Agent를 제안한다. 추천은 전역 `decisionModel`을
설정했을 때만 실행되며, 사용자가 **Agent 선택**을 눌러야 선택값이 바뀐다. 추천 호출은
Chat 실행이나 Workspace 작업을 시작하지 않는다.

## Jev 계약과 경계

TypeSafe Jev는 텍스트 `state`와 닫힌 선택지의 `Choice` 질문을 받아 `choice`, 각 선택지의
`probabilities`, `confidence`를 반환한다. [TypeSafe Choice 문서](https://docs.typesafe.ai/primitives/choice)는
한 질문에 최대 255개 선택지를 허용한다. Jev는 응답 문장·코드를 생성하지 않으며
[텍스트만 입력받는다](https://docs.typesafe.ai/concepts/system-one). 따라서 첨부 이미지·파일의
내용은 이 추천에 넣지 않는다.

이 구현은 요청 텍스트를 `state`에, 접근 가능한 Agent의 표시 이름·설명을 Choice의
`criteria`에 넣는다. Agent 이름을 모델이 만든 문자열로 해석하지 않고, 서버가 배정한
`agent_0` 등의 키를 원래 후보에 다시 매핑한다. `none`은 적합한 Agent가 없다는 선택지다.
후보가 64개를 넘으면 전체 후보를 64개씩 평가하고 각 묶음의 승자를 반복해서 비교한다.
표시 이름은 100자, 설명은 200자, 요청은 4,000자로 제한해 문맥을 제한한다.

[TypeSafe의 Jev 한계 문서](https://docs.typesafe.ai/model-jaggedness/jev-1.13)는 큰 무관한
입력과 적대적 내용이 판단을 흐릴 수 있다고 설명한다. 그래서 후보의 설명만 전달하고,
Agent의 system prompt·도구 자격증명·첨부 내용은 보내지 않는다. `confidence`는 응답에
보존하지만 자동 선택 기준으로 사용하지 않는다. 배포별 정답 데이터로 임계값을 검증하지
않은 상태에서 수치를 정답 보장으로 취급하지 않기 위해서다.

## 소유권과 실행

| 책임 | 소유자 |
|---|---|
| 등록된 Decisions 모델의 선택·삭제 방지 | `application/llm/modelRegistry.ts`와 Settings 행 |
| 접근 가능한 후보와 Choice 구성·후보 분할 | `application/llm/agentRecommendation.ts` |
| 인증된 사용자에 대한 Chat·Workspace 후보 목록 바인딩 | `lib/container.ts` |
| OpenRouter Decisions API 또는 설정된 System One 호환 endpoint 호출·응답 검증 | `infrastructure/llm/decisionClient.ts` |
| 입력 변경 debounce·이전 응답 취소·수동 적용 | `app/_components/AgentSuggestion.tsx` |

Chat 후보는 사용자가 접근 가능한 Agent이고 Workspace 후보는 그 사용자에게 Workspace
정책이 활성화된 Agent다. 추천 응답의 이름은 해당 목록에 있는 값만 인정한다. 모델이
설정되지 않았거나 적합한 후보가 없으면 빈 결과를 반환한다. 호출 실패는 입력이나 실행을
막지 않고 추천 오류로 표시한다. 이 기능이 꺼져 있을 때 필수 경로에 외부 네트워크 의존성은 없다.

`domain/llm/decision.ts`는 특정 Agent에 묶이지 않은 Choice 포트다. 다른 닫힌 선택지
결정에도 같은 provider adapter를 사용할 수 있으며, Agent 실행 모델을 사용자 요청에 따라
고르는 기능을 추가할 때도 그 선택지·권한·검증 규칙은 별도 유스케이스가 소유한다.

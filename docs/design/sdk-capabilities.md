# OpenAI Agents SDK 기능 적용 범위

Agent Studio는 `package.json`에 고정한 `@openai/agents`를 실행 런타임으로 사용한다.
SDK에 포함된 기능과 제품에서 연결·운영하는 기능은 구분한다. required path는 폐쇄망에서
동작하며 SDK의 기본 공개 exporter나 OpenAI가 관리하는 Session을 전제로 하지 않는다.
실행 계약의 정본은 [execution.md](execution.md)와
[Runtime 지침](../../src/application/runtime/AGENTS.md)이다.

## 기능별 구현과 검증

| 기능 | 제품의 적용 범위 | 구현과 검증 근거 |
|---|---|---|
| 에이전트 루프 | SDK `Agent`·`Runner`가 모델/도구 반복, 스트리밍과 종료를 소유한다. Studio는 턴·비용·문맥 한도와 취소를 적용한다 | `runtime/execute.ts`, `model.ts`; `engine.test.ts`, `engineParallelTools.test.ts`, `agentModels.test.ts` |
| 샌드박스 실행 | 미제공. 모델이 명령을 실행하는 작업공간·셸·스냅샷·재개 기능은 없다 | 아래 도입 조건을 따른다. 문서 worker와 관리형 MCP 컨테이너는 이 기능을 제공하지 않는다 |
| 음성 에이전트 | 파일 기반 전사·후처리·내보내기를 제공한다. SDK `RealtimeAgent`·`RealtimeSession`, 양방향 실시간 음성, VAD와 발화 인터럽션은 미제공이다 | `application/audio/`, `infrastructure/llm/audioSegmenter.ts`; `audioJobProcessor.test.ts`, `audioPostprocess.test.ts`, `audioBuiltin.test.ts` |
| TypeScript 우선 | SDK의 Agent·ModelProvider·Session·RunState 계약을 직접 사용하고 domain port로 배포 자원을 주입한다 | `runtime/types.ts`, `boundAgent.ts`; `architecture.test.ts`, `pnpm typecheck` |
| Agents as tools·Handoff | text agent는 `Agent.asTool` 또는 같은 Runner의 Handoff로 연결한다. 로컬 발행 버전, 깊이·순환·남은 턴 제한을 적용한다. 원격/이미지 대상은 function tool이다 | `runtime/agent.ts`, `execution/agentBindings.ts`; `nativeDelegation.test.ts`, `agentBindings.test.ts`, `runtimeSession.test.ts` |
| 가드레일 | 버전의 `maxInputChars`를 blocking 입력 Guardrail로 검사한다. Handoff 대상도 검사하며 스트리밍/완료형 모두 PII 치환 전 길이를 사용한다. `blockedTools`·`approvalTools`는 도구 조립 정책이다 | `runtime/policy.ts`; `runtimeValidation.test.ts`, `nativeTracing.test.ts`. 의미 기반 유해성 분류와 사용자 정의 출력 Guardrail은 제공하지 않는다 |
| 함수 도구 | builtin·MCP·위임·frontend 도구를 SDK에 연결한다. 선언된 JSON Schema를 SDK 입력 Guardrail에서 승인 요청 전에 검사하며 서버 도구는 실제 dispatch 전에도 검증한다. 실패는 오류 도구 결과로 반환한다 | `runtime/tools.ts`, `domain/llm/toolSchema.ts`, `infrastructure/llm/toolSchema.ts`; `toolSchema.test.ts`, `runtimeValidation.test.ts` |
| MCP | Studio가 승인한 연결·도구 alias 스냅샷을 SDK `MCPServer`로 제공한다. OAuth·SSRF·사용자 헤더·연결 정리는 기존 adapter가 담당한다 | `runtime/mcp.ts`, `infrastructure/mcp/session.ts`; `mcpBindings.test.ts`, `mcpAuthDispatch.test.ts`, `nativeTracing.test.ts` |
| Session | Chat의 정확한 native 모델/도구 이력을 PostgreSQL에 암호화해 저장한다. owner/revision CAS, 보존 기간, 문맥/이미지 상한과 삭제 tombstone을 적용한다 | `runtime/session.ts`, `db/repositories/runtimeSessionRepository.ts`; `runtimeSession.test.ts`, `scripts/runtime-session-check.ts` |
| HITL | Chat 소유자가 도구별 승인·거절을 결정한다. 직렬화한 RunState와 자식 Agent identity를 복원하고 실행 전에 체크포인트를 선점한다 | `application/chat/approval.ts`, `runtime/execute.ts`; `chatApproval.test.ts`, `chatApprovalRoute.test.ts`, `runtimeSession.test.ts`, PostgreSQL 통합 검사 |
| 트레이싱 | SDK native span을 로컬 Trace와 콘솔에 제공한다. 선택적 OTLP 전송은 부모 관계를 보존한다. OpenAI의 호스팅 평가·파인튜닝·증류에 데이터를 자동 전송하지 않는다 | `runtime/tracing.ts`, `telemetry/otelTraceExport.ts`; `nativeTracing.test.ts`, `otelTraceHierarchy.test.ts` |

표의 `runtime/`·`execution/`는 `src/application/` 아래이며 `db/`·`telemetry/`는
`src/infrastructure/` 아래다. 테스트 파일은 `tests/` 아래다.

## 실행 경계의 구체적 의미

**도구 스키마는 실행 계약이다.** TypeScript 타입은 실행 시 사라지므로 함수 시그니처만으로
검증하지 않는다. SDK에 Zod/Standard Schema를 전달하는 방식과 일반 JSON Schema를 전달하는
방식은 다르다. Studio는 기존 builtin 선언과 MCP가 제공하는 JSON Schema를 유지하고 주입된
검증기로 검사한다. `required`, `enum`, 중첩 배열/union, `additionalProperties`, 지원하는
`format`과 로컬 `$ref`가 적용된다. 값의 강제 변환·누락 필드 자동 채움·추가 필드 삭제는 하지
않는다. 스키마 ID 공간은 도구마다 독립적이며 외부 참조 다운로드와 비동기 검증은 허용하지 않는다.

**입력 Guardrail은 범용 안전성 판정이 아니다.** 입력 길이 검사에는 blocking 방식이 맞다.
병렬 검사는 모델/도구 효과가 시작된 뒤 실패할 수 있다. 현재 제품에 의미 기반 판정기나 출력
차단 정책은 없으므로 이 가드레일만으로 유해성·사실성·prompt injection 방어를 보장하지 않는다.
추가 판정기는 배포가 쓸 수 있는 모델, 판정 기준, 지연/비용 예산과 스트림 공개 시점을 함께 정해야 한다.

**Session과 장기 Memory는 별개다.** Session은 한 대화의 실행 이력이며 의미 검색 기반의
장기 기억이 아니다. Memory recall은 선택한 MCP Context 기능이 소유한다. Session이 없거나
만료되면 새 문맥으로 시작한다는 경고를 제공한다. Chat 밖의 stateless API·메시징에는 Chat과
같은 영속 승인 UI를 자동 제공하지 않는다. 승인이 필요한 정책을 그 표면에서 실행하면 거부한다.

**추적과 평가 데이터셋은 별개다.** 로컬 span은 식별자·부모 관계·이름·종류·시간·상태·사용량을
보존하고 원문 모델/도구 데이터는 저장하지 않는다. 콘솔은 span 목록을 제공하며 OTLP collector는
부모 관계로 계층을 구성할 수 있다. 이 메타데이터만으로 학습 데이터셋을 만들지 않는다.
평가·학습 연동에는 별도의 데이터 선택·정답/평가 기준·보존/반출 정책이 필요하다.

## 선택적 실행 환경의 도입 조건

**샌드박스**는 SDK의 별도 `SandboxAgent` 실행 형태다. 도입하려면 사내에서 운영하는 격리
compute, 모델이 읽고 쓸 작업공간 범위, 셸 명령·네트워크·시크릿 권한, 자원/시간 한도,
workspace와 snapshot 보존/삭제, 승인 재개와 artifact 반출 계약을 정해야 한다. SDK의 local
개발용 client를 앱 서버의 일반 셸 실행 권한으로 연결하는 것만으로 격리를 구현했다고 보지 않는다.
기존 문서 worker의 정해진 작업 실행이나 MCP 서버 컨테이너 관리와 별도 기능으로 다룬다.

**실시간 음성**은 Realtime 호환 transport와 모델이 필요하다. 일반 Chat Completions gateway의
존재만으로 WebRTC/WebSocket 음성을 지원한다고 판단하지 않는다. 폐쇄망 접근 가능 endpoint,
브라우저용 단기 자격 증명, 마이크 동의, VAD·barge-in 취소, 음성/텍스트 이력과 비용 집계,
도구 승인 UI의 상호작용을 설계해야 한다. 현재 파일 전사 파이프라인은 각 단계를 독립적으로
검사·재시도하는 제품이며 실시간 음성 통화로 표시하지 않는다.

## 공식 자료

- [SDK 개요](https://developers.openai.com/api/docs/guides/agents/sdk)
- [Guardrails와 승인](https://developers.openai.com/api/docs/guides/agents/guardrails-approvals)
- [Sandbox Agents](https://developers.openai.com/api/docs/guides/agents/sandboxes)
- [Voice agents](https://developers.openai.com/api/docs/guides/voice-agents)

배포에서 사용하는 정확한 API 계약은 lockfile의 SDK 버전과 설치된 타입·구현으로 확인한다.

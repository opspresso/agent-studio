# Agent 설정 데이터 이전

Version 기반 설치를 현재 Agent 설정으로 옮기는 일회성 작업이다. 새 설치에는 필요 없다.
스키마 마이그레이션이나 앱 부팅이 자동 실행하지 않는다.

## 실행 환경

현재 이전 도구는 소스 체크아웃에서 실행한다. 대상 릴리스와 같은 소스, Node.js 24,
고정된 pnpm 11과 설치된 개발 의존성을 준비한다. 릴리스 앱 이미지에는 이 TypeScript 도구와
`tsx` 실행 환경이 포함되지 않는다. 폐쇄망에서는 소스와 의존성도 미리 반입한다.
실행 환경은 기존 PostgreSQL의 등록 모델과 프로바이더 설정에 접근할 수 있어야 한다.
이전할 Agent의 모델을 관리 화면에서 먼저 등록한다.

## 보존과 변환

- 모델 검증은 설치된 카탈로그 문서와 배포의 self-hosted 선언을 먼저 읽는다. 공개 모델 서버는
  호출하지 않으며 설치 문서가 없으면 저장소에 포함된 카탈로그를 사용한다. 잘못된 저장 모델
  선언이나 읽기 오류가 있으면 적용 전에 중단한다.
- `PROJECT#<name>/META`에 Agent의 현재 `configuration`을 저장한다. 발행 포인터가 있으면
  해당 Version을 선택하고, 없으면 `createdAt`이 가장 최신인 Version을 선택한다.
  같은 시각이면 Version 이름의 문자열 순서를 사용한다. 끊어진 발행 포인터는 이전을 막는다.
- 원래 META는 같은 파티션의 `LEGACYCONFIGURATION`에 한 번 보존한다. 모든 `VERSION#…` 행과
  기존 Trace·Artifact·대화·사용량은 수정하지 않는다. 보관 행은 실행·설정 API가 읽지 않는다.
  프로젝트를 명시적으로 삭제하면 다른 프로젝트 소유 데이터와 함께 삭제된다.
- MCP 헤더는 기존 Version 문맥으로 복호화하고 고정된 Agent 문맥으로 다시 암호화한다.
  서버 이름·endpoint fingerprint·tool 제한·source mapping은 유지한다. 키가 맞지 않으면
  원본과 현재 설정 모두 쓰지 않는다. 로그에는 헤더·프롬프트·사용자 정보·암호문을 출력하지 않는다.
- `llm`의 비어 있지 않은 사용자 프롬프트 템플릿은 자동 변환하지 않는다. 새 `systemPrompt`를
  제공하거나 `discardUserPromptTemplate: true`로 미사용을 명시한다. 원문은 Version 행에 남는다.
  실행 호출자는 템플릿 변수 대신 `messages`를 보낸다.
- Webhook의 변수 모드와 Trigger의 고정 `variables`는 지원하지 않는다. 활성 자동화가 이를
  사용하면 이전을 막는다. 기존 앱에서 비활성화하거나 고정 입력을 Agent 지시문·예약 메시지로
  옮긴 뒤 다시 계획한다. Webhook은 JSON 전체를 사용자 메시지로 전달한다. 기존 Trigger 행은
  이전 도구가 삭제하지 않지만 새 런타임은 템플릿 필드를 사용하지 않는다.
- `image`는 `model`에 도구 호출을 지원하는 텍스트 모델을 반드시 지정한다. 원래 이미지 모델은
  `parameters.imageModel`, 이미지 생성은 `parameters.imageGeneration: true`로 옮긴다.
  기존 이미지 모델이 현재 카탈로그에 없으면 `imageModel`도 지정한다. 이전의 고정 size·quality는
  보관 행에만 남으며 새 Agent의 이미지 도구 입력이 생성 옵션을 결정한다.
- 설정이 없던 `llm`·`image` 프로젝트는 미설정 Agent가 된다. 이미 현재 설정을 가진 Agent는 건너뛴다.
  API token·메시징 연결·공개 범위·멤버·비용 한도는 그대로 보존한다. 저장한 설정은 별도 발행 없이
  API·Chat·A2A와 활성화된 연동에서 사용된다.
- Audio recipe의 `published` 참조는 현재 Agent 참조로 옮긴다. 활성 recipe가 고정 Version을
  참조하면 이전을 막는다. 기존 앱에서 `published`로 바꾸거나 recipe를 비활성화하고 계획을
  다시 조회한다. 변경하는 recipe 원본도 `LEGACYCONFIGURATION`에 보존한다.

## 실행 순서

1. PostgreSQL과 object store를 백업한다. 실행 요청·예약 tick·메시징 유입을 중단하고,
   기존 앱에서 미완료 Audio 작업을 완료하거나 취소한다. 앱과 모든 worker를 종료한다.
   `--offline`은 이 상태에 대한 운영자의 확인이며 프로세스를 대신 종료하지 않는다.
2. 이전 코드와 같은 `DATABASE_URL`·`AES_ENCRYPTION_KEY`를 명시해 계획을 조회한다.
   기존 환경 파일은 `--env-file`로 명시해서 읽는다. 자격 증명을 명령 이력에 직접 넣지 않는다.

   ```bash
   pnpm tsx --env-file=.env.local scripts/migrate-agent-configuration.ts
   pnpm tsx --env-file=.env.local scripts/migrate-agent-configuration.ts --project my-agent
   ```

3. 필요한 프로젝트에만 변환 JSON을 만든다. 허용 필드는 `model`, `imageModel`, `fallbackModel`,
   `systemPrompt`, `discardUserPromptTemplate`이다. `fallbackModel: null`은 기존 fallback을 비운다.
   파일에는 시크릿을 넣지 않는다.

   ```json
   { "model": "openai/gpt-5-mini", "systemPrompt": "사용자 요청을 처리한다." }
   ```

   ```bash
   pnpm tsx --env-file=.env.local scripts/migrate-agent-configuration.ts \
     --project my-agent --overrides migration-input.json
   ```

4. `status: ready`와 선택된 원본·모델을 검토한다. 같은 옵션과 계획의 `expectedFingerprint`를
   사용해 프로젝트별로 적용한다. 계획 이후 META·Version·변환 입력이 달라지면 새 계획이 필요하다.
   원본 보관과 META 교체는 한 트랜잭션이며, 동시 수정이 이기면 보관 행도 쓰지 않는다.

   ```bash
   pnpm tsx --env-file=.env.local scripts/migrate-agent-configuration.ts \
     --project my-agent --overrides migration-input.json --apply --expect '<expectedFingerprint>' --offline
   ```

5. 모든 프로젝트 계획을 다시 조회하고 `blocked` 항목을 해결한다. 새 앱에서 설정·프롬프트·MCP
   연결과 필요한 실행 경로를 확인한 뒤 유입과 worker를 다시 활성화한다.

이전 도구는 Audio 작업·SDK checkpoint를 변환하거나 재실행하지 않는다. 이전 Version 형식의
승인 대기는 새 런타임에서 재개를 거부한다. 소유자가 Chat에서 해당 대기를 폐기하면 대기 전
SDK 대화 기록을 보존하고 새 실행을 시작할 수 있다. 이미 claim한 실행의 불확실한 외부 효과는
운영자가 확인해야 하며 자동 replay하지 않는다. 이전 형식의 실패·완료 Audio 작업을 그대로
재시도하지 말고 보존된 입력 파일로 새 작업을 제출한다.

되돌리기는 앱과 worker를 멈춘 상태에서 백업과 이전 릴리스를 함께 복구한다. 보관 행을 새 앱의
설정 API에 그대로 넣거나 `VERSION#…`을 활성 저장소로 다시 연결하지 않는다.

단위 검사는 `tests/agentConfigurationMigration.test.ts`, 실제 PostgreSQL의 원본 보존·동시 적용·
암호화 검사는 `pnpm test:integration`의 전용 로컬 `_test` 데이터베이스에서 실행한다.

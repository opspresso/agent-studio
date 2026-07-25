# 목표: Agent Studio에 멀티모달(이미지 입력) + 이미지 편집을 제대로 지원한다

## 최종 종료 조건 (이게 전부 참이면 완료)

1. `POST /api/projects/{name}/versions/{version}/chat/completions`에 OpenAI 멀티모달 형식
   (`content: [{type:"text",…},{type:"image_url",…}]`)을 보내면 400이 아니라 모델이 이미지를
   보고 답한다. `capabilities.imageInput: false` 모델이면 명시적 4xx로 거절한다.
2. Slack 멘션/DM에 이미지를 첨부하면 봇이 그 이미지를 분석해 답한다. 첨부만 있고 텍스트가
   없는 메시지도 무응답이 아니다.
3. 에이전트가 `EditImage` 빌트인 툴로 기존 이미지(대화 중 첨부된 것 + 직전에 생성한 것)를
   편집할 수 있다. Slack/채팅 UI에 편집 결과가 전달된다.
4. `chat/completions`가 생성/편집된 이미지를 응답에 싣는다(현재는 조용히 버려짐).
5. `pnpm typecheck && pnpm test` 통과, 신규 동작마다 테스트가 있고, 아래 각 Phase의 검증이
   모두 통과한다.
6. `README.md` / `docs/ARCHITECTURE.md` / `docs/API.md`가 새 동작을 반영한다(현재 상태만 기술,
   변경 이력 금지).

## 시작 전 필수

- **plan mode로 진입해서 설계를 먼저 합의한다**(`EnterPlanMode` → 탐색 → `ExitPlanMode`).
  Phase 1~4는 다중 파일 구조 변경이므로 승인 없이 코드를 만지지 않는다.
- `CLAUDE.md`, `docs/ARCHITECTURE.md`, 그리고 `src/application/llm/AGENTS.md`(engine 루프
  불변식), `src/application/chat/AGENTS.md`(tool 메시지 미재생 규약)를 읽는다.
  `engine.ts` / `pii.ts` / `chat/run.ts`는 이 AGENTS.md를 읽지 않고 수정하지 않는다.
- 허가 없이 `git commit` / `git push` 하지 않는다. Phase 단위로 커밋 제안만 한다
  (한 커밋 = 한 목적).

## 현재 상태 (확인된 사실 — 다시 조사하느라 시간 쓰지 말 것)

- 메시지 content가 전 구간 문자열 전제: `src/domain/llm/types.ts:25-35`
  (`ChatMessageInput.content?: string | null`), `ChannelMessage = ChatMessageInput`
  (`src/domain/llm/channel.ts:15`).
- API 게이트가 문자열만 허용: `src/app/api/projects/_lib/schemas.ts`의 `chatMessageSchema`
  (`content: z.string().nullable().optional()`), `predictSchema`, `agentSchema` 동일.
- 채널 어댑터는 `messages`를 SDK에 그대로 넘긴다(`src/infrastructure/llm/channel.ts:46-50`)
  — **와이어는 이미 멀티모달을 통과시킬 수 있다. 막고 있는 것은 타입 + zod 뿐이다.**
- `ModelCapabilities.imageInput`은 정의만 있고 소비하는 코드가 0곳(`src/domain/llm/models.ts:29`).
- Slack 이벤트 타입에 `files` 필드가 없고 `event.text`만 모델에 넘어간다
  (`src/application/slack/handleSlackEvent.ts:38-49, 90`). `subtype`이 있으면 early return
  (`:86-88`) — 파일 첨부가 `subtype: "file_share"`로 오면 응답 자체가 없다.
- `slackClient`에 파일 다운로드 메서드가 없다(`src/infrastructure/slack/client.ts`).
  manifest는 이미 `files:read`를 요청한다(`src/application/slack/projectSlack.ts:147-160`).
- 이미지 채널은 생성 전용: 포트가 `{model, prompt, size, quality}`
  (`src/domain/llm/imageChannel.ts:3-11`), `images.generate`만 호출
  (`src/infrastructure/llm/imageChannel.ts:41-46`). `images.edit` / `image` / `mask` 없음.
- 생성 이미지는 컨텍스트에 텍스트 메모로만 들어가 모델이 자기 그림을 못 본다
  (`src/application/llm/engine.ts:938-967`).
- `chat/completions`는 `chunk.image`를 버린다
  (`src/app/api/projects/_lib/openai.ts:44-61, 74-88`).

---

## Phase 0 — Slack 스레드 컨텍스트 버그 3건 (독립, 먼저 처리)

멀티모달과 무관하므로 **별도 커밋**으로 분리한다.

1. placeholder 오염: `handleSlackEvent.ts`에서 `"_thinking…_"` placeholder를 `:107`에서
   게시한 뒤 `:119`에서 스레드를 조회해, 자기 placeholder가 `assistant` 히스토리로 들어간다.
   → 스레드 조회를 placeholder 게시 **이전**으로 옮기거나, placeholder의 `ts`를 제외한다.
   `기본안`: 조회를 먼저 한다(왕복 1회 추가, 순서만 바뀜).
2. 스레드 절단 방향: `conversations.replies`가 `limit ?? 30` 단일 페이지라
   (`client.ts:85-97`) 30개 초과 스레드에서 **최신 대화가 잘린다**.
   → 커서 페이지네이션으로 전체를 읽고 상한(`기본안`: 최근 50턴)을 **뒤에서** 자른다.
   DB의 `queryAll()`과 같은 규율을 Slack 호출에도 적용한다는 의도.
3. `file_share` 무응답: `subtype` 가드가 파일 첨부 메시지를 통째로 버린다.
   → Phase 2에서 필요하므로 여기서 `subtype` 화이트리스트(`file_share` 허용)를 도입한다.
   봇 루프 방지(`bot_id`)는 절대 약화하지 않는다.

**검증**: `tests/slack.test.ts` / `tests/handleSlackEvent.test.ts`에
(a) placeholder ts가 히스토리에 없음, (b) 60개 스레드에서 최신 메시지가 컨텍스트에 포함됨,
(c) `subtype: "file_share"` 이벤트가 처리됨, (d) `bot_id` 이벤트는 여전히 무시됨 —
4개 테스트 추가. 기존 `threadReplies` fake가 항상 `[]`를 반환해 이 버그들을 못 잡았으므로
fake를 실제 페이로드에 가깝게 고친다.

## Phase 1 — 멀티모달 메시지 타입 (기반)

- `src/domain/llm/types.ts`에 OpenAI 호환 파트 타입 추가:
  `type ContentPart = {type:"text"; text:string} | {type:"image_url"; image_url:{url:string; detail?:"low"|"high"|"auto"}}`,
  `content?: string | ContentPart[] | null`. base64 이미지는 `data:<mime>;base64,<…>` URL로 싣는다.
- 문자열을 전제하던 지점을 도메인 헬퍼로 흡수한다: `messageText(msg): string`(파트 배열이면
  text 파트만 연결), `hasImageParts(msg): boolean`. **호출처가 각자 타입 narrowing 하는 코드를
  흩뿌리지 않는다** — 헬퍼가 유일한 source가 되게 한다.
- 모델 게이트: 이미지 파트가 있는데 대상 모델의 `capabilities.imageInput !== true`면
  `ValidationError`(→ 4xx)로 fast-fail. 조용히 이미지를 떨어뜨리지 않는다.
  fallbackModel도 같은 검사를 받는다(fallback이 vision 미지원이면 이미지 요청은 fallback 금지).
- PII 필터: `engine.ts`의 `maskValues`/`restoreValues`가 값 전체를 재귀 순회하므로 base64
  data URL까지 마스킹 대상이 된다(전화번호 정규식 오탐 + 페이로드 파괴 위험).
  → `image_url.url`은 마스킹/복원에서 **제외**한다. 텍스트 파트만 마스킹.
- `src/domain/`은 프레임워크/AWS/React import 금지 규칙을 유지한다.

**검증**: `tests/engine.test.ts`에 (a) 이미지 파트가 채널까지 그대로 전달됨(fakeChannel로
request body 캡처), (b) `imageInput:false` 모델은 거절, (c) `piiFiltering:true`에서
data URL이 변형되지 않고 텍스트 파트만 마스킹됨 — 테스트 추가. `pnpm typecheck`가
`noUncheckedIndexedAccess` 포함해 통과.

## Phase 2 — Slack 첨부 이미지 인입

- `SlackEventBody.event`에 `files?: Array<{id, mimetype, filetype, url_private_download, size, name}>` 추가.
- `slackClient`에 `downloadFile(token, urlPrivateDownload)` 추가 — `Authorization: Bearer` 헤더로
  받아 `Buffer` 반환. **호스트를 `files.slack.com` / `slack.com`으로 제한**한다(이벤트 페이로드가
  가리키는 URL을 무검증으로 fetch하지 않는다). 기존 `ssrfGuard`는 private IP 차단용이라
  목적이 다르니, 도메인 allowlist를 별도로 둘지 재사용할지는 판단해서 근거를 남긴다.
- 상한을 상수로 명시: `기본안` 이미지 최대 4장, 장당 5MB, 허용 MIME `image/png|jpeg|gif|webp`.
  초과/미지원은 **조용히 버리지 않고** 최종 답변에 `:warning:` 안내를 append
  (기존 실패 append 패턴 `handleSlackEvent.ts:190-202` 재사용).
- 첨부가 있고 `text`가 비면 user 메시지는 이미지 파트만으로 구성한다(빈 문자열 user 메시지 금지).
- 스레드 히스토리(`threadToMessages`)의 과거 첨부까지 다 내려받지는 않는다
  (`기본안`: 현재 이벤트의 첨부만. 토큰·지연 비용 대비 효용이 낮음). 이 선택을 코드 주석 1줄로 남긴다.

**검증**: `tests/handleSlackEvent.test.ts`에 (a) 첨부 1장 → user 메시지에 image_url 파트 포함,
(b) 텍스트 없는 첨부 → 이미지만으로 실행되고 응답이 온다, (c) 10MB 파일 → 이미지 제외 +
경고 append, (d) 허용 안 된 호스트 URL → 다운로드 시도 없음. `fetch`는 `vi.stubGlobal`로 모킹.
**Slack 실환경 검증은 이 작업 범위에서 불가하므로, 완료 보고에 "Slack 실검증 미완료"를 명시한다.**

## Phase 3 — API 표면 (입력 허용 + 이미지 출력)

- `chatMessageSchema`를 파트 배열 허용으로 확장(`predictSchema`/`agentSchema` 공용).
  data URL 크기 상한을 zod 레벨에서 건다(`기본안`: 요청 본문 총합 10MB — `readBodyText`
  상한과 일관되게).
- `src/app/api/projects/_lib/openai.ts`가 `chunk.image`를 응답에 싣게 한다.
  OpenAI 스펙에 대응물이 없어 커스텀 필드가 된다 — **`결정 필요`**:
  `기본안` 비스트림은 최상위 `images: [{b64, mimeType, prompt}]`, 스트림은
  `choices[0].delta.images` (기존 `finish_reason` 계약 `openai.ts:26-36`은 건드리지 않는다).
  다른 안이 더 낫다고 판단하면 plan에서 근거와 함께 제시하고 승인받는다.
- `A2A`/`chat` 소비자는 이미 `chunk.image`를 처리하므로 손대지 않는다.
  `isTopLevelChunk()`로 필터하는 계약을 재유도하지 않고 그대로 쓴다.

**검증**: `tests/openaiCollect.test.ts`에 image chunk가 비스트림/스트림 양쪽 응답에
실리는 테스트 추가. `docs/API.md`에 요청/응답 예시 갱신.

## Phase 4 — 이미지 편집 (EditImage)

- `ImageChannel`에 `editImage({model, prompt, images: [{b64, mimeType}], mask?, size?, quality?, signal})`
  추가 → `images.edit` 어댑터 구현. 생성 경로(`generateImage`)의 usage/비용 집계 규약
  (`textInputTokens + imageInputTokens` / `imageOutputTokens` / `calculateImageCost`)을 그대로 따른다.
- 편집 대상 지목 방법 — **`결정 필요`**: `기본안`은 런 스코프 이미지 핸들.
  이번 런에서 인입된 이미지(Slack 첨부, API 요청 파트)와 생성된 이미지에 `img_1`, `img_2` …
  id를 부여하고, 시스템 프롬프트에 목록을 노출하고, `EditImage(image_id, prompt)`로 참조한다.
  이렇게 하면 base64를 모델 컨텍스트로 왕복시키지 않고도 편집이 가능하다.
- 빌트인 툴 등록은 기존 `GenerateImage`와 동일한 규율을 따른다: `parameters.imageGeneration`
  opt-in에 종속, `buildAgentTools`에서 dep 존재로 노출 결정
  (`engine.ts:720-735`, `runProject.ts:352-397`). **새 버전 파라미터를 임의로 추가하지 말고**
  기존 `imageGeneration` 플래그를 재사용한다(필요하다고 판단되면 plan에서 제안).
- 편집 모델은 `imageModel` 해석 로직(`buildImageGenerator`)을 재사용한다. `images.edit`를
  지원하지 않는 모델이면 툴을 노출하지 않거나 툴 결과로 명시적 에러 문자열을 반환한다
  (조용한 실패 금지).
- `docs/MILESTONES.md:133`에 이미 예고된 `execution/imageTool.ts` 분리와 중복 usage 블록
  정리가 여기서 자연스러우면 **plan에서 별도 항목으로 제안**하고, 승인 없이 같은 커밋에 섞지 않는다.

**검증**: `tests/imageGeneration.test.ts`에 (a) `EditImage`가 핸들의 바이트로 `editImage`를
호출, (b) 알 수 없는 `image_id` → 에러 툴 결과, (c) usage/비용 기록이 생성 경로와 동일 규약,
(d) `imageGeneration:false` 버전엔 툴이 노출되지 않음 — 테스트 추가.

## Phase 5 — 채팅 UI 첨부 (옵션, 승인 시)

`src/app/chats/_components/`에 이미지 첨부 input이 아예 없다. 붙일 경우 클라이언트에서
data URL로 변환해 Phase 3 스키마로 보내고, 사용자 메시지 렌더에 썸네일을 표시한다.
UI 변경은 dev 서버 + 브라우저로 정상 경로/엣지 케이스를 확인하고, 확인 못 했으면
"UI 검증 미완료"를 명시한다.

---

## 지켜야 할 제약

- **외과적 변경**: 변경된 모든 라인이 이 목표에 추적 가능해야 한다. 인접 코드 스타일 통일,
  요청에 없는 타입 힌트·주석 추가, 무관한 dead code 삭제 금지. 발견한 무관 이슈는
  **언급만** 하고 별도 항목으로 분리한다(예: `capabilities.imageInput`이 Phase 1 이후에도
  안 쓰이는 곳이 남는지).
- **의존 규칙**: `app → application → domain ← infrastructure`. route/page에서
  `infrastructure/`를 직접 import 하지 않고, application에서 `container.ts`를 pull 하지 않는다.
- DynamoDB 키 문자열은 `src/infrastructure/db/keys.ts`에서만. 새 리스트 쿼리는 `queryAll()`.
- 시크릿(Slack 봇 토큰)은 기존 `secretEncryption` 규약을 따르고 로그에 남기지 않는다.
  이미지 바이트나 data URL을 `console.log`에 찍지 않는다.
- 테스트는 경계에서만 모킹(`fetch`는 `vi.stubGlobal`, doc client는 `vi.mock`), 실제
  `Date.now`/타이머/랜덤/네트워크 금지.
- 각 Phase마다 `pnpm typecheck && pnpm test`를 돌리고 통과 후 다음 Phase로 넘어간다.
  DB가 걸린 변경이 생기면 `pnpm tsx --env-file=.env.local scripts/integration-check.ts`도 돌린다.

## 보고 형식

각 Phase 종료 시: 변경 파일 목록 / 추가한 테스트와 결과(실제 출력) / 남은 리스크 /
검증하지 못한 것(특히 Slack 실환경, UI). 실패한 테스트는 숨기지 말고 출력과 함께 보고한다.
전체 완료 후 Phase별 커밋 메시지 초안을 제안하고, 커밋·푸시는 내 명시적 허가를 기다린다.

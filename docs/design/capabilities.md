# 케이퍼빌리티

런이 자기 프롬프트 너머로 닿을 수 있는 것: progressive disclosure 로 전달되는 skill, 버전이
dispatch 시점에 검색할 수 있는 글로벌 카탈로그, 그리고 런보다 오래 남는 메모리 — 이것은 이 앱이
저장할 것이 아니다.

그 케이퍼빌리티들이 바인딩되는 서버는 [mcp.md](mcp.md) 다. embedding 모델을 고르는 일과 검색이
잘라내는 하한선은 [CONFIGURATION.md](../CONFIGURATION.md#임베딩-모델-선택) 이고,
discovery 가 PII 필터를 기준으로 어디에 놓이는지는
[SECURITY.md](../SECURITY.md#pii-필터링-그리고-그것이-멈추는-곳) 다.

## Skills

skill 은 **progressive disclosure** 로 전달되는 마크다운 행동 지침이다: 시스템 프롬프트에는 이름 +
설명 표만 실리고, 모델이 빌트인 `Skill` 툴을 호출해 `SKILL.md` 본문을 — 또는 `file_path` 로 특정
첨부 파일을 — 로드한다. 본문은 **그 뒤에 첨부 파일 경로들이 나열된 채로** 제공되고, 제공할 수 없는
`file_path` 도 그 목록을 함께 알려 준다: `file_path` 는 자유 텍스트 추측이라, SKILL.md 가 마침
`references/api.md` 를 언급하지 않는 skill 은 그 파일이 저장되고 인덱싱된 채 닿을 수 없었다. 이는
알 수 없는 agent, 알 수 없는 image id, 알 수 없는 skill 이름이 한 단계 아래에서 이미 받고 있는
것과 같은 답이다.

```ts
Skill { name, description, content (markdown), files?: { path, content }[],
        source?, createdAt, updatedAt }
```

`source` 는 plugins repo 에서 sync 된 skill 을 표시한다 (`github:<repo>#<plugin>` — 그것을 선언한
repo 와 plugin). 그리고 이 값이 고아 항목과 누군가 콘솔에서 직접 쓴 항목을 구별해 주므로, sync 는
자기가 만든 것에 도장을 찍고 자기가 만들지 않은 이름은 결코 보고하지 않는다. `files` 는 skill 루트
아래에서 수집된 첨부 파일이다.

plugins sync (`syncPluginsFromSnapshot`, `src/application/plugin/syncPlugins.ts`) 는
[Agent Plugins 1.0.0](https://agent-plugins.org/) 저장소(`PLUGINS_REPO`)를 읽는다: `plugin.json`
을 가진 디렉터리 하나하나가 plugin 하나이고 (다른 루트 안에 중첩된 루트는 거부된다), 각 plugin 의
skill 은 그 `skills/` 디렉터리의 직계 자식 중 Agent Skills 스펙을 따르는 SKILL.md 를 가진 것들이다
— frontmatter 의 `name` 이 디렉터리 이름과 일치하고, `description` 이 있으며 스펙의 상한 안에 들어야
한다. `plugin.json` 과 `mcp.json` 의 해석은 domain 이 소유하고
(`src/domain/plugin/types.ts`), 트리에서 어느 파일이 plugin·skill·확장 문서인지를 고르는 것은
`src/infrastructure/plugin/snapshot.ts` 의 워커 하나다 — 저장소가 이 배포에 도달하는 두 길,
GitHub 의 트리 API 와 **admin 이 올린 아카이브**(`POST /api/plugins/sync/upload`, GitHub 에 닿지
않는 배포의 sync)가 그것을 공유하므로 어느 디렉터리가 무엇인지는 한 번만 정해진다. 각 소스는
파일을 어떻게 나열하고 읽는지만 건넨다: GitHub 클라이언트는 가져오기만 하고(`GITHUB_API_URL`
로 GitHub Enterprise 도 된다), `archiveSnapshot.ts` 는 tar 를 풀어 같은 스냅샷을 만든다 —
provenance 는 설정된 저장소 아니면 `archive`(`archiveSyncRepo`), 브랜치는 `archive`, commit
은 아카이브의 sha256 이다(업로드의 이름일 뿐, 바뀌었는지는 행마다 내용으로 판정한다). 선택된
파일은 plugin 하나당 동시에 최대 8개만 읽는다. 지원되는 텍스트 첨부 파일은 각
skill 루트 아래에서 수집되며 (`src/domain/skill/files.ts`: `ALLOWED_SKILL_FILE_EXTENSIONS`),
파일당·skill 당·파일 개수 상한으로 제한되고 (값은
[CONFIGURATION.md](../CONFIGURATION.md#코드에-고정된-제한) 에 있다) 심볼릭 링크는 제외된다 —
두 소스 모두 git 의 모드 `120000`(`SYMLINK_MODE`)으로 보고하므로 같은 규칙으로 건너뛰고 같은
이유로 보고된다.
`file_path` 는 정규화되어 skill 루트 안에 갇힌다: 절대 경로 없음, `..` 없음, skill 간 접근 없음.
덮어쓰기는 skill 항목 전체를 교체하므로 낡은 첨부 파일도 함께 사라진다. 건너뛴 파일은 이유와 함께
보고된다.

각 plugin 도 행 하나가 된다 (`src/domain/plugin/types.ts` 의 `Plugin`: manifest 메타데이터와 그것이
선언한 컴포넌트 이름들) — sync 가 무조건 upsert 하는 유일한 대상인데, 그 위에 운영자가 쓴 것이 하나도
없기 때문이다. 콘솔의 Plugins 페이지가 이들을 나열한다.

**저장소는 자기가 선언한 것을 소유하고, 삭제는 사람이 소유한다**
(`src/domain/sync/types.ts` 가 skip 어휘를 소유하고, kind 로 한정된 보고는
`src/domain/plugin/sync.ts` 에 있다): repo 를 출처로 하는 항목은 — 다른 출처에서 넘겨받아
provenance 까지 함께 다시 쓴 것을 포함해 — 자동으로 저장소의 버전에 맞춰지고, 고아가 된 항목은
호출자가 그것을 지목할 때만 삭제된다. sync 계약은
[API.md](../API.md#레지스트리연동-오퍼레이션) 를 보라. 손으로 등록한 항목은 결코 건드리지
않는다.

## 케이퍼빌리티 카탈로그

런이 닿을 수 있는 모든 것 위에 놓인 **글로벌** 인덱스 하나 — 모든 skill, 모든 MCP 서버와 그것이
제공하는 툴, 모든 외부 agent. project 별이 아니다: 그중 어느 것을 특정 런이 쓸 수 있는지는 dispatch
시점에 그 버전의 바인딩으로 정해지며, 그 결정을 이미 내려 둔 인덱스라면 project 가 바뀔 때마다 다시
만들어야 할 것이다.

```
CapabilityEntry { kind: 'skill' | 'mcpServer' | 'mcpTool' | 'agent', name, toolName?, description }
key = kind#name  (or kind#name#toolName)          — src/domain/catalog/types.ts
```

인덱스는 다른 모든 행과 같은 데이터베이스의 `catalog_vectors` 테이블에 산다
(`src/infrastructure/vector/pgVectorStore.ts`, `CATALOG_ENABLED=true` 로 켠다): 키, pgvector
의 `embedding`, 그리고 본문을 실은 `metadata` — mcp-memory 가 정착시킨 방식대로 본문이 행에
타므로 검색이 텍스트를 이미 쥔 채 답하고 fan-out 할 조회가 없다. 거리는 cosine(`<=>`)이고
점수는 그 보수(1 − 거리)라 `CATALOG_MIN_SCORE` 의 의미는 스토어에 붙지 않는다. 벡터 컬럼은
폭을 선언하지 않으며 — 폭은 임베딩 모델의 것, 배포의 설정이다 — 수천 행이라 HNSW 없이 정확
스캔한다. 임베딩 자체는 `EMBEDDING_PROVIDER` 가 정하는 대로 OpenAI 호환 `/embeddings`
엔드포인트(폐쇄망의 vLLM · TEI · Ollama 포함)나 Bedrock 에서 온다.

MCP 서버는 **두 번** 등장하고, 둘은 서로 다른 질문에 답한다. `mcpTool` 항목은 요청이 매칭되는
대상이고 — "PR 에 코멘트를 남긴다" 는 툴의 description 에 있지 다른 어디에도 없다 — `mcpServer` 는
버전이 실제로 바인딩할 수 있는 대상이다. discovery 를 거부하는 서버도 두 번째 항목은 얻는다: 아무도
연결하지 않은 OAuth 서버는 여기서 보면 고장 난 서버와 똑같아 보이는데, 누군가 그것을 연결하려면
필요한 것이 바로 그 항목이다.

`reindexCatalog` 는 인덱스 전체를 다시 쓰고 **그다음에** 자기가 쓰지 않은 것을 지운다. 그 순서가
계약이다: 둘 사이에서 죽으면 다음 tick 이 치울 낡은 항목이 남지만, 반대 순서는 살아 있는 케이퍼빌리티
하나가 빠진 구간을 남겨 검색이 조용히 덜 답하게 만든다. schedule scan·plugins sync 와 같은 CronJob
토큰으로 돌고 (`POST /api/catalog/reindex`), 레지스트리 쓰기에서는 절대 돌지 않는다 — 성공한 저장이
인덱싱 실패 때문에 500 이 되어서는 안 되고, 카탈로그는 런이 *discover 하는* 것에만 영향을 주기
때문이다. prune snapshot은 key를 500개씩 읽고, MCP tool discovery는 registry 순서를 유지한 채
동시에 최대 8개 서버만 probe한다.

**완료된 plugins sync 가 유일한 예외**이고, 차이는 실패가 치를 대가에 있다. sync 는 레지스트리를 한
번에 가장 많이 움직이는 단일 사건이다 — 머지 하나가 skill 과 서버 열댓 개를 한꺼번에 추가·개명·폐기할
수 있다 — 그래서 최대 한 시간을 기다린다는 것은 레지스트리에 더 이상 없는 skill 을 런이 discover
한다는 뜻이 된다. reindex 하는 시점이면 sync 는 이미 커밋됐고 그 보고서도 이미 저장돼 있으므로,
실패해도 바뀌는 것이 없어 로그만 남기고 삼킨다. 다음 tick 이 그것을 고친다. 또한 티커가
없는 배포 — `ticker` 프로파일을 켜지 않은 **로컬** — 가 조금이라도 갱신되는 유일한
경로이기도 하다.

검색은 **여러 개의 쿼리**를 받는다. 런이 자기에게 필요한 것에 대해 할 말이 두 가지이기 때문이다:
버전의 시스템 프롬프트(이 agent 가 대체로 무엇을 위한 것인지)와 가장 최근의 사용자 턴들(지금 무엇을
요청받고 있는지 — 마지막 턴 하나가 아니라 짧은 윈도인데, "첫 번째 것을 리뷰해 줘" 같은 후속 발화는
아무것도 지목하지 않는 반면 그 앞 턴이 전부를 지목했고, 대화가 이미 쓰고 있던 케이퍼빌리티가 사용자가
그것을 되짚는 순간 검색되지 않게 되어서는 안 되기 때문이다). 둘을 하나의 점으로 평균 내면 어느 쪽도
서술하지 못한다. 각 항목은 합이 아니라 자기 최고 점수를 유지하므로, 넓이가 적합도를 앞지르지 않는다.
벡터 위에는 보정이 둘 얹힌다: 무언가를 정확히 지목한 쿼리는 그저 그렇게 읽히기만 하는 description
보다 가산점을 받고, 결과는 **두 개의 하한선 중 더 높은 쪽**으로 잘린다. 비율(최고 점수의 일정
비율)은 강한 후보군이 자기 약한 꼬리까지 끌고 들어오는 것을 막는다. 절대 코사인 값은 embedding 모델이
바뀌면 살아남지 못하므로, 그 부분은 절대값일 수 없다. 하지만 비율만으로는 *아무것도* 매칭되지
않았다는 것을 볼 수 없다 — 나쁜 최고 점수의 절반은 여전히 나쁜 점수이고, 카탈로그에 답할 것이 하나도
없는 요청이 가득 찬 결과를 돌려받는다. `DEFAULT_MIN_SCORE` 가 아니라고 말하는 하한선이다.

두 숫자 모두 검색이 아니라 **embedding 모델**에 속하고, 서로 옮겨지지 않는다 — 이 배포를 Cohere v4
로 정한 실측은 [CONFIGURATION.md](../CONFIGURATION.md#임베딩-모델-선택) 를 보라. 짧게
말하면: 이 레지스트리는 영어로 서술되고 한국어로 질의되는데, 대안들이 풀지 못하는 경우가 바로
그것이다.

**각 쿼리는 자기 최고 점수를 기준으로 순위가 매겨지고 잘린 뒤, 살아남은 것들이 병합된다.** 하나의
컷을 둘이 공유하면 강한 쿼리가 약한 쿼리를 지워 버린다: "당신은 Slack 어시스턴트" 라고 쓰인 시스템
프롬프트는 `slack` 을 0.583 에 놓고, 그래서 합집합 위에서 잡은 비율은 0.408 이 되어 0.393 인
`github` 을 떨어뜨린다 — 요청이 실제로 지목한 바로 그 항목을. 서로 다른 질문을 하는 두 쿼리는 비례
컷을 공유할 수 없다.

**서버 하나는 후보 하나이고, 두 인덱스 중 더 나은 증거로 점수가 매겨진다.** 두 인덱스는 서버 이름당
후보 하나로 병합되고, 각 후보는 자기 tool 히트 점수와 server 히트 점수 중 높은 쪽을 유지한다 — 둘은
하나의 embedding 공간을 공유하고 각 종류가 이미 자기 최고 점수를 기준으로 잘렸으므로 비교 가능하다.
출처 순서로는 안 된다: 모든 tool 히트가 모든 server 히트를 앞서니, 페르소나 프롬프트에 우연히 걸린
tool 매치들이 요청이 직접 지목한 서버들보다 앞서 세 자리를 모두 채웠다. tool 히트는 알고 server
히트는 모르는 것 — *어느* 툴이 매칭됐는지 — 은 순위 특권이 아니라 바인딩의 `tools` 좁히기가 된다.
그래서 discover 된 서버가 자기 카탈로그의 나머지에 런의 툴 예산을 쓰지 않는다. server 인덱스만
도달한 후보는 통째로 바인딩되고 dispatch 시점의 목록 조회가 결정한다.

두 검색 모두 **바인딩 상한을 넘겨 오버샘플링된다** (`src/application/execution/bindings.ts` 의
`DISCOVERY_LIMITS`: 툴은 서버 상한의 네 배, 서버는 세 배). 순회가 후보를 건너뛰기 때문인데 — 이
project 가 연결하지 않은 OAuth 서버, 인덱스가 만들어진 뒤 삭제된 항목 — **건너뛴 후보가 자리 하나를
잡아먹어서는 안 된다**. 상한과 정확히 같은 크기로 잡았을 때는, 연결되지 않은 높은 점수 하나가 요청이
원한 서버들을 굶겼다. 그다음 각 목록은 **점수가 아니라 이름으로 정렬된다**: 순서는 하류에서 아무
의미도 갖지 않지만, 이름이 충돌하는 MCP 툴 중 어느 것이 맨 이름을 유지하는지(alias 할당이 목록
순서대로 서버를 순회하므로, 자리가 바뀌면 히스토리가 replay 하는 툴 호출이 다른 곳으로 간다)와 시스템
프롬프트의 바이트 배치를 결정하고, 프로바이더의 prompt cache 가 그 배치를 키로 삼는다. 점수는
메시지마다 다르게 순위를 매기지만, 이름은 그렇지 않다.

**런 시점의 discovery 는 opt-in 이고 엄격히 덧붙이기만 한다.** `parameters.dynamicCapabilities` 가
그것을 켠다. 그러면 `resolveRunTools` 가 찾아낸 것을 해석 *전에* 버전 자신의 목록에 덧붙이므로,
이후의 모든 단계 — 프롬프트 표, 툴 enum, 도달성 검사 — 는 바인딩된 것과 discover 된 것을 똑같이
다룬다. 바인딩은 결코 밀려나거나 순서가 바뀌거나 잘리지 않는다. 자격 증명이 project 별 OAuth 연결인
MCP 서버는 **그 project 가 이미 연결해 둔 곳에서만** 추가된다 — 콘솔에서 하나를 인가한다는 것은 이
project 가 그것을 써도 된다는 뜻이고, discovery 는 자격 증명을 해석하는 대신 연결 행을 읽는다.
해석했다면 토큰을 갱신하게 되어 discovery 를 쓰기 주체로 만들었을 것이다. 카탈로그가 실패하면 런을
실패시키는 대신 warning 과 함께 바인딩만으로 격하된다 — 카탈로그가 없는 배포에서 discovery 를 요청한 버전도
마찬가지인데, 그러지 않으면 검색이 그냥 아무것도 찾지 못한 경우와 구별되지 않는다.

**무엇을 *찾아냈는가* 는 warning 이 아니다.** `resolveRunTools` 는 그것을 `discovered` 로 따로 반환한다.
예전에는 `warning` chunk 였고, 그것은 discovery 를 켠 버전의 모든 정상 런이 warning 을 하나씩
보고했다는 뜻이었다 — 모든 chat 턴에 노란 경고, 모든 응답에 비어 있지 않은 `warnings`, 그리고 "이
런이 손실을 보고했는가" 를 기준으로 삼는 모든 것이 그 전부에서 발동했다. `collectedWarning` 은 런이
잃은 것을 소유하는데, 케이퍼빌리티를 찾은 것은 그 반대다. 런은 그것을 로그로 남긴다. Playground
프리뷰는 그것을 따로 렌더링하는데, 작성자가 다른 방법으로는 볼 수 없는 유일한 자리이기 때문이다 —
런이 실제로 *쓴* 것은 이미 그 툴 트래픽에 있다.

엔진은 이 중 아무것도 모른다. discovery 는 `assembleAgentRun` 이 이미 받는 배열들을 — 그리고 그것이
돌려주는 버전을 — 넓힐 뿐이고, 그래서 `buildSubagentRunner` 는 모델에게 알려 준 것과 같은 목록으로
dispatch 맵을 만든다. 대신 호출자 자신의 버전을 줬을 때는, discover 된 agent 가 transfer enum 에
앉아 있다가 모델이 그것을 쓰는 순간 `Unknown agent` 라고 답했다.

## 메모리

런보다 오래 남는 것은 **이 앱이 저장할 것이 아니다**. 메모리 서버가 — mcp-memory, 평범한 레지스트리
항목 하나가 — project 의 결정·관례·사실을 보관하고 그것을 툴로 제공한다 (`recall`, `remember`,
`list_memories`, `forget`). 범위는 모든 런이 보내는 tenant 헤더로 한정되고, 런이 자기가 어느 대화에
있는지 알게 된 뒤로는 그 대화까지 함께 알려 준다 (`X-Conversation-Id`, [MCP](mcp.md)). 그 옆에
네이티브 저장소를 두면 "이 project 는 무엇을 기억하는가" 에 대한 두 번째 답이 될 것이고, 런이 무엇에
닿는가에 대한 이 플랫폼의 경계는 MCP 다.

앱이 더하는 것은 툴이 스스로 할 수 없는 단 한 가지다: **모델이 물어볼 생각을 하기 전에 먼저 묻기.**
`parameters.memoryRecall` 을 켠 버전은, `recall` 을 제공하는 모든 바인딩된 서버에 대해 런이 그것을
호출하게 한다 — 그 이름으로. 설정이 아니라 관례인데, 설정이라 해 봐야 언제까지나 이 문자열 하나만
가리킬 것이기 때문이다. 그리고 *바인딩된* 이란 버전 자신의 `mcpList` 를 뜻하지, 이번 요청을 위해
discovery 가 추가한 서버를 뜻하지 않는다. 그쪽의 `recall` 은 모델이 호출할 수 있는 툴로 남을 뿐,
요청마다 묻지도 않았는데 건네지지는 않는다 — 가장 최근의 사용자 턴을 쿼리로 삼아 첫 토큰 전에
호출하고, 돌아온 것을 *What you remember* 블록으로 시스템 프롬프트에 넣는다. 자리는 시계와 caller
뒤, 케이퍼빌리티 절들 앞이다: 런에 대한 사실이며, 지시가 아니라 배경으로 틀 지어진다 — 메모리는
저장된 텍스트이고, 모델이 무언가에 설득당하는 통로가 바로 저장된 텍스트이기 때문이다.
`recallMemories` (`src/application/execution/memoryRecall.ts`) 가 그 전부를 소유한다 — 쿼리 한도,
프롬프트 예산, 타임아웃, 그리고 여러 서버에 걸친 병합 — 그리고 엔진은 그 결과를 입력
필드(`remembered`)로 받는다. 툴 이름만은 `src/domain/project/memoryRecall.ts` 에 있는데, 버전
편집기가 같은 이름을 읽기 때문이다: 회상을 켠 버전에 `recall` 을 제공할 수 있는 바인딩이 하나도
없으면 — 바인딩이 없거나 모든 바인딩의 도구 선택이 그것을 뺐으면 — 편집기가 그 자리에서 경고한다
(`bindingsMayOfferRecall`). 바인딩만으로 확실한 것만 말하고, 바인딩된 서버가 실제로 그 툴을 제공하는지는
프리뷰가 물어서 답한다. caller 를 받는 것과 정확히 같은 방식이다. transfer 로 넘겨진 자식은
자기 버전을 보고 스스로 결정하며, transfer 메시지로 묻는다.

성질 셋이 하중을 진다. **recall 은 결코 런을 끝내지 않는다**: 실패하거나 타임아웃되거나 `Error:` 로
답하는 서버는 `warning` 이 되고 런은 그것 없이 계속된다 — 회상보다 답이 더 값지다. **손실에는 이름을
붙인다**: 플래그를 켰는데 `recall` 을 제공하는 바인딩된 서버가 하나도 없는 버전은, 기억하는 버전인
것처럼 조용히 읽히는 대신 메모리 없이 시작했다고 경고한다. 그리고 **프리뷰는 자기가 보여 줄 수 없는
것을 말한다**: 무엇이 회상되는지는 요청에 달렸는데 프리뷰에는 그 요청이 없으므로, 블록 하나가 빠진
프롬프트를 보여 주는 대신 그 블록이 없다고 보고한다. 툴은 이전처럼 계속 제공된다. recall 은 그 위에
더해지는 것이고, 모델은 런 중간에도 여전히 `remember` 와 `recall` 을 부를 수 있다.

이것이 의도적으로 열어 두는 결정이 둘 있다. *메모리가 어디에 붙는가* — project 에(오늘 mcp-memory
가 하는 방식) 붙는지 대화에 붙는지 — 는 서버의 몫이고, 서버는 이제 두 키를 다 갖고 있다. 그리고
*무엇이 되쓰이는가* 는 `remember` 를 통해 모델의 몫으로 남으며, 요청에 실린 대화와 tenant 가 그
provenance 다. 런 자신은 결코 쓰지 않는다.

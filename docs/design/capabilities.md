# 케이퍼빌리티

Skill 지침, 전역 capability 검색과 외부 Memory를 설명한다.
서버 연결은 [MCP](mcp.md), 설정값은 [CONFIGURATION](../CONFIGURATION.md),
준비 단계의 원문 전송은 [보안](../SECURITY.md#pii-필터링-그리고-그것이-멈추는-곳)을 따른다.

## Skills

Skill은 Markdown 지침과 선택적 참고 파일이다. 시스템 프롬프트에는 이름·설명 표만 넣고
모델이 `Skill`로 본문 또는 `file_path`의 참고 파일을 읽는다. 본문 응답에는 읽을 수 있는
파일 경로도 포함한다. 알 수 없는 경로는 가능한 목록과 함께 오류로 반환한다.

`domain/skill/files.ts`는 확장자·개수·바이트 한도를 소유한다. 경로는 Skill 루트 내부로
정규화하고 절대 경로·`..`·다른 Skill 접근·symlink를 거절한다.
Skill을 교체하면 참고 파일 묶음도 교체하며 생략된 파일은 이유를 보고한다.

### Plugin 동기화

`syncPluginsFromSnapshot`은 GitHub 저장소와 업로드 아카이브의 같은 snapshot을 사용한다.
`infrastructure/plugin/snapshot.ts`가 Plugin·Skill·확장 문서를 찾고
`domain/plugin/types.ts`가 manifest를 해석한다.

| 입력 | 처리 |
|---|---|
| `plugin.json` | 디렉터리를 Plugin 루트로 지정한다. 다른 Plugin 안의 중첩 루트는 거절한다 |
| `skills/<name>/SKILL.md` | 직계 Skill의 frontmatter 이름·설명과 디렉터리 이름을 검증한다 |
| Skill 참고 파일 | 허용 텍스트 파일을 제한된 동시성으로 읽고 한도 초과·symlink를 보고한다 |
| `mcp.json` | streamable-HTTP 서버만 등록한다. stdio·SSE는 보고하고 실행하지 않는다 |
| `org.opspresso.agent-studio/mcp/<server>.md` | MCP의 모델용 설명과 콘솔 운영 노트 |
| `extensions.org.opspresso.agent-studio.mcpSourceOutputs` | 파일 응답을 source reference로 바꾸는 서버별 기본 매핑. [오디오 설계](audio-processing-spec.md#범용-설정과-도구)를 따른다 |

GitHub는 트리·파일을 읽고 아카이브는 같은 인터페이스로 파일을 제공한다.
아카이브 provenance는 설정된 저장소, 없으면 `archive`이며 branch는 `archive`,
commit은 아카이브 hash다. 내용을 비교해 변경을 판정한다. 아카이브 경로 탈출·과대 전개·잘못된
텍스트는 거절한다. 입력·보고 형태는 [Plugins API](../API.md#레지스트리연동-오퍼레이션)에 있다.

동기화는 선언된 이름을 소유한다. 수동 항목이나 다른 출처의 같은 이름도 내용과 provenance를
인수하며, 어떤 Plugin도 선언하지 않은 수동 항목은 보존한다.
부모 Plugin 저장 성공 후에만 그 Plugin의 컴포넌트를 쓴다.

저장소에서 사라진 항목은 orphan으로 보고하며 자동 삭제하지 않는다.
명시적 제거는 해당 유스케이스를 거쳐 권한·감사·managed 컨테이너 정리를 적용한다.
읽을 수 없는 manifest를 빈 선언으로 취급해 orphan을 만들지 않는다.

`mcp.json`의 header는 가져오지 않는다. credential은 콘솔에서 설정하고,
sync로 서버 URL이 바뀌면 이전 주소의 header·OAuth를 새 주소로 보내지 않고 초기화 사실을 보고한다.
등록 URL에는 수동 등록과 같은 정책을 적용한다.
저장소별 lease·예약 실행·아카이브 우선권은 [운영](../OPERATIONS.md#plugins-sync-티커)을 따른다.

## 케이퍼빌리티 카탈로그

`catalog_vectors`는 설치 전역의 Skill·MCP 서버·MCP 도구를 색인한다.
로컬 Project는 자동 검색 대상이 아니며 명시적 하위 Agent binding으로 연결한다.
카탈로그는 실행 권한을 부여하지 않는다. 실제 연결과 정책은 dispatch에서 확인한다.

항목은 `CapabilityEntry { kind, name, toolName?, description }`이며
`kind#name[#toolName]`으로 식별한다. pgvector의 cosine 거리로 정확 검색하고 metadata를
같은 행에 둔다. 별도 벡터 서비스나 HNSW 인덱스를 요구하지 않는다.

`queryCache.ts`는 반복 query의 embedding만 프로세스 내 LRU로 재사용한다.
재색인 문서는 캐시하지 않고 embedding space와 query를 함께 key로 사용한다.
OpenAI 호환 경로는 선택 모델·실제 endpoint·wire ID를, Bedrock 경로는 모델을 space로 구분해
모델 또는 채널 전환 후 이전 query 벡터를 재사용하지 않는다.

### 색인과 모델 전환

`reindexCatalog`는 현재 항목을 먼저 upsert하고 마지막에 잔여 키를 삭제한다.
MCP 서버는 도구 discovery가 실패해도 서버 항목으로 색인하고 `undiscovered`에 보고한다.
도구와 서버가 별도 항목인 이유는 구체적인 기능 검색과 인증되지 않은 서버 발견을 함께 지원하기 위해서다.

일반 registry 편집은 재색인을 수행하지 않는다. 외부 reindex ticker나 수동 요청이 반영한다.
완료된 Plugin sync는 결과 저장 이후 재색인하며, 실패하면 로그를 남기고 다음 tick에 복구한다.
설치 전역 lease가 재색인을 직렬화한다.

Embedding 선택 변경은 새 모델로 재색인을 끝까지 수행하고 실패하면 이전 선택·벡터를 복원한다.
lease의 generation은 해제 후에도 유지한다. 검색은 시작·vector 조회 후·반환 직전에 generation과
활성 상태를 비교해 재색인과 겹친 결과를 사용하지 않는다.
Rerank는 저장 벡터를 바꾸지 않으므로 semantic probe 후 선택만 저장한다.
[모델 선택 API](../API.md#models)와 [설정](../CONFIGURATION.md#임베딩-모델-선택)을 따른다.

### 검색과 순위

`searchCatalog.ts`는 여러 query를 독립적으로 처리한다. 실행 query는 최근 사용자 턴이며 요청 없는 미리보기에서만 시스템 프롬프트를 사용한다.
일반 행동 지침이 현재 요청의 기능을 밀어내지 않도록 분리하며, recall이 있으면 최신 요청과 제한된 기억을 합친 query도 추가한다.
각 capability는 query별 생존 결과의 최고 점수로 합쳐진다.

| 단계 | 계약 |
|---|---|
| query embedding | 같은 query 벡터를 모든 kind에 공유한다 |
| vector 후보 | 종류별로 상한보다 넓게 조회하고 이름을 직접 지목한 경우 보정한다 |
| reranker 미사용·실패 | cosine 절대 하한과 해당 query·kind 최고 점수의 상대 하한 중 높은 값을 적용한다 |
| reranker 사용 | cosine 하한을 미리 적용하지 않고 한 query의 모든 kind 후보를 한 번에 재평가한다 |
| 최종 병합 | query별 하한을 통과한 후보의 최고 점수를 유지하고 종류별 limit으로 자른다 |

reranker 장애는 vector 순위로 돌아가고 실제 런에 warning을 남긴다. 사용자 취소는 즉시 전파한다.
실제 런의 성공한 rerank 사용량은 프로젝트·actor 비용에 포함한다.
preview·모델 선택 probe는 프로젝트 Usage를 만들지 않는다.
임베딩 모델별 점수 분포가 다르므로 다른 모델의 임계값이나 과거 실험 수치를 그대로 쓰지 않는다.

### 실행 시 discovery

`parameters.dynamicCapabilities`를 켜면 `resolveRunTools`가 검색 결과를 명시적 binding 뒤에
추가한다. 기존 binding을 밀어내거나 재정렬하지 않는다.
카탈로그 미구성·검색 실패·query 부재는 경고와 함께 명시적 binding만 제공한다.

MCP 후보는 tool hit와 server hit를 서버 이름으로 합치고 더 높은 점수로 선택한다.
tool hit가 있으면 그 도구들로 binding을 좁히고 server hit만 있으면 서버를 연결한 뒤 목록을 읽는다.
후보를 넉넉하게 읽어 삭제됐거나 연결 권한이 없는 후보가 유효한 슬롯을 차지하지 않게 한다.

OAuth 서버는 해당 프로젝트의 `connected` 연결이 있을 때만 자동 추가한다.
선택한 추가 목록은 이름순으로 정렬해 alias 배정과 프롬프트 배치가 query 점수에 따라 흔들리지 않게 한다.
새 capability는 `discovered`로 반환하며 손실인 warning과 구분한다.
실행은 로그, preview는 별도 목록으로 표시한다.

준비한 Agent 설정과 capability 목록은 SDK Agent 조립과 실제 대상 해석에 함께 사용한다.
최상위 런·로컬 자식·preview의 호출 지점은 `TOOL_RESOLUTION_SITES`가 검사한다.
background 후처리는 discovery·MCP·subagent를 제공하지 않는다.

## 메모리

장기 지식은 연결된 MCP 서버가 보관한다. 앱은 서버의 `recall`·`remember` 등의 도구를
사용하며 저장 범위·ACL·보존은 서버가 결정한다. Chat의 SDK Session은 해당 대화의 모델 이력으로
장기 Memory와 별개다.

`parameters.memoryRecall`은 첫 모델 호출 전에 명시적 MCP binding의 `recall`을 호출한다.
dynamic discovery가 우연히 찾은 서버는 자동 recall 대상이 아니다.
`prepareMemoryForRun`이 회상용 세션을 준비·해제하고 `recallMemories`가
query 제한·타임아웃·병렬 호출·병합을 담당한다. 이름의 정본은 `domain/project/memoryRecall.ts`다.

최근 사용자 요청으로 묻고 결과를 `What you remember` 블록에 배경 데이터로 넣는다.
이 문맥은 capability 검색에도 쓸 수 있지만 기억에서 URL·credential·권한을 생성하지 않는다.
회상 세션과 최종 실행 세션은 같은 사용자·프로젝트의 discovery cache를 재사용할 수 있다.

도구 선택에서 제외하거나 차단·승인 정책에 걸린 recall은 자동 호출하지 않는다.
승인 대상 도구는 SDK의 승인 가능한 경로에 남는다. background 작업은 사전 recall을 하지 않는다.
최상위 승인 재개는 저장된 회상 문맥을 재사용한다.

실패·timeout·오류 결과·대상 부재는 경고로 알리고 기억 없이 계속한다. 사용자 취소는 예외다.
preview도 요청을 주면 같은 준비를 수행하고, 요청이 없으면 회상을 하지 않았다고 알린다.
자동 회상은 읽기뿐이며 런 중 기억 저장은 모델이 연결된 도구를 호출하는 별도 행동이다.

# 문서 엔진

문서 형식 처리는 `src/infrastructure/documents/`가 소유한다. MCP 서버 등록이나
프로젝트 Version binding 없이 동작하며 파일 ID, 사용자 권한, 저장소, 다운로드 URL은
엔진 밖에서 관리한다. 문서의 외부 링크나 매크로는 실행하지 않는다.

## 읽기

`src/infrastructure/llm/documentExtractor.ts`는 첨부와 URL 읽기의 공통 어댑터다.
PDF는 텍스트 레이어를 추출하고 HTML은 활성 내용을 제거하며 평문은 UTF-8을 검증한다.
Office 문서는 내부 `engine/read/`로 전달한다. DOCX, XLSX, PPTX, HWP 5.x, HWPX,
ODT/ODS/ODP, RTF를 지원한다. 암호화 파일, HWP 3.0, 구형 DOC/XLS/PPT는 지원하지 않는다.

Office 읽기는 Markdown으로 표현할 수 있는 내용과 구조를 추출한다. 원본 파일의
보존 편집을 뜻하지 않는다. 읽기 결과의 `complete`, `omissions`, `counts`는
추출 범위와 누락을 나타낸다. 첨부는 `documentLimits.ts`의 더 작은 문자 예산을 적용한다.

## 생성

`DocumentRenderer` 포트는 `src/domain/document/processor.ts`에 정의한다.
`renderer.ts`는 DOCX, PDF, HWPX, PPTX, XLSX 생성기를 조합한다. 앞의 네 형식은
Markdown을 받고 XLSX는 이름이 있는 시트와 셀 배열을 받는다. 수식은 명시적인
`formula` 셀로만 생성하며 `cachedValue`를 계산하거나 검증하지 않는다.

생성은 바이트와 MIME, 개수 정보, 검증 결과를 반환한다. 저장하거나 공개하지 않는다.
결과 파일은 다시 열어 구조를 검증하고, 지원하는 형식은 내부 reader로 내용도 읽는다.
`visual: not_run`은 시각 검증을 하지 않았음을 명시한다.

DOCX, PPTX, PDF는 PNG·JPEG asset을 삽입한다. HWPX와 XLSX에 asset을 전달하면
조용히 버리지 않고 거절한다. PDF의 한글 폰트는 `assets/document-fonts/`에 포함하며
런타임 다운로드를 요구하지 않는다. 폰트의 라이선스는 같은 디렉터리의 `OFL.txt`다.

문서 생성 시각은 호출자가 전달한다. 문서 엔진의 파서·렌더러 회귀 테스트는
`tests/documentEngine/`, 어댑터를 통과하는 읽기·생성 검증은
`tests/nativeDocumentExtractor.test.ts`와 `tests/documentRenderer.test.ts`에 있다.

## 검사와 원본 편집

`DocumentEditor` 포트의 `inspect`는 편집 대상을 돌려주고 `edit`는 원본을 수정하지
않은 채 새 바이트를 반환한다. DOCX·PPTX·HWPX는 `part`, `index`, `text`로 지목하는
텍스트 요소를 검사한다. `replace_text`는 현재 텍스트가 일치하는 단순 텍스트 요소만
교체한다. 문단 추가, 표 구조 변경, 줄바꿈 삽입은 이 연산의 범위가 아니다. 대상 요소
밖의 XML과 나머지 패키지 항목은 보존한다. 텍스트 길이에 따른 배치 변화는 시각 검증이
필요하며 엔진은 시각 검증을 수행했다고 보고하지 않는다.

XLSX 검사는 셀 주소·저장된 값·수식을 보여 준다. 숨긴 시트는 `includeHidden`으로
명시해야 포함한다. `set_cell`은 시트 이름과 셀 주소로 값을 바꾸거나 빈 위치에 셀·행을
추가한다. 셀 스타일과 관계없는 패키지 항목은 보존한다. 입력 셀이 다른 수식의 선행
값일 수 있으므로 모든 시트의 수식 캐시를 제거하고, 기존 계산 체인과 그 선언을
제거하며, 워크북에 열기 시 전체 재계산을 요청한다. 엔진은 수식을 계산하지 않는다.
공유·배열·data-table 수식이 있는 시트는 편집하지 않는다. 병합 영역은 왼쪽 위 셀만
수정할 수 있다.

한 번에 최대 100개 편집을 적용한다. 중복·겹침 대상, 불일치하는 원본 텍스트, 서명 문서,
매크로 워크북은 거절한다. 결과를 반환하기 전에 ZIP을 다시 열고 문서 reader로 읽는다.
`tests/documentEditor.test.ts`는 실제 생성 파일을 편집한 뒤 원본 불변성, 나머지 패키지
항목 보존, 수식 캐시 제거, 손상·모호한 입력 거절을 검증한다.

## 첨부 원본

Chat은 `prepareDocumentAttachments`로 원본을 기존 artifact 저장소에 보관한다.
메시지에는 bounded 추출문과 `file` 참조만 넣는다. 모델에는 파일 ID를 설명하고 저장소
키나 서명 URL을 전달하지 않는다. 조회 화면은 파일 참조를 서명해 원본을 다운로드할 수
있게 한다. 추출에 실패했거나 텍스트 예산을 다 쓴 파일도 보관된 원본 참조는 유지한다.
저장소가 없거나 저장에 실패하면 그 사실을 경고하고 추출문으로 대화를 계속한다.

## 실행 도구

`File`은 agent 실행과 Playground preview에 같은 조건으로 제공하는 기본 도구다.
MCP 등록은 필요하지 않으며 문서 엔진과 artifact 저장소가 구성되어야 한다.
`operation`은 `read`, `inspect`, `create`, `edit`이고 기존 파일은 `file_id`로 지목한다.
읽기와 검사 결과만 모델 문맥에 들어가며, 생성·편집 바이트는 `EngineChunk.file`로
나가 실행 브래킷이 저장한다. `SaveFile`과 `File`의 생성·편집 요청은 런당 파일 상한을
호출 순서대로 공유한다. 파일 ID는 저장 전 예약하며 결과와 실제 artifact 행이 같은
ID를 사용한다. 수정본 행의 `derivedFrom`은 원본 ID를 기록한다.

사용자는 자신에게 귀속된 파일을 읽을 수 있다. 프로젝트 토큰은 시작 프로젝트 안에서
자신의 소유자에게 귀속된 파일만 읽고, 메시징·A2A·trigger actor는 시작 프로젝트 안의
동일 actor 파일만 읽는다. 서브에이전트에서도 시작 프로젝트 범위는 유지한다. 파일 ID나
저장소 키를 안다는 이유만으로 접근을 허용하지 않는다.

`create`는 Markdown 또는 XLSX 시트 배열을 받는다. 이미지 `assets`는 이름에서
PNG·JPEG artifact ID로 가는 매핑이며, 문서에서는 `asset://name`으로 참조한다.
평문·Markdown·CSV·JSON·HTML·SVG 생성은 기존 `SaveFile`을 사용한다. UTF-8 텍스트의
`edit`는 `part: text`, `index: 0`과 한 번만 나타나는 기존 문자열로 교체 대상을 지정한다.
JSON 편집 결과는 구문을 검사한다. 텍스트 편집 결과도 기존 파일을 덮어쓰지 않는다.

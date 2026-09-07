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

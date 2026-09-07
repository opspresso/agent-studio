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

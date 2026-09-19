# 미완료 작업

현재 구현으로 해결되지 않은 작업과 아직 결정이 필요한 범위를 관리한다.
완료된 항목은 제거하며 이력은 git과 GitHub Release에 남긴다.
기존 제품의 동작·제약은 각 설계·운영 문서가 소유한다.

## release-event-gating

현재 [release.yml](../.github/workflows/release.yml)은 `pull_request`와 `v*` tag push를 받지만
`github-release`와 `release` job에는 tag 전용 조건이 없다. 따라서 PR에서도 Release 생성과
이미지 게시 작업을 시도한다. `gitops`에만 tag 조건이 있으며, ECR OIDC trust의 tag 제한은
GitHub Release job의 실행 조건을 대신하지 않는다.

완료 조건:

- PR에서는 게시 권한·registry 로그인·Release 생성 없이 검증 job만 실행한다.
- `v*` tag에서는 검증 성공 뒤 Release·앱/Sandbox 이미지 게시와 GitOps 전달이 실행된다.
- workflow의 이벤트·job 조건과 실제 PR/tag 실행 결과로 두 경로를 확인한다.
- [개발](DEVELOPMENT.md#ci)·[운영](OPERATIONS.md#릴리스-파이프라인)의 현재 제약 설명을 갱신한다.

## 결정이 필요한 범위

| 주제 | 현재 상태 | 구현 전에 정할 것 |
|---|---|---|
| MCP 호환 경로의 수명 | transport의 era 협상과 dynamic client registration을 사용한다 | 협상 결과와 등록 방식의 관측 위치, 기존 원격 서버에 대한 지원 종료 기준. [MCP](design/mcp.md)를 따른다 |
| Slack의 의미 기반 참여 판단 | 코드의 참여 분류와 설정된 키워드를 사용한다 | 판정 모델·비용 귀속·오판 측정 기준. [Slack](design/slack.md#어떤-이벤트가-봇에게-온-것인가)을 따른다 |
| 답변 품질 피드백 | 사용자 평가를 수집·소비하는 제품 흐름이 없다 | 수집 표면·저장 형태·평가를 사용하는 주체·효과의 측정 기준 |

## 관리 기준

항목은 관찰 가능한 완료 조건과 검증 방법을 갖춰야 한다. 외부 서비스나 제품 판단이 필요한
내용은 위 결정 표에 남기고 이미 구현된 것처럼 설명하지 않는다.
식별자는 재사용하지 않는 slug를 사용하고, 항목을 완료하거나 범위를 바꾸면 참조 문서도 함께 고친다.
구조 변경의 완료는 해당 테스트로 확인하며, 기존 검사를 약화한 통과를 완료 근거로 삼지 않는다.

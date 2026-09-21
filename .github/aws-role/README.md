# 릴리스용 AWS OIDC role

[release workflow](../workflows/release.yml)가 앱과 Workspace 이미지를 ECR에 게시할 때 사용하는
role은 `github--agent-studio-ecr`다. 이 디렉터리는 적용할 정책 문서를 제공하며 실제 AWS의
설정 상태를 자동 확인하거나 적용하지 않는다.

| 파일 | 범위 |
|---|---|
| [trust-policy.json](trust-policy.json) | GitHub OIDC, `sts.amazonaws.com` audience, 이 저장소의 `refs/tags/v*` subject |
| [role-policy.json](role-policy.json) | ECR 인증 토큰 획득과 지정된 `agent-studio` repository의 이미지 읽기·업로드 |

정책의 account·region·repository와 workflow의 ARN이 같은 배포를 가리키는지 확인한다.
`ecr:GetAuthorizationToken`은 resource `*`를 사용하지만 이미지 작업은 지정된 repository로 제한된다.
일반 관리자 정책을 붙이지 않는다. GHCR·GitHub Release·GitOps의 권한은 이 AWS role과 별개다.

## 준비와 적용

AWS 계정에 GitHub OIDC provider가 구성되어 있어야 한다. IAM 변경 권한을 가진 배포 관리자가
저장소 루트에서 수행한다. 같은 이름의 role/policy가 이미 있으면 새로 만들지 말고 현재 정책과 비교한다.

```bash
aws iam get-role --role-name github--agent-studio-ecr

# 새 role이 필요한 경우
aws iam create-role --role-name github--agent-studio-ecr \
  --assume-role-policy-document file://.github/aws-role/trust-policy.json
aws iam create-policy --policy-name github--agent-studio-ecr \
  --policy-document file://.github/aws-role/role-policy.json
```

`create-policy`가 반환한 ARN을 확인해 role에 연결한다.

```bash
aws iam attach-role-policy --role-name github--agent-studio-ecr \
  --policy-arn 'arn:aws:iam::<account-id>:policy/github--agent-studio-ecr'
```

기존 role은 `update-assume-role-policy`, 기존 managed policy는
`create-policy-version --set-as-default`로 검토한 문서를 적용한다.
이전 policy version의 수명과 제거는 계정의 IAM 관리 절차를 따른다.

## 확인

tag 실행에서 OIDC role 획득과 지정 repository 게시를 확인하고, PR에는 게시 job이 실행되지
않도록 workflow 조건도 검사한다. AWS의 tag trust만으로 GitHub Release 게시를 제한할 수 없다.
현재 workflow의 게시 조건과 릴리스 완료 판정은
[운영 문서](../../docs/OPERATIONS.md#릴리스-파이프라인)에 있다.

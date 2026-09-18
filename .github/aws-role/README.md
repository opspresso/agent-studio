# AWS OIDC role

The `Release` workflow assumes `github--agent-studio-ecr` only for version tags and
pushes the application and Workspace images to the `agent-studio` ECR repository.

The trust policy intentionally uses only the GitHub OIDC `aud` and `sub` claims.
GitHub's workflow-name claim is not an AWS IAM-supported condition key and must not
be added to the trust policy.

Apply the trust policy and permission policy from this directory when the workflow or
repository identity changes:

```bash
ROLE_NAME=github--agent-studio-ecr
POLICY_ARN=arn:aws:iam::396608815058:policy/github--agent-studio-ecr

aws iam update-assume-role-policy \
  --role-name "$ROLE_NAME" \
  --policy-document file://trust-policy.json

aws iam create-policy-version \
  --policy-arn "$POLICY_ARN" \
  --policy-document file://role-policy.json \
  --set-as-default
```

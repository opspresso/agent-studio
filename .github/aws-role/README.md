# AWS OIDC roles

GitHub Actions uses two separate least-privilege roles. Never apply one role's trust or permission
policy to the other.

| Role | Workflow | Trust policy | Permission policy |
|---|---|---|---|
| `github--agent-studio-ecr` | `Release` on `v*` tags | `trust-policy.json` | `role-policy.json` |
| `github--agent-studio-models` | scheduled `Check models` on `main` | `models-trust-policy.json` | `models-role-policy.json` |

The release trust assumes that `v*` tags are protected so only release operators can create them.
The trust policy uses the tag subject and audience conditions supported by AWS GitHub OIDC;
AWS does not support GitHub's custom workflow claim as an IAM condition.

## Create or update a role

Set one row's values before running the commands:

```bash
export ROLE_NAME="github--agent-studio-ecr"
export TRUST_POLICY="trust-policy.json"
export POLICY_NAME="github--agent-studio-ecr"
export ROLE_POLICY="role-policy.json"
```

For the model check role, use:

```bash
export ROLE_NAME="github--agent-studio-models"
export TRUST_POLICY="models-trust-policy.json"
export POLICY_NAME="github--agent-studio-models"
export ROLE_POLICY="models-role-policy.json"
```

Create the role and policy once:

```bash
aws iam create-role \
  --role-name "${ROLE_NAME}" \
  --assume-role-policy-document "file://${TRUST_POLICY}"

aws iam create-policy \
  --policy-name "${POLICY_NAME}" \
  --policy-document "file://${ROLE_POLICY}"
```

Update an existing role and policy:

```bash
aws iam update-assume-role-policy \
  --role-name "${ROLE_NAME}" \
  --policy-document "file://${TRUST_POLICY}"

export ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
export POLICY_ARN="arn:aws:iam::${ACCOUNT_ID}:policy/${POLICY_NAME}"

aws iam create-policy-version \
  --policy-arn "${POLICY_ARN}" \
  --policy-document "file://${ROLE_POLICY}" \
  --set-as-default
```

Attach the permission policy:

```bash
aws iam attach-role-policy \
  --role-name "${ROLE_NAME}" \
  --policy-arn "${POLICY_ARN}"
```

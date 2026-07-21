# ECS Deployment

Fargate service running the production container behind an ALB.

## One-time setup

1. **ECR repository**: `aws ecr create-repository --repository-name agent-studio`
2. **DynamoDB table** `agent-studio` with `PK`/`SK` keys and `GSI1`/`GSI2`
   (same schema as `scripts/init-local-table.ts`, PAY_PER_REQUEST).
3. **IAM roles**
   - `agent-studio-execution`: `AmazonECSTaskExecutionRolePolicy` + SSM parameter read.
   - `agent-studio-task`: DynamoDB access scoped to the table and its indexes
     (`GetItem, PutItem, DeleteItem, UpdateItem, Query, BatchWriteItem`).
4. **SSM parameters** (SecureString) under `/agent-studio/`:
   `BETTER_AUTH_SECRET`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`,
   `LLM_BASE_URL`, `LLM_API_KEY`, `AES_ENCRYPTION_KEY`, plus any
   `LLM_PROVIDER_*` and Slack credentials you use.
5. **ALB** with an HTTPS listener forwarding to a target group on port 3000,
   health check path `/api/health`.
6. Fill the `<ACCOUNT_ID>` / `<REGION>` / `<YOUR_DOMAIN>` placeholders in
   `task-definition.json` and register it:
   `aws ecs register-task-definition --cli-input-json file://task-definition.json`
7. Create the service (2+ tasks across AZs recommended):
   `aws ecs create-service --cluster <cluster> --service-name agent-studio \
    --task-definition agent-studio --desired-count 2 --launch-type FARGATE ...`

## Operational notes

- `stopTimeout: 120` gives in-flight agent/SSE streams two minutes to drain on
  rolling deploys; node runs as PID 1 (exec-form CMD) so it receives SIGTERM
  directly.
- Google OAuth: add `https://<YOUR_DOMAIN>/api/auth/callback/google` to the
  OAuth client's authorized redirect URIs.
- Continuous deploy: the `deploy` GitHub Actions workflow builds, pushes to
  ECR, and forces a new service deployment. Configure the
  `AWS_DEPLOY_ROLE_ARN` repository variable for OIDC.

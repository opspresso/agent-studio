# EC2 + EIP + nginx Deployment

Single-instance deployment in the GameServer style: EC2 (Amazon Linux 2023) +
Elastic IP + SSM-backed env + Docker container behind nginx with Let's Encrypt.
Cheaper than ECS (no ALB/Fargate) and a good fit for a single-tenant internal tool.

## Runbook

1. **Image**: push to a registry the instance can pull from. The `Publish (ghcr)`
   workflow pushes `ghcr.io/opspresso/agent-studio` on version tags.
2. **Runtime env** (SecureString, one KEY=VALUE per line):
   ```bash
   aws ssm put-parameter --name /env/prod/agent-studio --type SecureString --value "STAGE=prod
   AWS_REGION=ap-northeast-2
   DYNAMODB_TABLE_NAME=agent-studio
   BETTER_AUTH_SECRET=...
   BETTER_AUTH_URL=https://<domain>
   GOOGLE_CLIENT_ID=...
   GOOGLE_CLIENT_SECRET=...
   ALLOWED_EMAIL_DOMAINS=nalbam.com
   LLM_BASE_URL=...
   LLM_API_KEY=...
   AES_ENCRYPTION_KEY=...
   SLACK_BOT_TOKEN=...
   SLACK_SIGNING_SECRET=...
   SLACK_DEFAULT_PROJECT=sample-assistant"
   ```
3. **IAM instance role** (GameServer pattern + DynamoDB):
   - `AmazonSSMManagedInstanceCore` (Run Command redeploys)
   - `ssm:GetParameter` scoped to `/env/prod/agent-studio`
   - DynamoDB `GetItem/PutItem/DeleteItem/UpdateItem/Query/BatchWriteItem`
     scoped to the `agent-studio` table and its indexes
4. **DynamoDB table** `agent-studio` (`PK`/`SK`, `GSI1`, `GSI2` — see
   `scripts/init-local-table.ts` for the schema; PAY_PER_REQUEST).
5. **EC2 + EIP**: launch AL2023 with `user-data.sh` (substitute `__IMAGE__` /
   `__TAG__`), security group `80/443` open (SSH via SSM Session Manager),
   allocate + associate an EIP.
6. **Domain + HTTPS**: Route53 A record → EIP, install
   `nginx.conf` (substitute `__DOMAIN__`) into `/etc/nginx/conf.d/`, then
   `certbot --nginx -d <domain>`. The app port stays bound to `127.0.0.1`, so
   nothing but nginx is reachable from outside.
7. **External URLs after the domain exists**:
   - Google OAuth redirect URI: `https://<domain>/api/auth/callback/google`
   - Slack Events request URL: `https://<domain>/api/slack/events`
8. **Redeploy**: `redeploy.sh <image> <tag>` on the instance, or via
   SSM Run Command from anywhere:
   ```bash
   aws ssm send-command --instance-ids <id> \
     --document-name AWS-RunShellScript \
     --parameters 'commands=["/home/ec2-user/agent-studio/redeploy.sh ghcr.io/opspresso/agent-studio v0.2.0"]'
   ```

## Why the nginx settings matter

Agent runs stream over SSE for minutes. Default nginx proxy buffering and 60s
read timeouts kill idle streams — the same failure class as the HAProxy 60s
idle timeout that bit the reference platform. `proxy_buffering off` +
`proxy_read_timeout 600s` in `nginx.conf` are load-bearing, not tuning.

## Notes

- The container runs with `--stop-timeout 120` and node as PID 1, so redeploys
  drain in-flight streams instead of cutting them.
- `user-data.sh` binds the app to `127.0.0.1:3000` from the start; there is no
  window where the plain app port is publicly reachable.
- Backups: DynamoDB PITR on the table covers data; the instance is disposable.

## Current Deployment

- URL: https://agent-studio.opspresso.com (HTTP redirects to HTTPS)
- Region `ap-northeast-2`, instance `i-0c77198302d5edd9b` (t4g.small, AL2023 arm64), EIP `13.125.167.92`
- Image: ECR `396608815058.dkr.ecr.ap-northeast-2.amazonaws.com/agent-studio:latest`
- Env: SSM `/env/prod/agent-studio`; data: DynamoDB `agent-studio` (TTL on `expiresAt`)
- TLS: Let's Encrypt via certbot --nginx, auto-renewal timer installed
- Redeploy: build/push to ECR, then run `redeploy.sh` via SSM Run Command

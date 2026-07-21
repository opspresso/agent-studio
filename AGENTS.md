# AGENTS.md

Guidance for AI assistants working on Agent Studio. Architecture and layer rules
live in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md); deployment facts and the
runbook live in [deploy/ec2/README.md](deploy/ec2/README.md). This file records
operational knowledge that is not obvious from the code.

## Working Agreements

- Commit every iteration; push and deploy when asked (커밋은 이터레이션마다,
  배포 요청 시 push까지).
- `pnpm typecheck` (strict) and `pnpm test` must stay green; run both before
  committing. Production builds are containers — verify with `docker build`.
- UI text is English; docs and comments may be Korean (~해요체 for Korean docs).

## Deploy Routine ("배포해")

1. `docker build --platform linux/arm64 -t <ECR>/agent-studio:latest .`
2. `docker push` — **then confirm the ECR digest actually changed**; a mangled
   tag once silently redeployed the old image.
3. `git push origin main`
4. SSM Run Command on the instance: `/home/ec2-user/agent-studio/redeploy.sh
   <ECR>/agent-studio latest` (refreshes env from SSM, 120s drain, health gate)
5. `curl https://agent-studio.opspresso.com/api/health`

Runtime env lives in SSM `/env/prod/agent-studio` (SecureString, KEY=VALUE
lines). Changing env only → run redeploy.sh without rebuilding.

## Verifying Authenticated Prod APIs

Google OAuth can't be automated. Create a session directly instead: a temp
script loads `auth.$context`, calls `internalAdapter.createSession`, and signs
the cookie the way better-call does — HMAC-SHA256 over the token, **standard
base64**, then URI-encode `token.signature`. Over HTTPS the cookie name is
`__Secure-better-auth.session_token` (the `__Secure-` prefix is mandatory).
Local equivalent: `scripts/dev-session.ts`. Delete temp scripts after use.

## Gotchas Learned the Hard Way

- **DynamoDB Local namespaces tables by access key + region.** Any script must
  use the same region/credentials as the app client or it sees no tables.
- **Slack read-family Web API methods (`conversations.replies`, …) reject JSON
  POST bodies** (`invalid_arguments`). Use GET with query params; JSON is fine
  for write methods (`chat.postMessage`, `chat.update`).
- **Next standalone output does not include `public/`** — the Dockerfile copies
  it explicitly. Same for any new static asset directory.
- **Never derive externally visible URLs from `request.url`** behind the nginx
  proxy (it resolves to the bind address). Use `config.publicBaseUrl`
  (PUBLIC_BASE_URL → BETTER_AUTH_URL).
- **Repository `toItem`/`fromItem` explicit field mappings silently drop new
  domain fields** — this bit twice (project.slack, skill.source). When adding a
  field to a domain type, update the repository mapping and check the others.
- Skills sync treats the GitHub repo (`opspresso/agent-skills`) as source of
  truth; skill *content* steers the model more strongly than tool descriptions
  — if an agent ignores a builtin tool, check whether a skill instructs
  otherwise (the image-generation skill once told the model to output prompt
  text instead of calling GenerateImage).
- Slack replies stream via throttled `chat.update` (1s); tool activity is shown
  while the first turn runs. The handler has a 3-minute deadline and logs
  `[slack] run start/done` breadcrumbs — read container logs first when a
  reply stalls.

## Pending

- Replace the broad personal `GITHUB_TOKEN` in prod SSM with a fine-grained
  PAT scoped to `opspresso/agent-skills` (Contents: Read-only), then redeploy.

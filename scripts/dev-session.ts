/**
 * Create a local development user + session directly in DynamoDB and print a
 * signed session cookie for exercising authenticated API routes without the
 * Google OAuth round-trip. Local development only.
 *
 *   DYNAMODB_ENDPOINT_URL=http://localhost:8001 pnpm tsx scripts/dev-session.ts
 */
process.env.STAGE ??= "local";
process.env.DYNAMODB_ENDPOINT_URL ??= "http://localhost:8001";
process.env.BETTER_AUTH_SECRET ??= "dev-secret";

const endpoint = process.env.DYNAMODB_ENDPOINT_URL;
if (!endpoint.includes("localhost") && !endpoint.includes("127.0.0.1")) {
  console.error(`Refusing to run against non-local endpoint: ${endpoint}`);
  process.exit(1);
}

async function main() {
  const { auth } = await import("@/lib/auth");
  const { createHmac } = await import("node:crypto");

  const ctx = await auth.$context;
  const email = "dev@example.com";

  let user = await ctx.internalAdapter.findUserByEmail(email).then((r) => r?.user ?? null);
  if (!user) {
    user = await ctx.internalAdapter.createUser({
      email,
      name: "Local Dev",
      emailVerified: true,
    });
  }
  const session = await ctx.internalAdapter.createSession(user.id, false);
  // Matches better-call's signCookieValue: HMAC-SHA256 over the token,
  // standard base64, then the whole `token.signature` value URI-encoded.
  const signature = createHmac("sha256", ctx.secret).update(session.token).digest("base64");
  const cookie = `better-auth.session_token=${encodeURIComponent(`${session.token}.${signature}`)}`;

  const verified = await auth.api.getSession({ headers: new Headers({ cookie }) });
  if (!verified) {
    console.error("Cookie construction failed verification against auth.api.getSession");
    process.exit(1);
  }
  console.log(`verified session for ${verified.user.email}`);
  console.log(`COOKIE=${cookie}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

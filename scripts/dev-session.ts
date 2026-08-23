/**
 * Create a local development user + session directly in the database and
 * print a signed session cookie for exercising authenticated API routes
 * without an identity-provider round-trip. Local development only.
 *
 *   pnpm tsx scripts/dev-session.ts        # dev database on :5432
 */
process.env.STAGE ??= "local";
process.env.DATABASE_URL ??= "postgres://agent_studio:agent_studio@localhost:5432/agent_studio";
process.env.BETTER_AUTH_SECRET ??= "dev-secret";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl.includes("localhost") && !databaseUrl.includes("127.0.0.1")) {
  console.error(`Refusing to run against a non-local database: ${databaseUrl}`);
  process.exit(1);
}

async function main() {
  const { migrate } = await import("@/infrastructure/db/migrations");
  await migrate();
  const { auth } = await import("@/lib/auth");
  const { createHmac } = await import("node:crypto");

  const ctx = await auth.$context;
  const { config } = await import("@/lib/config");
  const email = `dev@${config.allowedEmailDomains[0] ?? "example.com"}`;

  let user = await ctx.internalAdapter.findUserByEmail(email).then((r) => r?.user ?? null);
  if (!user) {
    user = await ctx.internalAdapter.createUser(
      { email, name: "Local Dev", emailVerified: true },
      { method: "admin" },
    );
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
  const { closePool } = await import("@/infrastructure/db/client");
  await closePool();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

export {};

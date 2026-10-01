import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { createServer } from "node:http";
import { once } from "node:events";
import { Pool } from "pg";
import { assertLocalDatabase } from "./local-database";

/** The real app auth singleton, a disposable PostgreSQL schema and a local OIDC issuer. */
async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL ?? "postgres://agent_studio:agent_studio@localhost:5432/agent_studio_test";
  assertLocalDatabase(databaseUrl, true);
  const schema = `keycloak_${randomUUID().replaceAll("-", "")}`;
  const adminPool = new Pool({ connectionString: databaseUrl });
  const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const jwk = { ...publicKey.export({ format: "jwk" }), kid: "test-key", alg: "RS256", use: "sig" };
  const baseURL = "http://localhost:3300";
  const clientId = "studio-integration";
  const clientSecret = "local-fixture-client-secret";
  const codes = new Map<string, { nonce: string; challenge: string; email: string; subject: string; audience: string; provider: string; name: string; picture?: string }>();
  let issuer = "";
  const server = createServer(async (req, res) => {
    const json = (body: unknown) => { res.setHeader("content-type", "application/json"); res.end(JSON.stringify(body)); };
    try {
      if (req.url?.endsWith("/.well-known/openid-configuration")) {
        json({
          issuer,
          authorization_endpoint: `${issuer}/protocol/openid-connect/auth`,
          token_endpoint: `${issuer}/protocol/openid-connect/token`,
          userinfo_endpoint: `${issuer}/protocol/openid-connect/userinfo`,
          end_session_endpoint: `${issuer}/protocol/openid-connect/logout`,
          jwks_uri: `${issuer}/protocol/openid-connect/certs`,
          id_token_signing_alg_values_supported: ["RS256"],
          response_types_supported: ["code"],
          subject_types_supported: ["public"],
        });
      } else if (req.url?.endsWith("/certs")) {
        json({ keys: [jwk] });
      } else if (req.url?.endsWith("/token")) {
        let body = "";
        for await (const chunk of req) body += String(chunk);
        const form = new URLSearchParams(body);
        const code = form.get("code") ?? "";
        const entry = codes.get(code);
        assert.ok(entry, "authorization code belongs to this fixture");
        codes.delete(code);
        assert.equal(form.get("client_id"), clientId);
        assert.equal(form.get("client_secret"), clientSecret);
        assert.equal(form.get("redirect_uri"), `${baseURL}/api/auth/callback/${entry.provider}`);
        assert.equal(form.get("grant_type"), "authorization_code");
        assert.equal(createHash("sha256").update(form.get("code_verifier") ?? "").digest("base64url"), entry.challenge);
        const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
        const now = Math.floor(Date.now() / 1000);
        const unsigned = `${encode({ alg: "RS256", kid: "test-key", typ: "JWT" })}.${encode({
          iss: issuer, aud: entry.audience, sub: entry.subject, email: entry.email, email_verified: true,
          name: entry.name, picture: entry.picture, nonce: entry.nonce, iat: now, exp: now + 300,
        })}`;
        json({ access_token: "fixture-access-token", token_type: "Bearer", expires_in: 300,
          id_token: `${unsigned}.${sign("RSA-SHA256", Buffer.from(unsigned), privateKey).toString("base64url")}` });
      } else {
        res.statusCode = 404;
        json({ error: "not_found" });
      }
    } catch {
      res.statusCode = 400;
      json({ error: "invalid_grant" });
    }
  });
  let closePool: (() => Promise<void>) | undefined;
  try {
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    issuer = `http://127.0.0.1:${address.port}/realms/corp`;
    await adminPool.query(`CREATE SCHEMA "${schema}"`);
    const scopedUrl = new URL(databaseUrl);
    scopedUrl.searchParams.set("options", `-c search_path=${schema},public`);
    Object.assign(process.env, {
      DATABASE_URL: scopedUrl.toString(), STAGE: "local", BETTER_AUTH_URL: baseURL,
      BETTER_AUTH_SECRET: randomUUID() + randomUUID(), PUBLIC_BASE_URL: baseURL,
      KEYCLOAK_ISSUER: issuer, KEYCLOAK_CLIENT_ID: clientId, KEYCLOAK_CLIENT_SECRET: clientSecret,
      GOOGLE_CLIENT_ID: "", GOOGLE_CLIENT_SECRET: "", OIDC_ISSUER: issuer, OIDC_CLIENT_ID: clientId, OIDC_CLIENT_SECRET: clientSecret, AUTH_PASSWORD: "false",
      ALLOWED_EMAIL_DOMAINS: "example.test", ADMIN_EMAILS: "ops@example.test",
    });
    const db = await import("@/infrastructure/db/client");
    closePool = db.closePool;
    const { migrate } = await import("@/infrastructure/db/migrations");
    await migrate();
    const { auth } = await import("@/lib/auth");
    const ctx = await auth.$context;
    await ctx.checkSchema?.();

    const cookieHeader = (response: Response) => response.headers.getSetCookie().map((cookie) => cookie.split(";")[0]).join("; ");
    async function login(email: string, overrides: { audience?: string; nonce?: string; state?: string; provider?: "keycloak" | "oidc"; subject?: string; name?: string; picture?: string } = {}) {
      const provider = overrides.provider ?? "keycloak";
      const start = await auth.handler(new Request(`${baseURL}/api/auth/sign-in/social`, {
        method: "POST", headers: { "content-type": "application/json", origin: baseURL },
        body: JSON.stringify({ provider, callbackURL: "/agents?tab=mine" }),
      }));
      assert.equal(start.status, 200);
      const authorization = new URL((await start.json()).url);
      assert.equal(authorization.origin + authorization.pathname, `${issuer}/protocol/openid-connect/auth`);
      assert.equal(authorization.searchParams.get("code_challenge_method"), "S256");
      assert.deepEqual(authorization.searchParams.get("scope")?.split(" ").sort(), ["email", "openid", "profile"]);
      assert.ok(authorization.searchParams.get("nonce"));
      const code = randomUUID();
      codes.set(code, {
        email, subject: overrides.subject ?? email, audience: overrides.audience ?? clientId, provider,
        name: overrides.name ?? "OIDC Test User", picture: overrides.picture,
        nonce: overrides.nonce ?? authorization.searchParams.get("nonce")!,
        challenge: authorization.searchParams.get("code_challenge")!,
      });
      const callback = new URL(`${baseURL}/api/auth/callback/${provider}`);
      callback.searchParams.set("code", code);
      callback.searchParams.set("state", overrides.state ?? authorization.searchParams.get("state")!);
      return auth.handler(new Request(callback, { headers: { cookie: cookieHeader(start) } }));
    }

    const first = await login("member@example.test", { picture: `${issuer}/avatar-before.png` });
    assert.equal(first.status, 302);
    assert.equal(first.headers.get("location"), "/agents?tab=mine");
    const session = await auth.api.getSession({ headers: new Headers({ cookie: cookieHeader(first) }) });
    assert.equal(session?.user.email, "member@example.test");
    assert.equal(session?.user.tier, "guest");
    assert.equal(session.user.name, "OIDC Test User");
    assert.equal(session.user.image, `${issuer}/avatar-before.png`);
    await ctx.internalAdapter.updateUser(session.user.id, { tier: "member" });
    const second = await login("member@example.test", { name: "Updated Keycloak User", picture: `${issuer}/avatar-after.png` });
    const repeat = await auth.api.getSession({ headers: new Headers({ cookie: cookieHeader(second) }) });
    assert.equal(repeat?.user.id, session.user.id);
    assert.equal(repeat.user.name, "Updated Keycloak User");
    assert.equal(repeat.user.image, `${issuer}/avatar-after.png`);
    assert.equal(repeat.user.tier, "member");
    const stored = (await db.getPool().query(`SELECT name, image, tier FROM "user" WHERE id = $1`, [session.user.id])).rows[0];
    assert.deepEqual(stored, { name: "Updated Keycloak User", image: `${issuer}/avatar-after.png`, tier: "member" });
    const earlierSession = await auth.api.getSession({ headers: new Headers({ cookie: cookieHeader(first) }) });
    assert.equal(earlierSession?.user.name, repeat.user.name);
    assert.equal(earlierSession?.user.image, repeat.user.image);
    const withoutPicture = await login("member@example.test", { name: "Renamed Keycloak User" });
    const noPictureSession = await auth.api.getSession({ headers: new Headers({ cookie: cookieHeader(withoutPicture) }) });
    assert.equal(noPictureSession?.user.name, "Renamed Keycloak User");
    assert.equal(noPictureSession?.user.image, repeat.user.image, "missing provider picture preserves the stored image");
    const renamedEmail = await login("renamed@example.test", { subject: "member@example.test", name: "Same Identity", picture: `${issuer}/renamed.png` });
    const renamedSession = await auth.api.getSession({ headers: new Headers({ cookie: cookieHeader(renamedEmail) }) });
    assert.equal(renamedSession?.user.id, session.user.id);
    assert.equal(renamedSession?.user.email, "member@example.test", "profile sync must preserve the ownership email");
    assert.equal(renamedSession?.user.name, "Same Identity");
    assert.equal(renamedSession?.user.image, `${issuer}/renamed.png`);
    assert.equal(renamedSession?.user.tier, "member");
    const disallowedProfile = await login("renamed@other.test", { subject: "member@example.test", name: "Refused Profile" });
    assert.match(disallowedProfile.headers.get("location") ?? "", /\/login\?error=EMAIL_DOMAIN_NOT_ALLOWED/);
    assert.doesNotMatch(cookieHeader(disallowedProfile), /session_token=/);
    const preserved = await ctx.internalAdapter.findUserById(session.user.id);
    assert.equal(preserved?.email, "member@example.test");
    assert.equal(preserved?.name, "Same Identity", "a disallowed profile must not be persisted");
    assert.equal((await db.getPool().query(`SELECT count(*)::int AS count FROM account WHERE "providerId" = 'keycloak'`)).rows[0].count, 1);
    const oidcFirst = await login("oidc-member@example.test", { provider: "oidc", name: "OIDC User", picture: `${issuer}/oidc-before.png` });
    const oidcInitial = await auth.api.getSession({ headers: new Headers({ cookie: cookieHeader(oidcFirst) }) });
    const oidcSecond = await login("oidc-member@example.test", { provider: "oidc", name: "Updated OIDC User", picture: `${issuer}/oidc-after.png` });
    const oidcUpdated = await auth.api.getSession({ headers: new Headers({ cookie: cookieHeader(oidcSecond) }) });
    assert.equal(oidcUpdated?.user.id, oidcInitial?.user.id);
    assert.equal(oidcUpdated?.user.name, "Updated OIDC User");
    assert.equal(oidcUpdated?.user.image, `${issuer}/oidc-after.png`);
    const logout = await auth.handler(new Request(`${baseURL}/api/auth/sign-out`, {
      method: "POST", headers: { cookie: cookieHeader(first), origin: baseURL },
    }));
    assert.equal(logout.status, 200);
    assert.deepEqual(await logout.json(), { success: true });
    assert.equal(await auth.api.getSession({ headers: new Headers({ cookie: cookieHeader(first) }) }), null);

    for (const overrides of [{ audience: "wrong-client" }, { nonce: "wrong-nonce" }, { state: "wrong-state" }]) {
      const refused = await login("member@example.test", overrides);
      assert.equal(refused.status, 302);
      assert.match(refused.headers.get("location") ?? "", /\/login\?error=/);
      assert.doesNotMatch(cookieHeader(refused), /session_token=/);
    }
    const refused = await login("outsider@other.test");
    assert.match(refused.headers.get("location") ?? "", /\/login\?error=EMAIL_DOMAIN_NOT_ALLOWED/);
    assert.doesNotMatch(cookieHeader(refused), /session_token=/);
    process.env.ALLOWED_EMAIL_DOMAINS = "other.test";
    const existingRefused = await login("member@example.test");
    assert.match(existingRefused.headers.get("location") ?? "", /\/login\?error=EMAIL_DOMAIN_NOT_ALLOWED/);
    assert.doesNotMatch(cookieHeader(existingRefused), /session_token=/);
    console.log("[ok] Keycloak/OIDC: discovery, PKCE, signed callback, session, profile refresh on repeat login, tier preservation, local logout, audience/nonce/state rejection and new/existing domain denial");
  } finally {
    await closePool?.();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await adminPool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await adminPool.end();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "Keycloak integration check failed");
  process.exitCode = 1;
});

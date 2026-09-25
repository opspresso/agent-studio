import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { betterAuth } from "better-auth";
import { hashPassword } from "better-auth/crypto";
import { migrate } from "@/infrastructure/db/migrations";
import { withTransaction } from "@/infrastructure/db/client";
import { assertLocalDatabase } from "./local-database";

/** Exercise the current schema and auth adapter in a disposable test schema. */
export async function checkAuthSchema(): Promise<void> {
  assertLocalDatabase(process.env.DATABASE_URL!, true);
  const schema = `auth_current_${randomUUID().replaceAll("-", "")}`;
  const password = "local-integration-password";
  const hash = await hashPassword(password);
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, options: `-c search_path=${schema},public`, max: 2 });
  try {
    await withTransaction(async (client) => {
      await client.query(`CREATE SCHEMA "${schema}"`);
      await client.query(`SET LOCAL search_path TO "${schema}", public`);
      await migrate((work) => work(client));
      await client.query(`INSERT INTO "user" (id, name, email, "emailVerified") VALUES ('existing-user', 'Existing', 'existing@example.test', true)`);
      await client.query(`INSERT INTO "account" (id, "accountId", "providerId", issuer, "userId", password)
        VALUES ('existing-account', 'existing-user', 'credential', 'local:credential', 'existing-user', $1)`, [hash]);
      assert.equal((await client.query(`SELECT is_nullable FROM information_schema.columns
        WHERE table_schema = $1 AND table_name = 'account' AND column_name = 'issuer'`, [schema])).rows[0].is_nullable, "YES");
      assert.equal((await client.query(`SELECT count(*)::int AS count FROM pg_indexes WHERE schemaname = $1
        AND indexname = 'account_providerId_accountId_uidx'`, [schema])).rows[0].count, 1);
    });

    const auth = betterAuth({
      database: pool, baseURL: "http://auth-upgrade.test", secret: randomUUID() + randomUUID(),
      emailAndPassword: { enabled: true, disableSignUp: true },
    });
    const ctx = await auth.$context;
    const existing = await auth.api.signInEmail({ body: { email: "existing@example.test", password } });
    assert.equal(existing.user.id, "existing-user", "stored password account signs in");

    const user = await ctx.internalAdapter.createUser({ name: "New", email: "new@example.test", emailVerified: true }, { method: "email-password" });
    const linked = await ctx.internalAdapter.linkAccount({ providerId: "credential", accountId: user.id, userId: user.id, password: await ctx.password.hash(password) });
    assert.equal((await pool.query(`SELECT issuer FROM account WHERE id = $1`, [linked.id])).rows[0].issuer, null);
    const fresh = await auth.api.signInEmail({ body: { email: "new@example.test", password } });
    assert.equal(fresh.user.id, user.id, "new password account signs in without issuer");

    await ctx.internalAdapter.linkAccount({ providerId: "provider-a", accountId: "same-subject", userId: user.id });
    await ctx.internalAdapter.linkAccount({ providerId: "provider-b", accountId: "same-subject", userId: "existing-user" });
    assert.equal((await ctx.internalAdapter.findAccountByKey({ providerId: "provider-a", accountId: "same-subject" }))?.userId, user.id);
    assert.equal((await ctx.internalAdapter.findAccountByKey({ providerId: "provider-b", accountId: "same-subject" }))?.userId, "existing-user");
    await assert.rejects(pool.query(`INSERT INTO account (id, "providerId", "accountId", "userId")
      VALUES ('duplicate-key', 'provider-a', 'same-subject', $1)`, [user.id]), { code: "23505" });
    console.log("[ok] current auth schema: stored/new sign-in, nullable issuer and provider identity isolation");
  } finally {
    await pool.end();
    await withTransaction(async (client) => { await client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); });
  }
}

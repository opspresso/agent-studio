/**
 * One-time migration: a DynamoDB table's contents into this app's PostgreSQL
 * schema.
 *
 * The export is what the AWS CLI writes, page by page, with no SDK here:
 *
 *   aws dynamodb scan --table-name agent-studio --output json > page-1.json
 *   # …and, while the output carries a LastEvaluatedKey:
 *   aws dynamodb scan --table-name agent-studio --output json \
 *     --starting-token "$(jq -c .LastEvaluatedKey page-1.json)" > page-2.json
 *   # or, in one go:
 *   aws dynamodb scan --table-name agent-studio --output json --max-items 1000000 > all.json
 *
 *   DATABASE_URL=postgres://… pnpm tsx scripts/import-dynamodb-export.ts all.json [more.json…]
 *
 * What it does with each item, by key prefix:
 *   AUTH#user#…, AUTH#session#…, AUTH#account#…, AUTH#verification#…
 *       → Better Auth's tables (the library's own Postgres adapter owns them
 *         now; the rows keep their ids, so sessions survive the move)
 *   AUTHUNIQUE#…   → dropped (the unique locks the old adapter needed; the
 *                     tables have unique constraints)
 *   everything else → the `items` table, unchanged — same PK/SK, same
 *                     document, except legacy Telegram destinations gain the
 *                     recency index current reads require
 *
 * Idempotent: rerunning upserts. Run against an empty database or accept that
 * rows present in both are replaced by the export's copy.
 */
import { readFileSync } from "node:fs";
import { withTelegramDestinationIndex } from "@/infrastructure/db/telegramDestinationIndex";

process.env.STAGE ??= "local";

type AttributeValue =
  | { S: string }
  | { N: string }
  | { BOOL: boolean }
  | { NULL: boolean }
  | { L: AttributeValue[] }
  | { M: Record<string, AttributeValue> }
  | { SS: string[] }
  | { NS: string[] }
  | { B: string };

/** DynamoDB JSON → plain JSON, the way the document client would read it. */
function unmarshall(value: AttributeValue): unknown {
  if ("S" in value) return value.S;
  if ("N" in value) return Number(value.N);
  if ("BOOL" in value) return value.BOOL;
  if ("NULL" in value) return null;
  if ("L" in value) return value.L.map(unmarshall);
  if ("M" in value) return unmarshallItem(value.M);
  if ("SS" in value) return value.SS;
  if ("NS" in value) return value.NS.map(Number);
  if ("B" in value) return value.B;
  throw new Error(`unknown attribute shape: ${JSON.stringify(value)}`);
}

function unmarshallItem(item: Record<string, AttributeValue>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(item).map(([key, value]) => [key, unmarshall(value)]));
}

function readItems(path: string): Record<string, unknown>[] {
  const parsed = JSON.parse(readFileSync(path, "utf8")) as
    | { Items?: Record<string, AttributeValue>[] }
    | Record<string, AttributeValue>[];
  const raw = Array.isArray(parsed) ? parsed : (parsed.Items ?? []);
  return raw.map(unmarshallItem);
}

/** The ISO instant Better Auth wrote, parked by the old adapter under `expiresAtIso`. */
function authDate(item: Record<string, unknown>, field: string): Date | null {
  const iso = field === "expiresAt" && typeof item.expiresAtIso === "string" ? item.expiresAtIso : item[field];
  if (typeof iso === "string") {
    const date = new Date(iso);
    return Number.isNaN(date.getTime()) ? null : date;
  }
  if (typeof iso === "number") {
    // A numeric `expiresAt` is the old TTL in seconds.
    return new Date(iso * 1000);
  }
  return null;
}

async function main(): Promise<void> {
  const files = process.argv.slice(2);
  if (files.length === 0) {
    console.error("usage: import-dynamodb-export.ts <scan-output.json> [more.json…]");
    process.exit(1);
  }
  const { migrate } = await import("@/infrastructure/db/migrations");
  await migrate();
  const { withTransaction, closePool } = await import("@/infrastructure/db/client");
  const { toStoredJson } = await import("@/infrastructure/db/storedJson");

  const counts = {
    items: 0,
    user: 0,
    session: 0,
    account: 0,
    verification: 0,
    dropped: 0,
    replacedUsers: 0,
    droppedEnvRefs: 0,
    droppedSettings: 0,
  };

  // Every file's users before any file's sessions: an export paged by
  // `--starting-token` puts a session and its user wherever the page boundary
  // fell, and a session whose user is in another page is not an orphan.
  const userIds = new Set<string>();
  for (const file of files) {
    for (const item of readItems(file)) {
      if (String(item.PK ?? "").startsWith("AUTH#user#")) {
        userIds.add(String(item.id));
      }
    }
  }
  for (const file of files) {
    const items = readItems(file);
    console.log(`${file}: ${items.length} item(s)`);
    // A scan comes back in no order, and a session or account row references
    // its user: users first, then the rest of the auth rows, then everything
    // else. A row whose user the export does not carry is an orphan the old
    // adapter could hold and the foreign key cannot — dropped and counted.
    const rank = (item: Record<string, unknown>): number => {
      const pk = String(item.PK ?? "");
      return pk.startsWith("AUTH#user#") ? 0 : pk.startsWith("AUTH#") ? 1 : 2;
    };
    items.sort((a, b) => rank(a) - rank(b));
    await withTransaction(async (client) => {
      // `email` is unique and the upsert below matches on `id`: a user row the
      // new deployment already made for one of these addresses — the bootstrap
      // administrator a first boot creates — would fail the whole file. That
      // row is the same person with a fresh id and nothing of theirs on it, so
      // it gives way to the exported one; the next boot finds the imported
      // user by email and adds the password back.
      const emails = items
        .filter((item) => rank(item) === 0)
        .map((item) => String(item.email ?? "").toLowerCase())
        .filter(Boolean);
      const replaced = await client.query<{ id: string; email: string }>(
        `DELETE FROM "user" WHERE lower("email") = ANY($1) AND NOT ("id" = ANY($2)) RETURNING "id", "email"`,
        [emails, [...userIds]],
      );
      for (const row of replaced.rows) {
        console.log(`replacing user ${row.email} (${row.id}) with the exported row`);
      }
      counts.replacedUsers += replaced.rowCount ?? 0;
      for (let item of items) {
        const pk = String(item.PK ?? "");
        const sk = String(item.SK ?? "");
        if (!pk || !sk) {
          counts.dropped += 1;
          continue;
        }
        if (pk.startsWith("AUTHUNIQUE#")) {
          counts.dropped += 1;
          continue;
        }
        if (pk.startsWith("AUTH#")) {
          const model = pk.split("#")[1];
          switch (model) {
            case "user":
              await client.query(
                `INSERT INTO "user" ("id", "name", "email", "emailVerified", "image", "createdAt", "updatedAt", "tier", "lastLoginAt")
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
                 ON CONFLICT ("id") DO UPDATE SET "name" = EXCLUDED."name", "email" = EXCLUDED."email",
                   "emailVerified" = EXCLUDED."emailVerified", "image" = EXCLUDED."image",
                   "updatedAt" = EXCLUDED."updatedAt", "tier" = EXCLUDED."tier", "lastLoginAt" = EXCLUDED."lastLoginAt"`,
                [
                  item.id,
                  item.name ?? "",
                  item.email,
                  item.emailVerified === true,
                  item.image ?? null,
                  authDate(item, "createdAt") ?? new Date(),
                  authDate(item, "updatedAt") ?? new Date(),
                  typeof item.tier === "string" ? item.tier : null,
                  authDate(item, "lastLoginAt"),
                ],
              );
              counts.user += 1;
              break;
            case "session":
              if (!userIds.has(String(item.userId))) {
                counts.dropped += 1;
                break;
              }
              await client.query(
                `INSERT INTO "session" ("id", "expiresAt", "token", "createdAt", "updatedAt", "ipAddress", "userAgent", "userId")
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
                 ON CONFLICT ("id") DO UPDATE SET "expiresAt" = EXCLUDED."expiresAt", "updatedAt" = EXCLUDED."updatedAt"`,
                [
                  item.id,
                  authDate(item, "expiresAt") ?? new Date(0),
                  item.token,
                  authDate(item, "createdAt") ?? new Date(),
                  authDate(item, "updatedAt") ?? new Date(),
                  item.ipAddress ?? null,
                  item.userAgent ?? null,
                  item.userId,
                ],
              );
              counts.session += 1;
              break;
            case "account": {
              if (!userIds.has(String(item.userId))) {
                counts.dropped += 1;
                break;
              }
              // Better Auth 1.7 addresses an account by issuer + accountId; rows
              // written by the 1.6 adapter carry no issuer. The library's own
              // namespaces: a password account is `local:credential`, a
              // built-in social provider (Google here) `local:oauth:<id>`.
              const providerId = String(item.providerId ?? "");
              const issuer =
                typeof item.issuer === "string" && item.issuer !== ""
                  ? item.issuer
                  : providerId === "credential"
                    ? "local:credential"
                    : `local:oauth:${encodeURIComponent(providerId)}`;
              await client.query(
                `INSERT INTO "account" ("id", "accountId", "providerId", "issuer", "userId", "accessToken", "refreshToken", "idToken",
                   "accessTokenExpiresAt", "refreshTokenExpiresAt", "scope", "password", "createdAt", "updatedAt")
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
                 ON CONFLICT ("id") DO UPDATE SET "accessToken" = EXCLUDED."accessToken",
                   "refreshToken" = EXCLUDED."refreshToken", "idToken" = EXCLUDED."idToken",
                   "accessTokenExpiresAt" = EXCLUDED."accessTokenExpiresAt",
                   "refreshTokenExpiresAt" = EXCLUDED."refreshTokenExpiresAt", "scope" = EXCLUDED."scope",
                   "updatedAt" = EXCLUDED."updatedAt"`,
                [
                  item.id,
                  item.accountId,
                  providerId,
                  issuer,
                  item.userId,
                  item.accessToken ?? null,
                  item.refreshToken ?? null,
                  item.idToken ?? null,
                  authDate(item, "accessTokenExpiresAt"),
                  authDate(item, "refreshTokenExpiresAt"),
                  item.scope ?? null,
                  item.password ?? null,
                  authDate(item, "createdAt") ?? new Date(),
                  authDate(item, "updatedAt") ?? new Date(),
                ],
              );
              counts.account += 1;
              break;
            }
            case "verification":
              await client.query(
                `INSERT INTO "verification" ("id", "identifier", "value", "expiresAt", "createdAt", "updatedAt")
                 VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT ("id") DO NOTHING`,
                [
                  item.id,
                  item.identifier,
                  item.value,
                  authDate(item, "expiresAt") ?? new Date(0),
                  authDate(item, "createdAt") ?? new Date(),
                  authDate(item, "updatedAt") ?? new Date(),
                ],
              );
              counts.verification += 1;
              break;
            default:
              counts.dropped += 1;
          }
          continue;
        }
        // Two fields name something about the *old* deployment, and both are
        // fixed before the row is written rather than after — the row is what
        // the new deployment reads at its next boot.
        if (Array.isArray(item.envRefs) && item.envRefs.length > 0) {
          // A managed server's `envRefs` were SSM parameter names on the old
          // deployment; here they are env-file paths on the app's host, and
          // the old names would be opened as paths at every boot. Dropped,
          // named, for the operator to re-enter as files.
          console.log(
            `dropping envRefs of ${pk} (${item.envRefs.map(String).join(", ")}): SSM names, not host paths`,
          );
          const { envRefs: _envRefs, ...rest } = item;
          item = rest;
          counts.droppedEnvRefs += 1;
        }
        if (typeof item.artifactAccessMode === "string") {
          // The runtime settings row wins over the environment, so the old
          // deployment's answer to "how does a reader reach an object" would
          // outlive the store it was true of: `public` sends browsers straight
          // at a bucket that is now a MinIO the app alone can reach. Dropped,
          // so the new deployment's ARTIFACT_ACCESS_MODE decides; an admin can
          // set it again on /settings.
          console.log(
            `dropping artifactAccessMode=${item.artifactAccessMode} of ${pk}: it described the old object store`,
          );
          const { artifactAccessMode: _mode, ...rest } = item;
          item = rest;
          counts.droppedSettings += 1;
        }
        // Through the store's own encoding, so a legacy row carrying a NUL
        // lands the way a fresh write would rather than aborting the file.
        item = withTelegramDestinationIndex(item);
        await client.query(
          "INSERT INTO items (pk, sk, data) VALUES ($1, $2, $3) ON CONFLICT (pk, sk) DO UPDATE SET data = EXCLUDED.data",
          [pk, sk, toStoredJson(item)],
        );
        counts.items += 1;
      }
    });
  }
  console.log(
    `imported ${counts.items} item(s) (${counts.droppedEnvRefs} with envRefs dropped, ${counts.droppedSettings} with a stale artifactAccessMode), ${counts.user} user(s) (${counts.replacedUsers} replaced), ${counts.session} session(s), ` +
      `${counts.account} account(s), ${counts.verification} verification(s); dropped ${counts.dropped}`,
  );
  await closePool();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

export {};

import type { MemberRepository } from "@/domain/member/repository";
import { toMemberTier } from "@/domain/member/tiers";
import type { Member } from "@/domain/member/types";
import { sql } from "@/infrastructure/db/client";

/**
 * Members are Better Auth's `user` rows, read here directly: the auth library
 * owns the table and its writes, and this is the one other reader. Column
 * names are the library's (`src/infrastructure/db/migrations.ts` creates
 * them), which is why they are quoted.
 */
interface UserRow {
  id: string;
  name: string;
  email: string;
  image: string | null;
  tier: string | null;
  createdAt: Date | string;
  lastLoginAt: Date | string | null;
}

const COLUMNS = `"id", "name", "email", "image", "tier", "createdAt", "lastLoginAt"`;

function iso(value: unknown): string | null {
  if (typeof value !== "string" && !(value instanceof Date)) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function toMember(row: UserRow): Member | null {
  const joinedAt = iso(row.createdAt);
  if (!joinedAt) {
    return null;
  }
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    image: row.image,
    tier: toMemberTier(row.tier ?? undefined),
    joinedAt,
    lastLoginAt: iso(row.lastLoginAt),
  };
}

export const memberRepository: MemberRepository = {
  async list() {
    const rows = await sql<UserRow>(`SELECT ${COLUMNS} FROM "user" ORDER BY "createdAt"`);
    return rows.flatMap((row): Member[] => {
      const member = toMember(row);
      return member ? [member] : [];
    });
  },

  async getByEmail(email) {
    const rows = await sql<UserRow>(`SELECT ${COLUMNS} FROM "user" WHERE "email" = $1`, [email]);
    const row = rows[0];
    return row ? toMember(row) : null;
  },

  async getById(id) {
    const rows = await sql<UserRow>(`SELECT ${COLUMNS} FROM "user" WHERE "id" = $1`, [id]);
    const row = rows[0];
    return row ? toMember(row) : null;
  },

  async setTier(id, tier) {
    // One column, atomically: the auth library's own update is a
    // read-modify-replace of the whole row, and routing a tier write through
    // it would let a concurrent `lastLoginAt` write revert the tier.
    const rows = await sql<UserRow & { previousTier: string | null }>(
      `UPDATE "user" AS u SET "tier" = $2 ` +
        `FROM (SELECT "id", "tier" AS "previousTier" FROM "user" WHERE "id" = $1 FOR UPDATE) AS before ` +
        `WHERE u."id" = before."id" ` +
        `RETURNING u."id", u."name", u."email", u."image", u."tier", u."createdAt", u."lastLoginAt", before."previousTier"`,
      [id, tier],
    );
    const row = rows[0];
    if (!row) {
      return null;
    }
    const member = toMember(row);
    if (!member) {
      return null;
    }
    return { member, previousTier: toMemberTier(row.previousTier ?? undefined) };
  },
};

/**
 * Better Auth deletes an expired session only when its cookie comes back —
 * a browser that cleared its data, or a sign-in that lapsed before the person
 * returned, leaves its row forever. The retention tick sweeps those here, in
 * the one module that may speak SQL to Better Auth's tables. Bounded per
 * call like the item store's sweep, so a backlog drains over several ticks.
 * (`verification` needs no sweep: the library purges expired rows on every
 * lookup.)
 */
export async function deleteExpiredSessions(now: Date, limit = 5_000): Promise<number> {
  const rows = await sql<{ id: string }>(
    `DELETE FROM "session" WHERE "id" = ANY(ARRAY(SELECT "id" FROM "session" WHERE "expiresAt" <= $1 LIMIT $2)) RETURNING "id"`,
    [now, limit],
  );
  return rows.length;
}

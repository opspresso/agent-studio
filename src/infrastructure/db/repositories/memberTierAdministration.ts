import type { MemberTierAdministration } from "@/domain/member/tierAdministration";
import { withTransaction } from "../client";
import { createMemberRepository } from "./memberRepository";
import { createSettingsRepository } from "./settingsRepository";

export const memberTierAdministration: MemberTierAdministration = {
  withLock: work => withTransaction(async client => {
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", ["member-tier-administration"]);
    return work({
      members: createMemberRepository(async (text, params) => (await client.query(text, params)).rows),
      settings: createSettingsRepository(client),
    });
  }),
};

import { afterEach, describe, expect, it } from "vitest";
import { createMemberUseCases } from "@/application/member/memberUseCases";
import { setAuditSink } from "@/application/audit/recordAudit";
import { NotFoundError } from "@/application/errors";
import type { AuditEvent } from "@/domain/audit/types";
import type { MemberRepository } from "@/domain/member/repository";
import type { Member } from "@/domain/member/types";

const unusedRepositoryRest = {
  getByEmail: async () => null,
  setTier: async () => null,
};

const member = (overrides: Partial<Member> = {}): Member => ({
  id: "u1",
  name: "U",
  email: "u@x.com",
  image: null,
  tier: "member",
  joinedAt: "2026-01-01T00:00:00.000Z",
  lastLoginAt: null,
  ...overrides,
});

afterEach(() => {
  setAuditSink(undefined);
});

describe("member use cases", () => {
  it("lists newest members first without changing the repository result", async () => {
    const stored = [
      member({ id: "old", joinedAt: "2026-01-01T00:00:00.000Z" }),
      member({ id: "new", joinedAt: "2026-02-01T00:00:00.000Z" }),
    ];
    const repository: MemberRepository = { ...unusedRepositoryRest, list: async () => stored };

    const result = await createMemberUseCases(repository).list();

    expect(result.map((m) => m.id)).toEqual(["new", "old"]);
    expect(stored.map((m) => m.id)).toEqual(["old", "new"]);
  });

  describe("me", () => {
    it("returns the member's own row", async () => {
      const stored = member({ tier: "guest" });
      const useCases = createMemberUseCases({
        ...unusedRepositoryRest,
        list: async () => [],
        getByEmail: async (email) => (email === "u@x.com" ? stored : null),
      });
      await expect(useCases.me("u@x.com")).resolves.toEqual(stored);
    });

    it("404s when the row is gone rather than synthesizing one", async () => {
      const useCases = createMemberUseCases({ ...unusedRepositoryRest, list: async () => [] });
      await expect(useCases.me("ghost@x.com")).rejects.toBeInstanceOf(NotFoundError);
    });
  });

  describe("setTier", () => {
    it("returns the updated member and records who changed what", async () => {
      const events: AuditEvent[] = [];
      setAuditSink({ append: async (event) => void events.push(event), listByDay: async () => [] });
      const repository: MemberRepository = {
        list: async () => [],
        getByEmail: async () => null,
        setTier: async (id, tier) =>
          id === "u1" ? { member: member({ tier }), previousTier: "member" } : null,
      };

      const updated = await createMemberUseCases(repository).setTier({
        id: "u1",
        tier: "admin",
        actorEmail: "boss@x.com",
      });

      expect(updated.tier).toBe("admin");
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        actorEmail: "boss@x.com",
        action: "member.set-tier",
        target: "member:u@x.com",
        detail: "member → admin",
      });
    });

    it("404s for an unknown member and records nothing", async () => {
      const events: AuditEvent[] = [];
      setAuditSink({ append: async (event) => void events.push(event), listByDay: async () => [] });
      const useCases = createMemberUseCases({ ...unusedRepositoryRest, list: async () => [] });

      await expect(
        useCases.setTier({ id: "ghost", tier: "admin", actorEmail: "boss@x.com" }),
      ).rejects.toBeInstanceOf(NotFoundError);
      expect(events).toHaveLength(0);
    });
  });
});

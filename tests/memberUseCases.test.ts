import { describe, expect, it } from "vitest";
import { createMemberUseCases } from "@/application/member/memberUseCases";
import type { MemberRepository } from "@/domain/member/repository";

describe("member use cases", () => {
  it("lists newest members first without changing the repository result", async () => {
    const stored = [
      { id: "old", name: "Old", email: "old@example.com", image: null, joinedAt: "2026-01-01T00:00:00.000Z", lastLoginAt: null },
      { id: "new", name: "New", email: "new@example.com", image: null, joinedAt: "2026-02-01T00:00:00.000Z", lastLoginAt: "2026-02-02T00:00:00.000Z" },
    ];
    const repository: MemberRepository = { list: async () => stored };

    const result = await createMemberUseCases(repository).list();

    expect(result.map((member) => member.id)).toEqual(["new", "old"]);
    expect(stored.map((member) => member.id)).toEqual(["old", "new"]);
  });
});

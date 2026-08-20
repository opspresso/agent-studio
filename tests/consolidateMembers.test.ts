import { describe, expect, it } from "vitest";
import {
  type AuthLinkedRow,
  type AuthUserRow,
  planConsolidation,
} from "../scripts/consolidate-members";

const OLD: AuthUserRow = {
  id: "old",
  email: "a@example.com",
  createdAt: "2026-07-22T00:00:00.000Z",
};
const NEW: AuthUserRow = {
  id: "new",
  email: "a@example.com",
  tier: "member",
  createdAt: "2026-08-13T00:00:00.000Z",
  lastLoginAt: "2026-08-16T00:00:00.000Z",
};

const NO_LINKED: AuthLinkedRow[] = [];

describe("planConsolidation", () => {
  it("plans nothing when every email has one row", () => {
    const plan = planConsolidation(
      [OLD, { ...NEW, email: "b@example.com" }],
      new Map([
        ["a@example.com", "old"],
        ["b@example.com", "new"],
      ]),
      NO_LINKED,
      NO_LINKED,
    );

    expect(plan).toEqual({
      merges: [],
      deleteUsers: [],
      deleteAccounts: [],
      deleteSessions: [],
      lockRepairs: [],
    });
  });

  it("keeps the lock's row, merges the earliest join date, and deletes the rest", () => {
    const plan = planConsolidation(
      [OLD, NEW],
      new Map([["a@example.com", "new"]]),
      [
        { id: "acc-old", userId: "old" },
        { id: "acc-new", userId: "new" },
      ],
      [{ id: "sess-old", userId: "old", token: "t1" }],
    );

    expect(plan.merges).toEqual([
      { email: "a@example.com", canonicalId: "new", set: { createdAt: OLD.createdAt } },
    ]);
    expect(plan.deleteUsers).toEqual([{ email: "a@example.com", id: "old" }]);
    expect(plan.deleteAccounts).toEqual(["acc-old"]);
    expect(plan.deleteSessions).toEqual([{ id: "sess-old", userId: "old", token: "t1" }]);
    // The lock already names the kept row — nothing to repair.
    expect(plan.lockRepairs).toEqual([]);
  });

  it("falls back to the most recently seen row and repairs a missing lock", () => {
    const plan = planConsolidation([OLD, NEW], new Map(), NO_LINKED, NO_LINKED);

    expect(plan.merges).toEqual([
      { email: "a@example.com", canonicalId: "new", set: { createdAt: OLD.createdAt } },
    ]);
    expect(plan.deleteUsers).toEqual([{ email: "a@example.com", id: "old" }]);
    expect(plan.lockRepairs).toEqual([{ email: "a@example.com", targetId: "new" }]);
  });

  it("repairs a lock dangling at a row that no longer exists", () => {
    const plan = planConsolidation(
      [OLD, NEW],
      new Map([["a@example.com", "gone"]]),
      NO_LINKED,
      NO_LINKED,
    );

    expect(plan.deleteUsers).toEqual([{ email: "a@example.com", id: "old" }]);
    expect(plan.lockRepairs).toEqual([
      { email: "a@example.com", targetId: "new", observedTargetId: "gone" },
    ]);
  });

  it("takes the stale row's tier and last login when the kept row has none", () => {
    const plan = planConsolidation(
      [
        { ...OLD, tier: "admin", lastLoginAt: "2026-08-12T00:00:00.000Z" },
        { id: "new", email: "a@example.com", createdAt: "2026-08-13T00:00:00.000Z" },
      ],
      new Map([["a@example.com", "new"]]),
      NO_LINKED,
      NO_LINKED,
    );

    expect(plan.merges).toEqual([
      {
        email: "a@example.com",
        canonicalId: "new",
        set: {
          createdAt: OLD.createdAt,
          lastLoginAt: "2026-08-12T00:00:00.000Z",
          tier: "admin",
        },
      },
    ]);
  });

  it("keeps the kept row's tier when both rows store one", () => {
    const plan = planConsolidation(
      [{ ...OLD, tier: "admin" }, NEW],
      new Map([["a@example.com", "new"]]),
      NO_LINKED,
      NO_LINKED,
    );

    expect(plan.merges[0]?.set.tier).toBeUndefined();
  });
});

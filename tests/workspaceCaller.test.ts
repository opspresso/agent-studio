import { describe, expect, it } from "vitest";
import type { RunActor, RunOrigin } from "@/domain/execution/actor";
import { workspaceCaller } from "@/application/workspace/workspaceCaller";

const user = { userId: "studio-user-1", email: "owner@example.com" };

describe("Workspace execution identity", () => {
  it.each(["user", "agent-token"] as const)("uses the authenticated %s identity without an email override", kind => {
    const actor = { kind, id: "owner@example.com" };
    expect(workspaceCaller({ ancestry: [], actor, user, userEmail: "other@example.com" }))
      .toEqual({ user, ownerEmail: actor.id, actor });
  });

  it.each(["slack", "telegram", "teams", "schedule", "webhook"] as const)("keeps the %s actor and uses only a surface-resolved execution identity", kind => {
    const actor = { kind, id: "external-caller" };
    const origin: Partial<RunOrigin> = { ancestry: [], actor };
    expect(workspaceCaller(origin)).toBeUndefined();
    expect(workspaceCaller({ ...origin, user, userEmail: "owner@example.com" }))
      .toEqual({ user, ownerEmail: "owner@example.com", actor });
  });

  it("does not infer a Studio account from actor or override emails", () => {
    expect(workspaceCaller({ ancestry: [], actor: { kind: "user", id: user.email } })).toBeUndefined();
    expect(workspaceCaller({ ancestry: [], actor: { kind: "slack", id: "U1" }, userEmail: user.email })).toBeUndefined();
    expect(workspaceCaller({ ancestry: [], actor: { kind: "user", id: user.email }, user: { ...user, userId: "" } })).toBeUndefined();
    expect(workspaceCaller({ ancestry: [], actor: { kind: "user", id: "another@example.com" }, user })).toBeUndefined();
  });

  it("does not create an execution identity from display data or an absent actor", () => {
    expect(workspaceCaller({ ancestry: [], userEmail: "owner@example.com" })).toBeUndefined();
    expect(workspaceCaller({ ancestry: [], actor: { kind: "slack", id: "U1" }, caller: { displayName: "owner@example.com" } })).toBeUndefined();
    expect(workspaceCaller({ ancestry: [], actor: { kind: "agent-token", id: "" } as RunActor, userEmail: "owner@example.com" })).toBeUndefined();
  });
});

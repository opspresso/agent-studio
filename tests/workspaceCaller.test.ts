import { describe, expect, it } from "vitest";
import type { RunActor, RunOrigin } from "@/domain/execution/actor";
import { workspaceCaller } from "@/application/workspace/workspaceCaller";

describe("Workspace execution identity", () => {
  it.each(["user", "agent-token"] as const)("uses the authenticated %s identity without an email override", kind => {
    const actor = { kind, id: "owner@example.com" };
    expect(workspaceCaller({ ancestry: [], actor, userEmail: "other@example.com" }))
      .toEqual({ ownerEmail: actor.id, actor });
  });

  it.each(["slack", "telegram", "teams", "schedule", "webhook"] as const)("keeps the %s actor and uses only a surface-resolved execution identity", kind => {
    const actor = { kind, id: "external-caller" };
    const origin: RunOrigin = { ancestry: [], actor };
    expect(workspaceCaller(origin)).toBeUndefined();
    expect(workspaceCaller({ ...origin, userEmail: "owner@example.com" }))
      .toEqual({ ownerEmail: "owner@example.com", actor });
  });

  it("does not create an execution identity from display data or an absent actor", () => {
    expect(workspaceCaller({ ancestry: [], userEmail: "owner@example.com" })).toBeUndefined();
    expect(workspaceCaller({ ancestry: [], actor: { kind: "slack", id: "U1" }, caller: { displayName: "owner@example.com" } })).toBeUndefined();
    expect(workspaceCaller({ ancestry: [], actor: { kind: "agent-token", id: "" } as RunActor, userEmail: "owner@example.com" })).toBeUndefined();
  });
});

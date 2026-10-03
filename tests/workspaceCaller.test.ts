import { describe, expect, it } from "vitest";
import { RUN_ACTOR_KINDS } from "@/domain/execution/actor";
import { workspaceCaller } from "@/application/workspace/workspaceCaller";
import { executionIdentity, interactiveIdentity } from "./runIdentity";

const user = interactiveIdentity("owner@example.com").user;

describe("Workspace execution identity", () => {
  it.each(RUN_ACTOR_KINDS)("uses the authenticated %s identity without a second email field", kind => {
    const id = kind === "user" || kind === "agent-token" ? user.email
      : kind === "schedule" || kind === "webhook" ? `demo:${kind}` : "external-caller";
    const identity = executionIdentity({ kind, id }, user.email);
    expect(workspaceCaller({ ancestry: [], ...identity }))
      .toEqual({ ...identity, ownerEmail: user.email });
  });

  it("does not infer a Studio account from actor or display emails", () => {
    expect(workspaceCaller({ ancestry: [], actor: { kind: "user", id: user.email } })).toBeUndefined();
    expect(workspaceCaller({ ancestry: [], actor: { kind: "slack", id: "U1" }, caller: { displayName: user.email } })).toBeUndefined();
    expect(workspaceCaller({ ancestry: [], actor: { kind: "user", id: user.email }, user: { ...user, userId: "" } })).toBeUndefined();
    expect(workspaceCaller({ ancestry: [], actor: { kind: "user", id: "another@example.com" }, user })).toBeUndefined();
    expect(workspaceCaller({ ancestry: [], user })).toBeUndefined();
  });

  it("requires automation grants to match the authenticated account and source", () => {
    const identity = executionIdentity({ kind: "slack", id: "U1" }, user.email);
    expect(workspaceCaller({ ...identity, executionGrant: undefined })).toBeUndefined();
    expect(workspaceCaller({ ...identity, executionGrant: { ...identity.executionGrant!, userId: "another-user" } })).toBeUndefined();
    expect(workspaceCaller({ ...identity, actor: { kind: "slack", id: "U2" } })).toBeUndefined();
  });
});

import type { RunActor, RunIdentity } from "@/domain/execution/actor";

/** Explicit synthetic identities for tests that exercise execution behind the auth boundary. */
export function interactiveIdentity(email = "owner@example.test", userId = `fixture-user:${email}`): RunIdentity {
  return { user: { userId, email }, actor: { kind: "user", id: email } };
}

/** Synthetic ingress proof for facade tests; production resolves these through real authentication. */
export function executionIdentity(actor: RunActor = { kind: "user", id: "owner@example.com" }, email?: string): RunIdentity {
  const user = interactiveIdentity(email ?? (actor.kind === "user" || actor.kind === "agent-token" ? actor.id : "owner@example.com")).user;
  if (actor.kind === "user") return { user, actor };
  const agentName = actor.kind === "webhook" || actor.kind === "schedule" ? actor.id.split(":")[0]! : "source";
  const common = { ...user, agentName };
  const executionGrant = actor.kind === "agent-token" ? { ...common, kind: actor.kind, credentialId: "fixture-token" }
    : actor.kind === "webhook" ? { ...common, kind: actor.kind, triggerId: actor.id.slice(agentName.length + 1), credentialId: "fixture-token" }
    : actor.kind === "schedule" ? { ...common, kind: actor.kind, triggerId: actor.id.slice(agentName.length + 1), revision: "fixture-revision" }
    : { ...common, kind: actor.kind, realm: "fixture-realm", externalId: actor.id };
  return { user, actor, executionGrant };
}

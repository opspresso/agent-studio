import type { RunIdentity } from "@/domain/execution/actor";

/** Explicit synthetic identities for tests that exercise execution behind the auth boundary. */
export function interactiveIdentity(email = "owner@example.test", userId = `fixture-user:${email}`): RunIdentity {
  return { user: { userId, email }, actor: { kind: "user", id: email } };
}

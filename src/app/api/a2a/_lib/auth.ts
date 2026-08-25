import { a2aClientKeyUseCases } from "@/lib/container";
import { getA2aApiKey } from "@/lib/runtime-settings";
import { timingSafeEqualString } from "@/shared/timingSafe";
import { A2A_ACTOR_ID, type RunActor } from "@/domain/execution/actor";

/**
 * The one answer to "is the inbound A2A surface on, and who is calling".
 * Mirrors `projects/_lib/executionAuth.ts`: an app-layer helper the A2A routes
 * share, because four of them ask some part of this question — the JSON-RPC
 * endpoint, the public agent card, and the two console views — and answering it
 * differently in one of them is how a client-key-only deployment ran fine while
 * discovery answered 503 and the console called the feature disabled.
 */

async function hasClientKeys(): Promise<boolean> {
  return a2aClientKeyUseCases.hasAny();
}

/**
 * Whether the surface is enabled at all: the shared key or at least one named
 * client key opens it.
 */
export async function a2aSurfaceEnabled(): Promise<boolean> {
  if (await getA2aApiKey()) {
    return true;
  }
  return hasClientKeys();
}

/**
 * Which identity a presented `X-A2A-Key` authenticates. The shared app key is
 * every caller as one anonymous actor; a named client key is its holder, so
 * their runs are attributed and bounded per client.
 *
 * `unauthorized` and `unconfigured` are distinct on purpose: a wrong key on a
 * configured surface is the caller's error (401), while 503 says the surface is
 * off — answering 503 to a mistyped key sends every retrying HTTP layer into a
 * backoff loop against a credential that will never work.
 */
export type A2aAuth =
  | { status: "ok"; actor: RunActor }
  | { status: "unauthorized" }
  | { status: "unconfigured" };

export async function authenticateA2a(provided: string): Promise<A2aAuth> {
  const sharedKey = await getA2aApiKey();
  if (sharedKey && timingSafeEqualString(provided, sharedKey)) {
    return { status: "ok", actor: { kind: "a2a", id: A2A_ACTOR_ID } };
  }
  if (provided) {
    const clientName = await a2aClientKeyUseCases.verify(provided);
    if (clientName) {
      return { status: "ok", actor: { kind: "a2a", id: clientName } };
    }
  }
  if (sharedKey || (await hasClientKeys())) {
    return { status: "unauthorized" };
  }
  return { status: "unconfigured" };
}

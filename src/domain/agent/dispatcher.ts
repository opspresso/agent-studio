/**
 * Port for calling an external agent.
 *
 * Two methods, not one: a subagent transfer and the registry's "Test message"
 * button have different contracts today — the transfer honours the run's abort
 * signal and carries images back, while the probe sends a bounded smoke request
 * with a placeholder model and turns transport failures into a result. Folding
 * them together would silently change one of the two.
 */

import type { AgentProtocol } from "./types";

export interface RemoteAgentTarget {
  url: string;
  protocol?: AgentProtocol;
  /** Already decrypted for outbound use. */
  headers: Record<string, string>;
}

export type RemoteAgentReply =
  | { ok: true; text: string; images: Array<{ b64: string; mimeType: string }> }
  | { ok: false; error: string };

export type RemoteAgentProbeReply = { ok: true; text: string } | { ok: false; error: string };

export interface RemoteAgentDispatcher {
  /** Subagent transfer. Honours `signal`; an abort propagates rather than returning. */
  send(
    target: RemoteAgentTarget,
    message: string,
    signal?: AbortSignal,
  ): Promise<RemoteAgentReply>;
  /** Registry connectivity check. Bounded, and never throws for a transport fault. */
  probe(target: RemoteAgentTarget, message: string): Promise<RemoteAgentProbeReply>;
}

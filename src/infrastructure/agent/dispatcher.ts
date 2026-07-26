/**
 * {@link RemoteAgentDispatcher} over the A2A client and the OpenAI-compatible
 * client. `send` is the mid-run subagent transfer: a 120s bound, a size-bounded
 * body read, and an error status reported as a failed reply — never as a
 * successful one that happens to carry no text.
 */

import type {
  RemoteAgentDispatcher,
  RemoteAgentReply,
  RemoteAgentTarget,
} from "@/domain/agent/dispatcher";
import { sendA2aMessage } from "@/infrastructure/a2a/client";
import { fetchPublicUrl } from "@/infrastructure/net/publicFetch";
import { readBodyText } from "@/shared/httpBody";
import { sendAgentMessage } from "./agentClient";

const TRANSFER_TIMEOUT_MS = 120_000;
/** Matches the probe and the MCP session: no outbound body is read unbounded. */
const MAX_TRANSFER_RESPONSE_BYTES = 2_000_000;

async function transferOpenAi(
  target: RemoteAgentTarget,
  message: string,
  signal?: AbortSignal,
): Promise<RemoteAgentReply> {
  const response = await fetchPublicUrl(target.url, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...target.headers },
    body: JSON.stringify({ messages: [{ role: "user", content: message }], stream: false }),
    signal: signal
      ? AbortSignal.any([signal, AbortSignal.timeout(TRANSFER_TIMEOUT_MS)])
      : AbortSignal.timeout(TRANSFER_TIMEOUT_MS),
  });
  const body = await readBodyText(response, MAX_TRANSFER_RESPONSE_BYTES);
  // Without this an error status parses as a reply with no `choices`, and the
  // parent model is told the transfer succeeded and returned nothing.
  if (!response.ok) {
    const detail = body.slice(0, 500);
    return { ok: false, error: `HTTP ${response.status}${detail ? `: ${detail}` : ""}` };
  }
  // A 2xx carrying something other than JSON — a proxy interstitial, an HTML
  // error page — is still a failed transfer. Reported in the same shape as the
  // branch above, rather than as a raw SyntaxError the parent model would have
  // to reason about.
  let data: { choices?: Array<{ message?: { content?: string } }> };
  try {
    data = JSON.parse(body) as typeof data;
  } catch {
    return { ok: false, error: `malformed reply: ${body.slice(0, 500)}` };
  }
  return { ok: true, text: data.choices?.[0]?.message?.content ?? "", images: [] };
}

export const remoteAgentDispatcher: RemoteAgentDispatcher = {
  async send(target, message, signal) {
    if (target.protocol === "a2a") {
      const result = await sendA2aMessage(target.url, target.headers, message, signal);
      return result.ok
        ? { ok: true, text: result.text, images: result.images }
        : { ok: false, error: result.error };
    }
    return transferOpenAi(target, message, signal);
  },

  async probe(target, message) {
    if ((target.protocol ?? "openai") === "a2a") {
      return sendA2aMessage(target.url, target.headers, message);
    }
    return sendAgentMessage(target.url, target.headers, message);
  },
};

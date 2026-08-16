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
import { parseAgentReply, sendAgentMessage } from "./agentClient";

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
  const parsed = parseAgentReply(body);
  return parsed.ok ? { ...parsed, images: [] } : parsed;
}

export const remoteAgentDispatcher: RemoteAgentDispatcher = {
  async send(target, message, signal, options) {
    if (target.protocol === "a2a") {
      // The options travel only when there is one to send: without a
      // conversation the call is exactly the call it always was.
      const result = await sendA2aMessage(
        target.url,
        target.headers,
        message,
        signal,
        ...(options?.contextId ? [{ contextId: options.contextId }] : []),
      );
      return result.ok
        ? {
            ok: true,
            text: result.text,
            images: result.images,
            ...(result.contextId ? { contextId: result.contextId } : {}),
          }
        : { ok: false, error: result.error };
    }
    // The OpenAI-shaped protocol has no conversation to continue; a
    // `contextId` handed here has nowhere to go and is not pretended into one.
    return transferOpenAi(target, message, signal);
  },

  async probe(target, message) {
    if ((target.protocol ?? "openai") === "a2a") {
      return sendA2aMessage(target.url, target.headers, message);
    }
    return sendAgentMessage(target.url, target.headers, message);
  },
};

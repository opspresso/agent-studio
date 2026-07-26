/**
 * {@link RemoteAgentDispatcher} over the A2A client and the OpenAI-compatible
 * client. `send` carries the transfer path that used to be inlined in the
 * execution facade — same request shape, same 120s bound, same error handling.
 */

import type {
  RemoteAgentDispatcher,
  RemoteAgentReply,
  RemoteAgentTarget,
} from "@/domain/agent/dispatcher";
import { sendA2aMessage } from "@/infrastructure/a2a/client";
import { fetchPublicUrl } from "@/infrastructure/net/publicFetch";
import { sendAgentMessage } from "./agentClient";

const TRANSFER_TIMEOUT_MS = 120_000;

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
  const data = (await response.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
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

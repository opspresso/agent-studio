import type { EngineChunk } from "@/domain/llm/types";
import type { ExecutionDeps } from "./deps";
import { conversationKey, type RunOrigin } from "@/domain/execution/actor";
import { BlockedUrlError } from "@/domain/security/urlPolicy";
import { externalAgentHeadersContext } from "@/domain/security/secretContext";
import { log } from "@/shared/logger";

export async function* runRemoteSubagent(
  deps: Pick<
    ExecutionDeps,
    "externalAgents" | "urlPolicy" | "cipher" | "remoteAgents" | "remoteConversations"
  >,
  agentName: string,
  message: string,
  signal?: AbortSignal,
  /**
   * Where the transfer came from. Its conversation, with the transferring
   * project (the chain's last element), is what a remote `contextId` is
   * remembered under; without one every transfer is its own conversation.
   */
  origin?: RunOrigin,
): AsyncGenerator<EngineChunk, string> {
  const agent = await deps.externalAgents.get(agentName);
  if (!agent) {
    yield { author: agentName, error: `Remote agent '${agentName}' not found.` };
    return "";
  }
  try {
    await deps.urlPolicy.assertAllowed(agent.url);
  } catch (error) {
    yield {
      author: agentName,
      error: error instanceof BlockedUrlError ? error.message : "Blocked remote agent URL",
    };
    return "";
  }
  const target = {
    url: agent.url,
    protocol: agent.protocol,
    headers: deps.cipher.decryptHeadersForOutbound(
      agent.headers,
      externalAgentHeadersContext(agent.name),
    ),
  };
  // The remote conversation to continue, if this one has been there before.
  // Only an A2A agent has one to continue, and only a run in a conversation
  // has a key to look it up by; a lookup that fails costs a cold start, not
  // the transfer — the read is a hint and is treated as one.
  const projectName = origin?.ancestry.at(-1);
  const key = origin?.conversation ? conversationKey(origin.conversation) : undefined;
  const continuity =
    deps.remoteConversations && agent.protocol === "a2a" && projectName && key
      ? { store: deps.remoteConversations, projectName, key }
      : undefined;
  let hint: { contextId: string; taskId?: string } | null = null;
  if (continuity) {
    try {
      hint = await continuity.store.get(continuity.projectName, agentName, continuity.key);
    } catch (error) {
      log.warn("run", `remote conversation lookup failed for '${agentName}'; starting cold`, error);
    }
  }
  let reply;
  try {
    reply = await deps.remoteAgents.send(
      target,
      message,
      signal,
      hint ? { contextId: hint.contextId, ...(hint.taskId ? { taskId: hint.taskId } : {}) } : undefined,
    );
  } catch (error) {
    signal?.throwIfAborted();
    yield { author: agentName, error: error instanceof Error ? error.message : String(error) };
    return "";
  }
  signal?.throwIfAborted();
  if (!reply.ok) {
    if (continuity && reply.continuation) {
      // Not a failure but a question: the remote parked its task to ask, and
      // the next transfer from this conversation has to answer *that* task
      // rather than open another beside it. The question reaches the parent
      // as the tool error, which is what it can relay to the person.
      try {
        await continuity.store.put(continuity.projectName, agentName, continuity.key, reply.continuation);
      } catch (error) {
        log.warn("run", `remote conversation for '${agentName}' could not be remembered`, error);
      }
    } else if (continuity && hint) {
      // A continuation that failed drops its hint: the remote may have retired
      // the context, and a wrong hint kept costs every transfer until it expires
      // where one dropped costs a single cold start. Not retried now — the remote
      // may already be working, and a second send would run the delegation twice.
      await continuity.store
        .forget(continuity.projectName, agentName, continuity.key)
        .catch((error: unknown) =>
          log.warn("run", `remote conversation for '${agentName}' could not be forgotten`, error),
        );
    }
    yield { author: agentName, error: reply.error };
    return "";
  }
  // Remembered after every successful reply, not only the first: the remote may
  // move a conversation to a new context, and the window is refreshed on use. A
  // task the conversation was parked on is answered now, so none is kept.
  if (continuity && reply.contextId) {
    try {
      await continuity.store.put(continuity.projectName, agentName, continuity.key, {
        contextId: reply.contextId,
      });
    } catch (error) {
      log.warn("run", `remote conversation for '${agentName}' could not be remembered`, error);
    }
  }
  for (const image of reply.images) {
    yield {
      author: agentName,
      // The outbound message may include a transcript added by the parent. It
      // is transport context, not the remote image's prompt, and keeping it as
      // artifact metadata would retain earlier conversation text. The remote
      // protocol does not report the actual generation prompt, so omit it.
      image: { b64: image.b64, mimeType: image.mimeType },
    };
  }
  if (reply.text) {
    yield { author: agentName, delta: { content: reply.text } };
  }
  // An image-only A2A answer still has to say something the parent can act on.
  return reply.text || (reply.images.length ? `Received ${reply.images.length} generated image(s).` : "");
}

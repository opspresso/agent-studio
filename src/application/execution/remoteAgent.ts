import type { EngineChunk } from "@/domain/llm/types";
import type { ExecutionDeps } from "./deps";
import { BlockedUrlError } from "@/domain/security/urlPolicy";
import { externalAgentHeadersContext } from "@/domain/security/secretContext";

export async function* runRemoteSubagent(
  deps: Pick<
    ExecutionDeps,
    "externalAgents" | "urlPolicy" | "cipher" | "remoteAgents"
  >,
  agentName: string,
  message: string,
  signal?: AbortSignal,
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
    headers: deps.cipher.decryptHeadersForOutbound(
      agent.headers,
      externalAgentHeadersContext(agent.name),
    ),
  };
  let reply;
  try {
    reply = await deps.remoteAgents.send(
      target,
      message,
      signal,
    );
  } catch (error) {
    signal?.throwIfAborted();
    yield { author: agentName, error: error instanceof Error ? error.message : String(error) };
    return "";
  }
  signal?.throwIfAborted();
  if (!reply.ok) {
    yield { author: agentName, error: reply.error };
    return "";
  }
  if (reply.text) {
    yield { author: agentName, delta: { content: reply.text } };
  }
  return reply.text;
}

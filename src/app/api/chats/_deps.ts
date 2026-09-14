import { executeAgent } from "@/application/execution/runProject";
import { artifactStorage, executionDeps, runtimeSessions, closeChatWorkspace } from "@/lib/container";
import { chatRepository } from "@/infrastructure/db/repositories/chatRepository";
import { chatRunLogRepository } from "@/infrastructure/db/repositories/chatRunLogRepository";
import { projectRepository } from "@/infrastructure/db/repositories/projectRepository";
import { versionRepository } from "@/infrastructure/db/repositories/versionRepository";
import type { ChatDeps } from "@/application/chat/deps";

/**
 * Composition root for the chat routes: wires the domain ports to concrete
 * adapters and binds the execution engine's `executionDeps` into `runAgent`.
 */
export const chatDeps: ChatDeps = {
  closeWorkspace: closeChatWorkspace,
  runtimeSessions,
  chats: chatRepository,
  runLog: chatRunLogRepository,
  projects: projectRepository,
  versions: versionRepository,
  // Spread whole: `caller` rides through on the same shape the facade takes, and
  // the facade — not this boundary — decides whether the version asked for it.
  runAgent: (params) => executeAgent(executionDeps, params),
  documents: executionDeps.documents,
  // One bundle makes the required "store and signer together" relationship structural.
  ...(artifactStorage ? { artifacts: artifactStorage } : {}),
};

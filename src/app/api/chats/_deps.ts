import { executeAgent } from "@/application/execution/runProject";
import { executionDeps } from "@/lib/container";
import { chatRepository } from "@/infrastructure/db/repositories/chatRepository";
import { projectRepository } from "@/infrastructure/db/repositories/projectRepository";
import { versionRepository } from "@/infrastructure/db/repositories/versionRepository";
import { isImageStoreConfigured, storeImage } from "@/infrastructure/storage/s3ImageStore";
import { documentExtractor } from "@/infrastructure/llm/documentExtractor";
import type { ChatDeps } from "@/application/chat/deps";

/**
 * Composition root for the chat routes: wires the domain ports to concrete
 * adapters and binds the execution engine's `executionDeps` into `runAgent`.
 */
export const chatDeps: ChatDeps = {
  chats: chatRepository,
  projects: projectRepository,
  versions: versionRepository,
  runAgent: (params) => executeAgent(executionDeps, params),
  documents: documentExtractor,
  ...(isImageStoreConfigured() ? { storeImage } : {}),
};

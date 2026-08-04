import { executeAgent } from "@/application/execution/runProject";
import { executionDeps } from "@/lib/container";
import { chatRepository } from "@/infrastructure/db/repositories/chatRepository";
import { projectRepository } from "@/infrastructure/db/repositories/projectRepository";
import { versionRepository } from "@/infrastructure/db/repositories/versionRepository";
import {
  isImageStoreConfigured,
  signImageUrl,
  storeImage,
} from "@/infrastructure/storage/s3ImageStore";
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
  // Spread whole: `caller` rides through on the same shape the facade takes, and
  // the facade — not this boundary — decides whether the version asked for it.
  runAgent: (params) => executeAgent(executionDeps, params),
  documents: documentExtractor,
  // Both or neither: a stored key with no signer is an image nothing can
  // display, which is worse than not persisting it at all.
  ...(isImageStoreConfigured() ? { storeImage, signImageUrl } : {}),
};

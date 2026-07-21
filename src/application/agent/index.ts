import { externalAgentRepository } from "@/infrastructure/db/repositories/externalAgentRepository";
import { createAgentUseCases } from "./agentUseCases";

export * from "./agentUseCases";
export type { SendMessageResult } from "./agentClient";

/** Composition point for the external-agent slice. Route handlers import this instance. */
export const agentUseCases = createAgentUseCases(externalAgentRepository);

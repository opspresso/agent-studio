import { externalAgentRepository } from "@/infrastructure/db/repositories/externalAgentRepository";
import { secretCipher } from "@/infrastructure/crypto/secretCipher";
import { urlPolicy } from "@/infrastructure/net/urlPolicy";
import { createAgentUseCases } from "./agentUseCases";

export * from "./agentUseCases";
export type { SendMessageResult } from "@/infrastructure/agent/agentClient";

/** Composition point for the external-agent slice. Route handlers import this instance. */
export const agentUseCases = createAgentUseCases(externalAgentRepository, secretCipher, urlPolicy);

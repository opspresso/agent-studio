import type { EngineChunk } from "@/domain/llm/types";

/** Producers pause at event boundaries when their output consumer falls behind. */
export type RuntimeEmitter = ((chunk: EngineChunk) => void) & { ready?: () => Promise<void> };

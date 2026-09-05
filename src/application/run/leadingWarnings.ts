import type { EngineChunk } from "@/domain/llm/types";

/** Pull the run before its warnings so first-chunk refusals keep their HTTP status. */
export async function* withLeadingWarnings(
  warnings: string[],
  source: AsyncGenerator<EngineChunk>,
): AsyncGenerator<EngineChunk> {
  try {
    const first = await source.next();
    for (const warning of warnings) {
      yield { warning };
    }
    if (!first.done) {
      yield first.value;
      yield* source;
    }
  } finally {
    await source.return(undefined);
  }
}

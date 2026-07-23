import type { StreamChunk } from "./types";
import { readSse as readSseFrames } from "@/app/_lib/sse";

/** Chat-typed view over the shared SSE frame reader. */
export function readSse(response: Response): AsyncGenerator<StreamChunk> {
  return readSseFrames<StreamChunk>(response);
}

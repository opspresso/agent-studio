/** Monotonic request-to-response time. A paused consumer must not make a model appear faster. */
export function createRequestTimer(now: () => number = () => performance.now()) {
  let durationMs = 0;
  let startedAt: number | undefined;
  async function measure<T>(read: () => Promise<T>): Promise<T> {
    startedAt ??= now();
    try { return await read(); }
    finally { durationMs = Math.max(0, now() - startedAt); }
  }
  return {
    get durationMs() { return durationMs; },
    measure,
    async *iterate<T>(source: AsyncIterable<T>): AsyncGenerator<T> {
      startedAt ??= now();
      for await (const item of source) {
        durationMs = Math.max(0, now() - startedAt);
        yield item;
      }
    },
  };
}

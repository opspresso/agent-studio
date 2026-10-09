/** Time only active request/read waits, excluding downstream backpressure and accounting. */
export function createRequestTimer(now: () => number = () => performance.now()) {
  let durationMs = 0;
  async function measure<T>(read: () => Promise<T>): Promise<T> {
    const start = now();
    try { return await read(); }
    finally { durationMs += Math.max(0, now() - start); }
  }
  return {
    get durationMs() { return durationMs; },
    measure,
    async *iterate<T>(source: AsyncIterable<T>): AsyncGenerator<T> {
      let start = now();
      for await (const item of source) {
        durationMs += Math.max(0, now() - start);
        yield item;
        start = now();
      }
    },
  };
}

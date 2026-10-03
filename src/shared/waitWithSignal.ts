/** Stop waiting on abort; the operation still owns cancellation of its underlying work. */
export async function waitWithSignal<T>(start: () => T | PromiseLike<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    // Register both outcomes before starting work: start may itself abort or
    // throw, and a late rejection after cancellation must remain handled.
    Promise.resolve().then(() => {
      signal.throwIfAborted();
      return start();
    }).then(
      value => { signal.removeEventListener("abort", onAbort); resolve(value); },
      error => { signal.removeEventListener("abort", onAbort); reject(error); },
    );
  });
}

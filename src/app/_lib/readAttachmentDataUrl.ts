/** Browser byte reads shared by image and document staging. */
export function readAttachmentDataUrl(file: File, signal?: AbortSignal): Promise<string> {
  const cancelled = () => new Error(`${file.name}: reading was cancelled`);
  if (signal?.aborted) return Promise.reject(cancelled());

  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    let settled = false;
    const cleanup = () => {
      reader.onload = null;
      reader.onerror = null;
      reader.onabort = null;
      signal?.removeEventListener("abort", cancel);
    };
    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const cancel = () => {
      reader.abort();
      // Abort also settles a read whose native I/O finished before its load
      // callback could deliver the result.
      fail(cancelled());
    };
    reader.onload = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(String(reader.result));
    };
    reader.onerror = () => fail(new Error(`${file.name}: could not be read`));
    reader.onabort = () => fail(cancelled());
    signal?.addEventListener("abort", cancel, { once: true });
    try {
      reader.readAsDataURL(file);
    } catch (error) {
      fail(error);
    }
  });
}

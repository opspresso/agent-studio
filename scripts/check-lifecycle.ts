type CheckCleanup = () => unknown;
export type RegisterCheckCleanup = (cleanup: CheckCleanup) => void;

/** Each check owns its fixtures; all registered releases run before success. */
export async function withCheckLifecycle<T>(check: (cleanup: RegisterCheckCleanup) => Promise<T>): Promise<T> {
  const cleanups: CheckCleanup[] = [];
  let checkFailed = false;
  try {
    return await check(cleanup => { cleanups.push(cleanup); });
  } catch (error) {
    checkFailed = true;
    throw error;
  } finally {
    const failures: unknown[] = [];
    // Reverse acquisition order keeps dependencies alive until their users finish.
    for (const cleanup of cleanups.toReversed()) {
      try {
        await cleanup();
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length > 0) {
      const error = new AggregateError(failures, "Check fixture cleanup failed");
      if (checkFailed) console.error("CHECK CLEANUP FAILURE:", error);
      else throw error;
    }
  }
}

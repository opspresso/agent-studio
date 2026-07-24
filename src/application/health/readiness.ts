export interface ReadinessProbes {
  /** Resolves when the datastore is reachable, rejects otherwise. */
  checkDb(): Promise<void>;
  /** Resolves when the LLM channel is reachable, rejects otherwise. */
  checkLlm(): Promise<void>;
}

export type CheckStatus = "ok" | "unreachable";

export interface ReadinessReport {
  ready: boolean;
  checks: { db: CheckStatus; llm: CheckStatus };
}

async function status(probe: Promise<void>): Promise<CheckStatus> {
  try {
    await probe;
    return "ok";
  } catch {
    return "unreachable";
  }
}

/**
 * Probe every downstream in parallel and aggregate. Failures collapse to
 * "unreachable" — probe error details are never surfaced to the caller.
 */
export async function checkReadiness(probes: ReadinessProbes): Promise<ReadinessReport> {
  const [db, llm] = await Promise.all([status(probes.checkDb()), status(probes.checkLlm())]);
  return { ready: db === "ok" && llm === "ok", checks: { db, llm } };
}

export interface ReadinessProbes {
  /** Resolves when the datastore is reachable, rejects otherwise. */
  checkDb(): Promise<void>;
}

export type CheckStatus = "ok" | "unreachable";

export interface ReadinessReport {
  ready: boolean;
  checks: { db: CheckStatus };
}

/** Core serving requires storage. Optional provider failures must leave the console reachable. */
export async function checkReadiness(probes: ReadinessProbes): Promise<ReadinessReport> {
  try {
    await probes.checkDb();
    return { ready: true, checks: { db: "ok" } };
  } catch {
    // Probe errors can contain connection credentials; return only the state.
    return { ready: false, checks: { db: "unreachable" } };
  }
}

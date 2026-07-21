import type { UsageDelta, UsageRow } from "./types";

export interface UsageRepository {
  /** Atomic ADD of one call's usage into the daily row. */
  record(delta: UsageDelta): Promise<void>;
  listByProject(projectName: string, from: string, to: string): Promise<UsageRow[]>;
  /** Cross-project rows for a date range (dashboard). */
  listByDateRange(from: string, to: string): Promise<UsageRow[]>;
}

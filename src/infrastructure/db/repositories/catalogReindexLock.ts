import { randomUUID } from "node:crypto";
import type { CatalogReindexLock } from "@/domain/catalog/reindexLock";
import { log } from "@/shared/logger";
import {
  CONDITIONAL_WRITE_FAILED,
  conditions,
  deleteItem,
  putItem,
} from "../store";
import { keys } from "../keys";

function lostCondition(error: unknown): boolean {
  return error instanceof Error && error.name === CONDITIONAL_WRITE_FAILED;
}

export const catalogReindexLock: CatalogReindexLock = {
  async acquire(leaseMs) {
    const token = randomUUID();
    const now = Date.now();
    const leaseUntil = now + leaseMs;
    try {
      await putItem(
        {
          ...keys.catalogReindexLock(),
          entityType: "CATALOGREINDEX",
          token,
          leaseUntil,
          expiresAt: Math.ceil(leaseUntil / 1000),
        },
        (row) => row === null || Number(row.leaseUntil ?? 0) < now,
      );
      return token;
    } catch (error) {
      if (lostCondition(error)) {
        return null;
      }
      throw error;
    }
  },

  async release(token) {
    try {
      await deleteItem(keys.catalogReindexLock(), conditions.existsWith("token", token));
    } catch (error) {
      if (!lostCondition(error)) {
        log.warn("catalog", "failed to release the reindex lease", error);
      }
    }
  },
};

import { randomUUID } from "node:crypto";
import type { CatalogReindexLock } from "@/domain/catalog/reindexLock";
import { log } from "@/shared/logger";
import {
  CONDITIONAL_WRITE_FAILED,
  conditions,
  getItem,
  updateItem,
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
      await updateItem(
        keys.catalogReindexLock(),
        (row) => ({
          ...keys.catalogReindexLock(),
          entityType: "CATALOGREINDEX",
          generation: Number(row?.generation ?? 0) + 1,
          token,
          leaseUntil,
        }),
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
      await updateItem(
        keys.catalogReindexLock(),
        (row) => {
          const { token: _token, leaseUntil: _leaseUntil, expiresAt: _expiresAt, ...state } = row!;
          return state;
        },
        conditions.existsWith("token", token),
      );
    } catch (error) {
      if (!lostCondition(error)) {
        log.warn("catalog", "failed to release the reindex lease", error);
      }
    }
  },

  async state() {
    const row = await getItem(keys.catalogReindexLock());
    return {
      generation: Number(row?.generation ?? 0),
      active: typeof row?.token === "string" && Number(row.leaseUntil ?? 0) >= Date.now(),
    };
  },
};

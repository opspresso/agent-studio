import type { AgentRecommendationQuota } from "@/domain/llm/decision";
import { MS_PER_DAY, utcDay } from "@/shared/date";
import { keys } from "../keys";
import { updateItem } from "../store";

/** Bounded per-user inference admission across all app instances. */
export const MAX_AGENT_RECOMMENDATIONS_PER_MINUTE = 120;
export const MAX_AGENT_RECOMMENDATIONS_PER_DAY = 2_400;

const MINUTE_MS = 60_000;

class QuotaRefused extends Error {
  constructor(readonly retryAfterSeconds: number) { super("Agent recommendation quota reached"); }
}

function retryAfter(windowEndMs: number, nowMs: number): number {
  return Math.max(1, Math.ceil((windowEndMs - nowMs) / 1000));
}

export function createAgentRecommendationQuota(now: () => Date = () => new Date()): AgentRecommendationQuota {
  return {
    async admit(userEmail) {
      const instant = now();
      const nowMs = instant.getTime();
      const date = utcDay(instant);
      const minute = Math.floor(nowMs / MINUTE_MS);
      const dayStartMs = Math.floor(nowMs / MS_PER_DAY) * MS_PER_DAY;
      try {
        await updateItem(keys.agentRecommendationQuota(userEmail, date), row => {
          const dayCount = Number(row?.dayCount ?? 0);
          const minuteCount = row?.minute === minute ? Number(row.minuteCount ?? 0) : 0;
          if (dayCount >= MAX_AGENT_RECOMMENDATIONS_PER_DAY) {
            throw new QuotaRefused(retryAfter(dayStartMs + MS_PER_DAY, nowMs));
          }
          if (minuteCount >= MAX_AGENT_RECOMMENDATIONS_PER_MINUTE) {
            throw new QuotaRefused(retryAfter((minute + 1) * MINUTE_MS, nowMs));
          }
          return {
            entityType: "AgentRecommendationQuota",
            date, minute, dayCount: dayCount + 1, minuteCount: minuteCount + 1,
            expiresAt: Math.floor((dayStartMs + 2 * MS_PER_DAY) / 1000),
          };
        });
        return undefined;
      } catch (error) {
        if (error instanceof QuotaRefused) return error.retryAfterSeconds;
        throw error;
      }
    },
  };
}

export const agentRecommendationQuota = createAgentRecommendationQuota();

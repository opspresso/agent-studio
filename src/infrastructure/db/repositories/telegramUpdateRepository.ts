import { keys } from "../keys";
import { createInboundClaimRepository } from "./inboundClaimRepository";

/**
 * Telegram redelivers an update until the webhook answers 2xx, so processing
 * must be idempotent. The shared claim-and-settle contract, keyed by project
 * and `update_id` — a counter per bot, which is why the project qualifies it.
 */
export const telegramUpdateRepository = {
  forProject: (projectName: string) =>
    createInboundClaimRepository({
      key: (updateId) => keys.telegramUpdate(projectName, updateId),
      entityType: "telegramUpdate",
    }),
};

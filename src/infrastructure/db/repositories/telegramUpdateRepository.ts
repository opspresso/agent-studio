import type { InboundEventClaims } from "@/domain/messaging/inboundClaims";
import { keys } from "../keys";
import { createInboundClaimRepository } from "./inboundClaimRepository";

/**
 * Telegram redelivers an update until the webhook answers 2xx, so processing
 * must be idempotent. The shared claim-and-settle contract, keyed by agent,
 * bot and `update_id` — a counter per bot, which is why the bot qualifies it.
 *
 * An album is claimed the same way: Telegram delivers a `media_group_id` as
 * one update per picture, and the bot answers it once.
 */
export const telegramUpdateRepository = {
  forBot: (agentName: string, botId: number | string) => ({
    updates: createInboundClaimRepository({
      key: (updateId) => keys.telegramUpdate(agentName, botId, updateId),
      entityType: "telegramUpdate",
    }),
    albums: createInboundClaimRepository({
      key: (mediaGroupId) => keys.telegramAlbum(agentName, botId, mediaGroupId),
      entityType: "telegramAlbum",
    }) satisfies InboundEventClaims,
  }),
};

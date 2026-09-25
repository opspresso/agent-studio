import type { SlackThreadRepository } from "@/domain/slack/repository";
import { getItem, putItem, updateItem } from "../store";
import { keys } from "../keys";
import { expiresAtFromNow, isExpired, SLACK_ENGAGEMENT_TTL_SECONDS } from "../ttl";

/**
 * Where this agent's bot has spoken, so a follow-up there needs no mention.
 *
 * A reply refreshes engagement without changing an explicit mute. In
 * particular, a mentioned reply may finish after someone muted the thread.
 */
export const slackThreadRepository: SlackThreadRepository = {
  async markEngaged(agentName, channel, threadTs) {
    await updateItem(keys.slackThread(agentName, channel, threadTs), (current) => ({
      ...current,
      entityType: "slackThread",
      agentName,
      channel,
      threadTs,
      engagedAt: new Date().toISOString(),
      expiresAt: expiresAtFromNow(SLACK_ENGAGEMENT_TTL_SECONDS),
    }));
  },

  async setMuted(agentName, channel, threadTs, muted) {
    // A put rather than an update, like `markEngaged`: a mute on a thread the
    // bot has not spoken in yet still has to be recorded, and there is nothing
    // to merge with.
    await putItem({
      ...keys.slackThread(agentName, channel, threadTs),
      entityType: "slackThread",
      agentName,
      channel,
      threadTs,
      muted,
      engagedAt: new Date().toISOString(),
      expiresAt: expiresAtFromNow(SLACK_ENGAGEMENT_TTL_SECONDS),
    });
  },

  async isEngaged(agentName, channel, threadTs) {
    const item = await getItem(keys.slackThread(agentName, channel, threadTs));
    if (!item || item.muted === true) {
      return false;
    }
    // The sweep is periodic, so an expired row is still readable for a tick.
    // Checked here rather than trusted, or engagement would quietly outlast
    // what it says.
    return !isExpired(item.expiresAt, Date.now());
  },
};

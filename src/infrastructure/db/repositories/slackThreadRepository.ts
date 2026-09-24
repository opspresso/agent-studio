import type { SlackThreadRepository } from "@/domain/slack/repository";
import { getItem, putItem, updateItem } from "../store";
import { keys } from "../keys";
import { expiresAtFromNow, isExpired, SLACK_ENGAGEMENT_TTL_SECONDS } from "../ttl";

/**
 * Where this project's bot has spoken, so a follow-up there needs no mention.
 *
 * A reply refreshes engagement without changing an explicit mute. In
 * particular, a mentioned reply may finish after someone muted the thread.
 */
export const slackThreadRepository: SlackThreadRepository = {
  async markEngaged(projectName, channel, threadTs) {
    await updateItem(keys.slackThread(projectName, channel, threadTs), (current) => ({
      ...current,
      entityType: "slackThread",
      projectName,
      channel,
      threadTs,
      engagedAt: new Date().toISOString(),
      expiresAt: expiresAtFromNow(SLACK_ENGAGEMENT_TTL_SECONDS),
    }));
  },

  async setMuted(projectName, channel, threadTs, muted) {
    // A put rather than an update, like `markEngaged`: a mute on a thread the
    // bot has not spoken in yet still has to be recorded, and there is nothing
    // to merge with.
    await putItem({
      ...keys.slackThread(projectName, channel, threadTs),
      entityType: "slackThread",
      projectName,
      channel,
      threadTs,
      muted,
      engagedAt: new Date().toISOString(),
      expiresAt: expiresAtFromNow(SLACK_ENGAGEMENT_TTL_SECONDS),
    });
  },

  async isEngaged(projectName, channel, threadTs) {
    const item = await getItem(keys.slackThread(projectName, channel, threadTs));
    if (!item || item.muted === true) {
      return false;
    }
    // The sweep is periodic, so an expired row is still readable for a tick.
    // Checked here rather than trusted, or engagement would quietly outlast
    // what it says.
    return !isExpired(item.expiresAt, Date.now());
  },
};

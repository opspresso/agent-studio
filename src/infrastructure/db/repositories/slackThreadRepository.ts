import { GetCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import type { SlackThreadRepository } from "@/domain/slack/repository";
import { getDocumentClient, getTableName } from "../client";
import { keys } from "../keys";
import { expiresAtFromNow, isExpired, SLACK_ENGAGEMENT_TTL_SECONDS } from "../ttl";

/**
 * Where this project's bot has spoken, so a follow-up there needs no mention.
 *
 * An unconditional put rather than an update: every reply restarts the window,
 * and a row that already exists is meant to be overwritten. There is nothing to
 * race over — two replies in the same thread write the same value.
 */
export const slackThreadRepository: SlackThreadRepository = {
  async markEngaged(projectName, channel, threadTs) {
    await getDocumentClient().send(
      new PutCommand({
        TableName: getTableName(),
        Item: {
          ...keys.slackThread(projectName, channel, threadTs),
          entityType: "slackThread",
          projectName,
          channel,
          threadTs,
          engagedAt: new Date().toISOString(),
          // TTL attribute; enable table TTL on `expiresAt` to purge old rows.
          expiresAt: expiresAtFromNow(SLACK_ENGAGEMENT_TTL_SECONDS),
        },
      }),
    );
  },

  async setMuted(projectName, channel, threadTs, muted) {
    // A put rather than an update, like `markEngaged`: a mute on a thread the
    // bot has not spoken in yet still has to be recorded, and there is nothing
    // to merge with.
    await getDocumentClient().send(
      new PutCommand({
        TableName: getTableName(),
        Item: {
          ...keys.slackThread(projectName, channel, threadTs),
          entityType: "slackThread",
          projectName,
          channel,
          threadTs,
          muted,
          engagedAt: new Date().toISOString(),
          expiresAt: expiresAtFromNow(SLACK_ENGAGEMENT_TTL_SECONDS),
        },
      }),
    );
  },

  async isEngaged(projectName, channel, threadTs) {
    const result = await getDocumentClient().send(
      new GetCommand({
        TableName: getTableName(),
        Key: keys.slackThread(projectName, channel, threadTs),
      }),
    );
    if (!result.Item || result.Item.muted === true) {
      return false;
    }
    // The physical purge lags the TTL by up to ~48h, so an expired row is still
    // readable. Checked here rather than trusted, or engagement would quietly
    // last two days longer than it says it does.
    return !isExpired(result.Item.expiresAt, Date.now());
  },
};

import { slackTimestampValue, type SlackRunControlRepository } from "@/domain/slack/runControl";
import { keys } from "../keys";
import { getItem, transact } from "../store";
import { projectIsLive } from "../projectLifecycle";
import { expiresAtFromNow, isExpired, SLACK_STOP_TTL_SECONDS } from "../ttl";

export const slackRunControlRepository: SlackRunControlRepository = {
  async requestStop(target, eventTs) {
    const timestamp = slackTimestampValue(eventTs);
    if (timestamp === null) throw new Error("Invalid Slack stop timestamp");
    const key = keys.slackRunControl(target.projectName, target.channel, target.threadTs);
    const now = Date.now();
    await transact([
      { kind: "check", key: keys.project(target.projectName), condition: projectIsLive },
      { kind: "update", key, patch: (existing) => {
        const previous = slackTimestampValue(existing?.eventTs);
        if (existing && !isExpired(existing.expiresAt, now) && previous !== null && previous >= timestamp) {
          return existing;
        }
        return { ...key, entityType: "slackRunControl", eventTs,
          expiresAt: expiresAtFromNow(SLACK_STOP_TTL_SECONDS) };
      } },
    ]);
  },
  async stoppedAfter(target, messageTs) {
    const timestamp = slackTimestampValue(messageTs);
    if (timestamp === null) throw new Error("Invalid Slack message timestamp");
    const row = await getItem(keys.slackRunControl(target.projectName, target.channel, target.threadTs));
    if (!row || isExpired(row.expiresAt, Date.now())) return false;
    const stoppedAt = slackTimestampValue(row.eventTs);
    return stoppedAt !== null && stoppedAt >= timestamp;
  },
};

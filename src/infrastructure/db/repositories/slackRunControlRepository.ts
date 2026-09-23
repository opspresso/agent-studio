import { slackTimestampValue, type SlackRunControlRepository } from "@/domain/slack/runControl";
import { randomUUID } from "node:crypto";
import { keys } from "../keys";
import { CONDITIONAL_WRITE_FAILED, TRANSACTION_CANCELLED, conditions, deleteItem, getItem, transact } from "../store";
import { projectIsLive } from "../projectLifecycle";
import { expiresAtFromNow, isExpired, SLACK_RUN_LEASE_SECONDS, SLACK_STOP_TTL_SECONDS } from "../ttl";

export const slackRunControlRepository: SlackRunControlRepository = {
  async acquire(target) {
    const token = randomUUID();
    const key = keys.slackRunLease(target.projectName, target.channel, target.threadTs);
    let acquired = false;
    await transact([
      { kind: "check", key: keys.project(target.projectName), condition: projectIsLive },
      { kind: "update", key, patch: (row) => {
        if (row && !isExpired(row.expiresAt, Date.now())) return row;
        acquired = true;
        return { ...key, entityType: "slackRunLease", token, expiresAt: expiresAtFromNow(SLACK_RUN_LEASE_SECONDS) };
      } },
    ]);
    return acquired ? token : null;
  },
  async renew(target, token) {
    const key = keys.slackRunLease(target.projectName, target.channel, target.threadTs);
    const row = await getItem(key);
    if (row?.token !== token || isExpired(row.expiresAt, Date.now())) return false;
    // Reads happen every second; a lease write is needed only halfway through its lifetime.
    if (Number(row.expiresAt) > Date.now() / 1000 + SLACK_RUN_LEASE_SECONDS / 2) return true;
    try {
      await transact([
        { kind: "check", key: keys.project(target.projectName), condition: projectIsLive },
        { kind: "update", key,
          condition: (current) => current?.token === token && !isExpired(current.expiresAt, Date.now()),
          patch: (current) => ({ ...current, ...key, expiresAt: expiresAtFromNow(SLACK_RUN_LEASE_SECONDS) }) },
      ]);
      return true;
    } catch (error) {
      if (error instanceof Error && error.name === TRANSACTION_CANCELLED) return false;
      throw error;
    }
  },
  async release(target, token) {
    try {
      await deleteItem(keys.slackRunLease(target.projectName, target.channel, target.threadTs), conditions.existsWith("token", token));
    } catch (error) {
      if (!(error instanceof Error) || error.name !== CONDITIONAL_WRITE_FAILED) throw error;
    }
  },
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

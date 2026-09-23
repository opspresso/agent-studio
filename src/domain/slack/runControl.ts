/** Slack timestamps are decimal seconds with up to six fractional digits. */
export function slackTimestampValue(value: unknown): bigint | null {
  if (typeof value !== "string" || !/^\d{1,12}(?:\.\d{1,6})?$/.test(value)) {
    return null;
  }
  const [seconds, fraction = ""] = value.split(".");
  return BigInt(seconds!) * 1_000_000n + BigInt(fraction.padEnd(6, "0"));
}

export interface SlackRunTarget {
  projectName: string;
  channel: string;
  threadTs: string;
}

/** A stop affects messages sent before it, including delayed deliveries, across replicas. */
export interface SlackRunControlRepository {
  requestStop(target: SlackRunTarget, eventTs: string): Promise<void>;
  stoppedAfter(target: SlackRunTarget, messageTs: string): Promise<boolean>;
}

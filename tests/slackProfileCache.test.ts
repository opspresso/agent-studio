import { beforeEach, describe, expect, it } from "vitest";
import {
  clearProfileCache,
  getCachedProfile,
  rememberProfile,
} from "@/infrastructure/slack/profileCache";

const NOW = 1_750_000_000_000;
const HOUR = 60 * 60 * 1000;
const PROFILE = {
  detail: { id: "U1", displayName: "Bruce", timezone: "Asia/Seoul" },
  email: "bruce@example.com",
};

beforeEach(() => {
  clearProfileCache();
});

describe("the Slack profile cache", () => {
  it("answers a hit without another lookup", () => {
    rememberProfile("tok", "U1", PROFILE, NOW);

    expect(getCachedProfile("tok", "U1", NOW + 1000)).toEqual({ value: PROFILE });
  });

  it("forgets a profile once it is an hour old", () => {
    rememberProfile("tok", "U1", PROFILE, NOW);

    expect(getCachedProfile("tok", "U1", NOW + HOUR - 1)).toEqual({ value: PROFILE });
    expect(getCachedProfile("tok", "U1", NOW + HOUR)).toBeUndefined();
  });

  it("remembers a miss, but only briefly", () => {
    rememberProfile("tok", "U1", null, NOW);

    // A remembered miss is a hit: without it a deactivated user costs a round
    // trip on every single message.
    expect(getCachedProfile("tok", "U1", NOW + 1000)).toEqual({ value: null });
    // Far shorter than a success — a scope that was just granted has to start
    // working without waiting an hour.
    expect(getCachedProfile("tok", "U1", NOW + 61_000)).toBeUndefined();
  });

  it("keeps workspaces apart, because a user id means different people in each", () => {
    rememberProfile("tok-a", "U1", PROFILE, NOW);

    expect(getCachedProfile("tok-b", "U1", NOW)).toBeUndefined();
  });

  it("keeps users apart within one workspace", () => {
    rememberProfile("tok", "U1", PROFILE, NOW);

    expect(getCachedProfile("tok", "U2", NOW)).toBeUndefined();
  });

  it("evicts the oldest entries rather than growing without a bound", () => {
    // Expiry alone does not bound this map — an entry is only dropped when it is
    // read after expiring, and most are never read again. The key space is every
    // Slack user who ever talks to any project bot, plus a fresh set on every
    // token rotation.
    for (let index = 0; index < 2100; index += 1) {
      rememberProfile("tok", `U${index}`, PROFILE, NOW);
    }

    expect(getCachedProfile("tok", "U0", NOW)).toBeUndefined();
    expect(getCachedProfile("tok", "U2099", NOW)).toEqual({ value: PROFILE });
  });

  it("keeps a re-written entry alive rather than ageing it out", () => {
    rememberProfile("tok", "U-hot", PROFILE, NOW);
    for (let index = 0; index < 1999; index += 1) {
      rememberProfile("tok", `U${index}`, PROFILE, NOW);
    }
    // Written again, so it moves to the back of the queue.
    rememberProfile("tok", "U-hot", PROFILE, NOW);
    for (let index = 2000; index < 2100; index += 1) {
      rememberProfile("tok", `U${index}`, PROFILE, NOW);
    }

    expect(getCachedProfile("tok", "U-hot", NOW)).toEqual({ value: PROFILE });
  });
});

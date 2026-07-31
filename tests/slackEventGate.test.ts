import { createHmac } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The gate decides which Slack events reach a handler at all, so a wrong
 * condition here drops a whole surface silently — the agent container would
 * open with no prompts and nothing would say why. The two handlers are mocked:
 * what is under test is the routing, not what they do.
 */
const { handled, claim, settle } = vi.hoisted(() => ({
  handled: [] as Array<{ handler: "run" | "threadStart"; type?: string }>,
  claim: vi.fn(async () => true),
  settle: vi.fn(async () => {}),
}));

vi.mock("next/server", () => ({ after: (fn: () => unknown) => fn() }));
vi.mock("@/lib/container", () => ({
  executionDeps: {},
  projectRepository: {},
  versionRepository: {},
}));
vi.mock("@/lib/config", () => ({ config: { slackLoadingIndicator: undefined } }));
vi.mock("@/infrastructure/slack/client", () => ({ slackClient: {} }));
vi.mock("@/application/execution/runProject", () => ({ executeAgent: () => {} }));
vi.mock("@/infrastructure/db/repositories/slackEventRepository", () => ({
  slackEventRepository: { claim, settle },
}));
vi.mock("@/application/slack/handleSlackEvent", () => ({
  handleSlackEvent: async (_deps: unknown, body: { event?: { type?: string } }) => {
    handled.push({ handler: "run", type: body.event?.type });
  },
}));
vi.mock("@/application/slack/handleThreadStart", () => ({
  handleThreadStart: async (_deps: unknown, body: { event?: { type?: string } }) => {
    handled.push({ handler: "threadStart", type: body.event?.type });
  },
}));

const { handleSlackEventRequest } = await import(
  "@/app/api/slack/events/_lib/handleEventRequest"
);

const SIGNING_SECRET = "test-signing-secret";
const BINDING = { projectName: "painter", botToken: "tok" };

function signedRequest(payload: unknown): Request {
  const body = JSON.stringify(payload);
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = `v0=${createHmac("sha256", SIGNING_SECRET)
    .update(`v0:${timestamp}:${body}`)
    .digest("hex")}`;
  return new Request("https://studio.example.com/api/slack/events/painter", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-slack-request-timestamp": timestamp,
      "x-slack-signature": signature,
    },
    body,
  });
}

const deliver = (payload: unknown) =>
  handleSlackEventRequest(signedRequest(payload), {
    signingSecret: SIGNING_SECRET,
    binding: BINDING,
    logLabel: "project painter",
  });

beforeEach(() => {
  handled.length = 0;
  vi.clearAllMocks();
  claim.mockResolvedValue(true);
});

describe("which Slack events reach a handler", () => {
  it("runs the agent for a mention and a DM", async () => {
    await deliver({
      type: "event_callback",
      event_id: "Ev1",
      event: { type: "app_mention", channel: "C1", ts: "1.0" },
    });
    await deliver({
      type: "event_callback",
      event_id: "Ev2",
      event: { type: "message", channel_type: "im", channel: "D1", ts: "1.0" },
    });

    expect(handled).toEqual([
      { handler: "run", type: "app_mention" },
      { handler: "run", type: "message" },
    ]);
  });

  it("greets rather than runs when the agent container is opened", async () => {
    await deliver({
      type: "event_callback",
      event_id: "Ev3",
      event: { type: "app_home_opened", tab: "messages", channel: "D1" },
    });
    await deliver({
      type: "event_callback",
      event_id: "Ev4",
      event: { type: "assistant_thread_started", assistant_thread: { channel_id: "D1" } },
    });

    expect(handled).toEqual([
      { handler: "threadStart", type: "app_home_opened" },
      { handler: "threadStart", type: "assistant_thread_started" },
    ]);
  });

  it("ignores the Home tab and anything else Slack sends", async () => {
    await deliver({
      type: "event_callback",
      event_id: "Ev5",
      event: { type: "app_home_opened", tab: "home", channel: "D1" },
    });
    await deliver({
      type: "event_callback",
      event_id: "Ev6",
      event: { type: "reaction_added", channel: "C1" },
    });
    await deliver({
      type: "event_callback",
      event_id: "Ev7",
      event: { type: "message", channel_type: "channel", channel: "C1", ts: "1.0" },
    });

    expect(handled).toEqual([]);
    // An ignored event is never claimed — the dedup table is for work that ran.
    expect(claim).not.toHaveBeenCalled();
  });

  it("answers the url_verification challenge without handling anything", async () => {
    const res = await deliver({ type: "url_verification", challenge: "abc123" });

    expect(await res.json()).toEqual({ challenge: "abc123" });
    expect(handled).toEqual([]);
  });

  it("drops a redelivery the dedup claim refuses", async () => {
    claim.mockResolvedValue(false);

    const res = await deliver({
      type: "event_callback",
      event_id: "Ev8",
      event: { type: "app_home_opened", tab: "messages", channel: "D1" },
    });

    expect(await res.json()).toMatchObject({ duplicate: true });
    expect(handled).toEqual([]);
  });

  it("refuses a request whose signature does not verify", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const res = await handleSlackEventRequest(
      new Request("https://studio.example.com/api/slack/events/painter", {
        method: "POST",
        body: JSON.stringify({ type: "event_callback", event: { type: "app_mention" } }),
      }),
      { signingSecret: SIGNING_SECRET, binding: BINDING, logLabel: "project painter" },
    );

    expect(res.status).toBe(401);
    expect(handled).toEqual([]);
  });
});

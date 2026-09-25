import { createHmac } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The gate decides which Slack events reach a handler at all, so a wrong
 * condition here drops a whole surface silently — the agent container would
 * open with no prompts and nothing would say why. The two handlers are mocked:
 * what is under test is the routing, not what they do.
 */
const { handled, claim, settle, isEngaged } = vi.hoisted(() => ({
  handled: [] as Array<{ handler: "run" | "threadStart" | "stop"; type?: string }>,
  claim: vi.fn(async (): Promise<string | null> => "claim-token"),
  settle: vi.fn(async () => {}),
  isEngaged: vi.fn(async () => false),
}));

vi.mock("next/server", () => ({ after: (fn: () => unknown) => fn() }));
vi.mock("@/lib/container", () => ({
  executionDeps: {},
  agentRepository: {},
  // No object storage in this deployment, which the wiring site names rather
  // than leaves undecided.
  signArtifactUrl: undefined,
}));
vi.mock("@/lib/runtime-settings", () => ({ getSlackLoadingIndicator: async () => undefined }));
vi.mock("@/infrastructure/slack/client", () => ({ slackClient: {} }));
vi.mock("@/application/execution/runAgent", () => ({ executeAgent: () => {} }));
vi.mock("@/infrastructure/db/repositories/slackEventRepository", () => ({
  slackEventRepository: { claim, settle },
}));
vi.mock("@/infrastructure/db/repositories/slackThreadRepository", () => ({
  slackThreadRepository: { isEngaged, markEngaged: vi.fn(async () => {}) },
}));
vi.mock("@/application/slack/handleSlackEvent", () => ({
  handleSlackStop: async (_deps: unknown, body: { event?: { type?: string } }) => {
    handled.push({ handler: "stop", type: body.event?.type });
  },
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
const BINDING = { agentName: "painter", botToken: "tok" };

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

const deliver = (payload: unknown, keywords?: string[]) =>
  handleSlackEventRequest(signedRequest(payload), {
    signingSecret: SIGNING_SECRET,
    binding: BINDING,
    logLabel: "agent painter",
    ...(keywords ? { engagement: { keywords } } : {}),
  });

/** A human's message in a public channel, as `message.channels` delivers it. */
const channelMessage = (over: Record<string, unknown> = {}) => ({
  type: "event_callback",
  event_id: "EvC",
  team_id: "T1",
  authorizations: [{ user_id: "U0BOT", is_bot: true }],
  event: {
    type: "message",
    channel_type: "channel",
    channel: "C1",
    user: "U_HUMAN",
    ts: "2.0",
    text: "how is the deploy going",
    ...over,
  },
});

beforeEach(() => {
  handled.length = 0;
  vi.clearAllMocks();
  claim.mockResolvedValue("claim-token");
  isEngaged.mockResolvedValue(false);
});

describe("which Slack events reach a handler", () => {
  it.each([
    null,
    [],
    { ...channelMessage(), authorizations: "not authorizations" },
    channelMessage({ text: 42 }),
    channelMessage({ attachments: "not attachments" }),
  ])("refuses a malformed signed event before claiming it: %j", async (payload) => {
    const response = await deliver(payload, ["deploy"]);
    expect(response.status).toBe(400);
    expect(claim).not.toHaveBeenCalled();
  });

  it("refuses a callback without an event id instead of running it without deduplication", async () => {
    const { event_id: _missing, ...payload } = channelMessage();
    const response = await deliver(payload, ["deploy"]);
    expect(response.status).toBe(400);
    expect(claim).not.toHaveBeenCalled();
    expect(handled).toEqual([]);
  });

  it("routes a native stop without launching a model or reading engagement", async () => {
    await deliver({ type: "event_callback", event_id: "EvStop", event: {
      type: "agent_session_stopped", channel: "C1", thread_ts: "1.0", event_ts: "2.0", user: "U1",
    } });
    expect(handled).toEqual([{ handler: "stop", type: "agent_session_stopped" }]);
    expect(isEngaged).not.toHaveBeenCalled();
    expect(claim).toHaveBeenCalledOnce();
  });

  it("admits an unmentioned stop before a first reply establishes engagement", async () => {
    await deliver(channelMessage({ thread_ts: "1.0", text: "!stop" }));
    expect(handled).toEqual([{ handler: "run", type: "message" }]);
    expect(isEngaged).not.toHaveBeenCalled();
  });

  it("ignores malformed native stops before claiming an event", async () => {
    await deliver({ type: "event_callback", event_id: "EvStop", event: {
      type: "agent_session_stopped", channel: "C1", thread_ts: "1.0", event_ts: "bad", user: "U1",
    } });
    expect(claim).not.toHaveBeenCalled();
  });
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

    expect(handled).toEqual([]);
    // An ignored event is never claimed — the dedup table is for work that ran.
    expect(claim).not.toHaveBeenCalled();
  });

  it.each([
    { type: "message", channel_type: "im", bot_id: "OTHER_APP" },
    { type: "app_mention", subtype: "message_changed" },
    { type: "message", subtype: "file_share", user: "U0BOT" },
  ])("rejects loops and bookkeeping before claiming or dispatching: %j", async (event) => {
    const response = await deliver(channelMessage({ text: "deploy", ...event }), ["deploy"]);
    expect(response.status).toBe(200);
    expect(handled).toEqual([]);
    expect(claim).not.toHaveBeenCalled();
    expect(settle).not.toHaveBeenCalled();
    expect(isEngaged).not.toHaveBeenCalled();
  });

  /**
   * The bot is subscribed to `message.channels`, so it receives every message
   * in every channel it belongs to. What matters as much as *whether* each one
   * runs is what it costs when it does not: the gate decides ahead of the dedup
   * claim, so an ignored message writes nothing.
   */
  describe("a channel message with no mention", () => {
    it("costs nothing at all when it is not for the bot", async () => {
      await deliver(channelMessage());

      expect(handled).toEqual([]);
      expect(claim).not.toHaveBeenCalled();
      // Not even the engagement lookup: a top-level message carries no
      // `thread_ts`, so there is no thread to ask about.
      expect(isEngaged).not.toHaveBeenCalled();
    });

    it("runs as a follow-up in a thread the bot is engaged in", async () => {
      isEngaged.mockResolvedValue(true);

      await deliver(channelMessage({ thread_ts: "1.0" }));

      expect(handled).toEqual([{ handler: "run", type: "message" }]);
      expect(isEngaged).toHaveBeenCalledWith("painter", "C1", "1.0");
    });

    it("is dropped before the claim when the thread is not one of the bot's", async () => {
      await deliver(channelMessage({ thread_ts: "1.0" }));

      expect(handled).toEqual([]);
      expect(isEngaged).toHaveBeenCalledOnce();
      expect(claim).not.toHaveBeenCalled();
    });

    it("runs when it carries a keyword the agent named", async () => {
      await deliver(channelMessage(), ["deploy"]);

      expect(handled).toEqual([{ handler: "run", type: "message" }]);
    });

    it("stays silent rather than answering when the engagement lookup fails", async () => {
      vi.spyOn(console, "error").mockImplementation(() => {});
      isEngaged.mockRejectedValue(new Error("dynamo is down"));

      await deliver(channelMessage({ thread_ts: "1.0" }));

      // One unanswered follow-up is the cheaper failure; the other way the bot
      // speaks uninvited in a channel nobody addressed it in.
      expect(handled).toEqual([]);
      expect(claim).not.toHaveBeenCalled();
    });
  });

  it("answers the url_verification challenge without handling anything", async () => {
    const res = await deliver({ type: "url_verification", challenge: "abc123" });

    expect(await res.json()).toEqual({ challenge: "abc123" });
    expect(handled).toEqual([]);
  });

  it("drops a redelivery the dedup claim refuses", async () => {
    claim.mockResolvedValue(null);

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
      { signingSecret: SIGNING_SECRET, binding: BINDING, logLabel: "agent painter" },
    );

    expect(res.status).toBe(401);
    expect(handled).toEqual([]);
  });
});

import { describe, expect, it } from "vitest";
import { classifySlackEvent, parseSlackCommand } from "@/application/slack/engagement";
import type { SlackEventBody } from "@/application/slack/types";

/**
 * The bot now receives every message in every channel it belongs to, so this
 * function decides — for each one — whether anything happens at all. Two
 * different failures live here and neither announces itself: too strict and a
 * follow-up goes unanswered with no error anywhere, too loose and the bot
 * speaks uninvited, or answers itself forever.
 */

/** Our app's own user id in this workspace, as the envelope reports it. */
const SELF = "U0BOT";

function envelope(event: SlackEventBody["event"]): SlackEventBody {
  return {
    type: "event_callback",
    event_id: "Ev1",
    team_id: "T1",
    authorizations: [{ user_id: SELF, is_bot: true }],
    event,
  };
}

/** A message from a human in a public channel. */
function channelMessage(over: Partial<NonNullable<SlackEventBody["event"]>> = {}) {
  return envelope({
    type: "message",
    channel_type: "channel",
    channel: "C1",
    user: "U_HUMAN",
    ts: "2.0",
    text: "how is the deploy going",
    ...over,
  });
}

describe("which Slack events are for the bot", () => {
  it("answers a mention and every message in a DM", () => {
    expect(classifySlackEvent(envelope({ type: "app_mention", channel: "C1", ts: "1.0" }))).toEqual({
      kind: "run",
      trigger: "mention",
    });
    expect(
      classifySlackEvent(
        envelope({ type: "message", channel_type: "im", channel: "D1", ts: "1.0", text: "hi" }),
      ),
    ).toEqual({ kind: "run", trigger: "dm" });
  });

  it("greets rather than runs when the agent container is opened", () => {
    expect(
      classifySlackEvent(envelope({ type: "app_home_opened", tab: "messages", channel: "D1" })),
    ).toEqual({ kind: "threadStart" });
    expect(
      classifySlackEvent(envelope({ type: "assistant_thread_started", channel: "D1" })),
    ).toEqual({ kind: "threadStart" });
    // The Home tab is a different surface and is not ours.
    expect(
      classifySlackEvent(envelope({ type: "app_home_opened", tab: "home", channel: "D1" })).kind,
    ).toBe("ignore");
  });

  it("stays out of ordinary channel traffic", () => {
    const disposition = classifySlackEvent(channelMessage());

    // Not merely "no run": an ignore is what keeps the message from costing a
    // dedup claim, so the *shape* is the contract, not just the outcome.
    expect(disposition).toEqual({ kind: "ignore", because: "not addressed to the bot" });
  });

  it("asks about a channel thread rather than deciding it", () => {
    // The only branch that needs storage, and only a reply reaches it — which
    // is what keeps top-level chatter off the database entirely.
    expect(classifySlackEvent(channelMessage({ thread_ts: "1.0" }))).toEqual({
      kind: "engagedThread",
      channel: "C1",
      threadTs: "1.0",
    });
  });

  describe("the loop guard", () => {
    // The bot's own reply lands in a thread the bot is engaged in. If any of
    // these were classified as work, that reply would be answered, and the
    // answer answered, without end.
    it("never runs for a message the bot itself posted", () => {
      // The bot's own reply: attributed to its bot user, and carrying the
      // `bot_id` every app's message carries.
      expect(
        classifySlackEvent(channelMessage({ user: SELF, bot_id: "B1", thread_ts: "1.0" })),
      ).toEqual({
        kind: "ignore",
        because: "the bot's own message",
      });
      // Attributed to the bot *user* without a `bot_id` — how a file shared
      // through the external upload flow comes back.
      expect(
        classifySlackEvent(
          channelMessage({ user: SELF, thread_ts: "1.0", subtype: "file_share" }),
        ),
      ).toEqual({ kind: "ignore", because: "the bot's own message" });
    });

    it("is decided before the subtype gate and before any keyword", () => {
      // Ordering, not outcome: a keyword the bot's own reply happens to contain
      // must not be what wakes it. `because` names which rule fired.
      const disposition = classifySlackEvent(
        channelMessage({ user: SELF, bot_id: "B1", text: "deploy done" }),
        { keywords: ["deploy"] },
      );

      expect(disposition).toEqual({ kind: "ignore", because: "the bot's own message" });
    });
  });

  describe("another app's message", () => {
    // An alerting app's post is the very thing a keyword is registered for, and
    // it looks nothing like a person's: no `user`, a `bot_id`, the
    // `bot_message` subtype, and the alert itself in an attachment rather than
    // in `text`.
    const alert = (over: Partial<NonNullable<SlackEventBody["event"]>> = {}) =>
      channelMessage({
        user: undefined,
        bot_id: "B_GRAFANA",
        subtype: "bot_message",
        username: "Grafana",
        text: undefined,
        attachments: [
          {
            title: "[FIRING:1] Container OOMKilled (sample-node OOMKilled warning)",
            text: "container sample-node was OOMKilled",
            fallback: "[FIRING:1] Container OOMKilled (sample-node OOMKilled warning)",
          },
        ],
        ...over,
      });

    it("wakes the bot on a keyword found anywhere in what it says", () => {
      expect(classifySlackEvent(alert(), { keywords: ["[firing:"] })).toEqual({
        kind: "run",
        trigger: "keyword",
      });
    });

    it("answers a mention from an app", () => {
      expect(
        classifySlackEvent(alert({ type: "app_mention", text: `<@${SELF}> triage this` })),
      ).toEqual({ kind: "run", trigger: "mention" });
    });

    it("stays out of ordinary app traffic, like anyone else's", () => {
      expect(classifySlackEvent(alert(), { keywords: ["deploy"] })).toEqual({
        kind: "ignore",
        because: "not addressed to the bot",
      });
      expect(classifySlackEvent(alert()).kind).toBe("ignore");
    });

    it("does not follow up an app's reply in an engaged thread, or answer one in a DM", () => {
      // Two bots engaged in one thread would otherwise answer each other
      // without end; the app's reply is thread context, not a turn to answer.
      expect(classifySlackEvent(alert({ thread_ts: "1.0" }))).toEqual({
        kind: "ignore",
        because: "another app's thread reply",
      });
      expect(classifySlackEvent(alert({ channel_type: "im", channel: "D1" }))).toEqual({
        kind: "ignore",
        because: "another app's message in a DM",
      });
    });
  });

  describe("the duplicate a channel mention produces", () => {
    // Slack delivers a channel mention twice — as `app_mention` and as the
    // `message.channels` the same text produces — under two different event
    // ids, so the dedup claim does not join them.
    it("drops the message copy of a mention", () => {
      expect(classifySlackEvent(channelMessage({ text: `<@${SELF}> status?` }))).toEqual({
        kind: "ignore",
        because: "already delivered as app_mention",
      });
    });

    it("drops it in an engaged thread too, where it would otherwise run twice", () => {
      expect(
        classifySlackEvent(channelMessage({ text: `<@${SELF}> and now?`, thread_ts: "1.0" })).kind,
      ).toBe("ignore");
    });

    it("leaves a DM alone", () => {
      // Whether `app_mention` also fires in a DM is not something this depends
      // on; a DM answers every message, mention or not, exactly as before.
      expect(
        classifySlackEvent(
          envelope({
            type: "message",
            channel_type: "im",
            channel: "D1",
            ts: "1.0",
            text: `<@${SELF}> hi`,
          }),
        ),
      ).toEqual({ kind: "run", trigger: "dm" });
    });

    it("still answers a mention of someone else", () => {
      expect(classifySlackEvent(channelMessage({ text: "<@U_SOMEONE> ping" })).kind).toBe("ignore");
      expect(
        classifySlackEvent(channelMessage({ text: "<@U_SOMEONE> deploy?" }), {
          keywords: ["deploy"],
        }),
      ).toEqual({ kind: "run", trigger: "keyword" });
    });
  });

  describe("keywords", () => {
    it("wakes the bot on a match, case-insensitively", () => {
      expect(
        classifySlackEvent(channelMessage({ text: "How is the DEPLOY going" }), {
          keywords: ["deploy"],
        }),
      ).toEqual({ kind: "run", trigger: "keyword" });
    });

    it("matches inside a word, which is what Korean needs", () => {
      // `배포는` carries a particle; a word-boundary rule would never fire.
      expect(
        classifySlackEvent(channelMessage({ text: "배포는 언제 끝나?" }), { keywords: ["배포"] })
          .kind,
      ).toBe("run");
    });

    it("does nothing when the project named none", () => {
      expect(classifySlackEvent(channelMessage({ text: "deploy?" })).kind).toBe("ignore");
      expect(classifySlackEvent(channelMessage({ text: "deploy?" }), { keywords: [] }).kind).toBe(
        "ignore",
      );
    });

    it("is not consulted for a threaded message", () => {
      // A reply's engagement is the stronger signal and is asked about first —
      // otherwise a keyword would drag the bot into threads it left.
      expect(
        classifySlackEvent(channelMessage({ text: "deploy?", thread_ts: "1.0" }), {
          keywords: ["deploy"],
        }).kind,
      ).toBe("engagedThread");
    });
  });

  it("ignores subtyped bookkeeping but keeps a file upload", () => {
    expect(classifySlackEvent(channelMessage({ subtype: "channel_join", thread_ts: "1.0" })).kind).toBe(
      "ignore",
    );
    expect(
      classifySlackEvent(channelMessage({ subtype: "file_share", thread_ts: "1.0" })).kind,
    ).toBe("engagedThread");
  });

  it("ignores anything that is not a delivered event", () => {
    expect(classifySlackEvent({ type: "url_verification" }).kind).toBe("ignore");
    expect(classifySlackEvent({ type: "event_callback" }).kind).toBe("ignore");
    expect(classifySlackEvent(envelope({ type: "reaction_added", channel: "C1" })).kind).toBe(
      "ignore",
    );
  });

  it("falls back to bot_id when the envelope names no authorization", () => {
    // Older or unusual payloads carry no `authorizations`. The guard degrades to
    // what it was before that field existed rather than failing open entirely.
    const withoutAuth: SlackEventBody = {
      type: "event_callback",
      event: { type: "message", channel_type: "channel", channel: "C1", ts: "2.0", bot_id: "B1" },
    };

    expect(classifySlackEvent(withoutAuth).kind).toBe("ignore");
  });
});

/**
 * A command changes whether the bot speaks again, so recognising one is not a
 * matter of the message containing the word. It has to *be* the word.
 */
describe("commands", () => {
  it("recognises the exact words, case-insensitively", () => {
    expect(parseSlackCommand("!help")).toBe("help");
    expect(parseSlackCommand("  !mute  ")).toBe("mute");
    expect(parseSlackCommand("!UNMUTE")).toBe("unmute");
  });

  it("refuses anything with more to it", () => {
    // Guessing at intent here is how the bot stops answering somebody who never
    // asked it to.
    expect(parseSlackCommand("!mute this thread please")).toBeNull();
    expect(parseSlackCommand("can you !mute")).toBeNull();
    expect(parseSlackCommand("mute")).toBeNull();
    expect(parseSlackCommand("!restart")).toBeNull();
    expect(parseSlackCommand("")).toBeNull();
  });
});

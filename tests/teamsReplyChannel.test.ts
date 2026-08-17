import { afterEach, describe, expect, it, vi } from "vitest";
import { createTeamsReplyChannel, MAX_MESSAGE_CHARS } from "@/application/teams/replyChannel";
import type { TeamsClientPort, TeamsOutboundActivity } from "@/domain/teams/client";

const NOW = 1_750_000_000_000;
const CREDS = { appId: "app", appPassword: "secret" };
const TARGET = { serviceUrl: "https://smba.trafficmanager.net/emea/", conversationId: "a:1", replyToId: "7" };
const NO_SLEEP = { sleep: async () => {} };

function makeTeamsFake() {
  const sent: Array<TeamsOutboundActivity & { id: string; conversationId: string }> = [];
  const updated: Array<{ id: string; text?: string }> = [];
  let next = 1;
  const teams: TeamsClientPort = {
    async verifyRequest() {
      return { ok: true };
    },
    async authenticate() {
      return { expiresInSeconds: 3600 };
    },
    async sendActivity(_c, _s, conversationId, activity) {
      const id = String(next++);
      sent.push({ ...activity, id, conversationId });
      return { id };
    },
    async updateActivity(_c, _s, _conv, activityId, activity) {
      updated.push({ id: activityId, ...(activity.text !== undefined ? { text: activity.text } : {}) });
    },
    async downloadAttachment() {
      return Buffer.from("");
    },
  };
  const screen = () => {
    const byId = new Map<string, string>();
    for (const message of sent.filter((s) => s.type === "message")) {
      byId.set(message.id, message.text ?? "");
    }
    for (const edit of updated) {
      byId.set(edit.id, edit.text ?? "");
    }
    return [...byId.entries()].sort(([a], [b]) => Number(a) - Number(b)).map(([, text]) => text);
  };
  return { teams, sent, updated, screen };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("a Teams reply", () => {
  it("opens as a reply to the question, edits in place, and closes with the plain Markdown", async () => {
    let now = NOW;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const { teams, sent, updated, screen } = makeTeamsFake();
    const sink = createTeamsReplyChannel(teams, CREDS, TARGET, NO_SLEEP);

    await sink.push("Hel");
    now += 2500;
    await sink.push("Hello **world**");
    await sink.finish("Hello **world**", "");

    expect(sent.filter((s) => s.type === "message").map((s) => ({ text: s.text, replyToId: s.replyToId }))).toEqual([
      { text: "Hel ▌", replyToId: "7" },
    ]);
    // Markdown is Teams' own; nothing is rendered, and the cursor is gone.
    expect(updated.map((u) => u.text)).toEqual(["Hello **world** ▌", "Hello **world**"]);
    expect(screen()).toEqual(["Hello **world**"]);
  });

  it("reports progress as typing activities, refreshed on its own clock", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const { teams, sent } = makeTeamsFake();
    const sink = createTeamsReplyChannel(teams, CREDS, TARGET, NO_SLEEP);

    await sink.status("is thinking…");
    const stop = sink.keepStatusAlive();
    await vi.advanceTimersByTimeAsync(7000);
    stop();
    await vi.advanceTimersByTimeAsync(7000);
    vi.useRealTimers();

    expect(sent.filter((s) => s.type === "typing")).toHaveLength(3);
  });

  it("continues a long answer in a second message, and only the first replies to the question", async () => {
    let now = NOW;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const { teams, sent, screen } = makeTeamsFake();
    const sink = createTeamsReplyChannel(teams, CREDS, TARGET, NO_SLEEP);
    const text = `${"a".repeat(MAX_MESSAGE_CHARS - 100)}\n${"b".repeat(3000)}`;

    await sink.push(text.slice(0, 10));
    now += 3000;
    await sink.push(text);
    await sink.finish(text, "");

    const messages = sent.filter((s) => s.type === "message");
    expect(messages).toHaveLength(2);
    expect(messages.map((m) => m.replyToId)).toEqual(["7", undefined]);
    expect(screen().join("")).toBe(text);
  });

  it("sends a picture inline as a data URI, and refuses one Teams would not render", async () => {
    vi.spyOn(Date, "now").mockReturnValue(NOW);
    const { teams, sent } = makeTeamsFake();
    const sink = createTeamsReplyChannel(teams, CREDS, TARGET, NO_SLEEP);

    await sink.sendImage({ b64: "AA==", mimeType: "image/png", prompt: "a cat" }, 0);
    expect(sent[0]?.attachments?.[0]).toMatchObject({
      contentType: "image/png",
      contentUrl: "data:image/png;base64,AA==",
    });
    expect(sent[0]?.text).toBe("a cat");

    const huge = Buffer.alloc(5 * 1024 * 1024).toString("base64");
    await expect(sink.sendImage({ b64: huge, mimeType: "image/png" }, 1)).rejects.toThrow(/larger than Teams renders/);
  });

  it("phrases the tail in Markdown", () => {
    const { teams } = makeTeamsFake();
    const sink = createTeamsReplyChannel(teams, CREDS, TARGET, NO_SLEEP);
    expect(sink.fileLink({ url: "https://s/k", name: "report [v2].docx" })).toBe("📎 [report v2.docx](https://s/k)");
    expect(sink.warningLine("lost")).toBe("⚠️ lost");
  });
});

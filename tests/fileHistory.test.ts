import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadFileHistory, rememberFiles } from "@/application/messaging/fileHistory";
import type { ConversationTranscriptRepository, TranscriptTurn } from "@/domain/messaging/transcript";

const conversation = { surface: "slack" as const, id: "channel:thread" };
const actor = { kind: "slack" as const, id: "U1" };
function repository() {
  const turns = new Map<string, TranscriptTurn[]>();
  const value: ConversationTranscriptRepository = {
    append: vi.fn(async (agent, key, turn) => { const id = JSON.stringify([agent, key]); turns.set(id, [...(turns.get(id) ?? []), turn]); }),
    recent: vi.fn(async (agent, key, limit) => (turns.get(JSON.stringify([agent, key])) ?? []).slice(-limit)),
  };
  return value;
}
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date("2026-09-07T00:00:00.000Z")); });
afterEach(() => vi.useRealTimers());

describe("messaging file reference history", () => {
  it("retains IDs for follow-up edits without persisting signed URLs", async () => {
    const repo = repository();
    const warnings: string[] = [];
    await rememberFiles(repo, "agent", conversation, actor, [{ fileId: "file-1", name: "report.docx", mimeType: "application/msword", url: "https://signed.test/?token=secret" }], warnings);
    const history = await loadFileHistory(repo, "agent", conversation, actor, warnings);
    expect(history).toContain('"fileId":"file-1"');
    expect(history).toContain("report.docx");
    expect(history).not.toContain("secret");
    expect(history).not.toContain("https://");
    expect(warnings).toEqual([]);
    expect(repo.recent).toHaveBeenCalledWith("agent", expect.any(String), 20);
  });

  it("isolates actors, conversations and agents", async () => {
    const repo = repository();
    await rememberFiles(repo, "agent", conversation, actor, [{ fileId: "file-1", name: "report", mimeType: "text/plain" }], []);
    expect(await loadFileHistory(repo, "agent", conversation, { ...actor, id: "U2" }, [])).toBe("");
    expect(await loadFileHistory(repo, "agent", { ...conversation, id: "another" }, actor, [])).toBe("");
    expect(await loadFileHistory(repo, "other", conversation, actor, [])).toBe("");
    expect(await loadFileHistory(repo, "agent", conversation, undefined, [])).toBe("");
  });

  it("bounds history and reports storage failures without exposing their detail", async () => {
    const repo = repository();
    for (let index = 0; index < 21; index++) await rememberFiles(repo, "agent", conversation, actor, [{ fileId: `file-${index}`, name: "report", mimeType: "text/plain" }], []);
    const history = await loadFileHistory(repo, "agent", conversation, actor, []);
    expect(history).not.toContain('"fileId":"file-0"');
    expect(history).toContain('"fileId":"file-20"');
    repo.recent = async () => { throw new Error("private storage detail"); };
    repo.append = async () => { throw new Error("private storage detail"); };
    vi.spyOn(console, "error").mockImplementation(() => {});
    const warnings: string[] = [];
    expect(await loadFileHistory(repo, "agent", conversation, actor, warnings)).toBe("");
    await rememberFiles(repo, "agent", conversation, actor, [{ fileId: "file", name: "report", mimeType: "text/plain" }], warnings);
    expect(warnings).toHaveLength(2);
    expect(warnings.join(" ")).not.toContain("private storage detail");
  });
});

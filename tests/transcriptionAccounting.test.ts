import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { recordTranscriptionUsage } from "@/application/audio/recordTranscriptionUsage";
import { PostgresUsageRepository } from "@/infrastructure/db/repositories/usageRepository";
import { keys } from "@/infrastructure/db/keys";
import { interactiveIdentity } from "./runIdentity";
import type { TranscriptionResult } from "@/domain/llm/transcription";
import type { FakeStore } from "./fakeStore";

vi.mock("@/infrastructure/db/store", async () => (await import("./fakeStore")).createFakeStore());
const store = await import("@/infrastructure/db/store") as unknown as FakeStore;
const usage = new PostgresUsageRepository();
const job = { agentName: "audio", ...interactiveIdentity("caller@test.example", "caller") };
const result: TranscriptionResult = { model: "asr", text: "hello", segments: [], warnings: [], usage: { outputTokens: 10 },
  accounting: { eventId: "segment", date: "2026-10-09", costUsd: 1 } };
beforeEach(() => { store.rows.clear(); store.seed([{ ...keys.agent("audio"), entityType: "AGENT" }]);
  vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-10-09T00:00:00Z")); });
afterEach(() => vi.restoreAllMocks());

describe("transcription accounting", () => {
  it("replays an untimed receipt without changing its payload", async () => {
    await usage.record({ agentName: "audio", date: "2026-10-09", model: "asr", calls: 1, inputTokens: 0, outputTokens: 10,
      costUsd: 1, idempotencyKey: "segment", actor: "user:caller@test.example", userId: "caller" });
    await recordTranscriptionUsage(usage, job, result);
    expect((await usage.getDay("audio", "2026-10-09"))?.calls.asr).toBe(1);
  });
  it("records measured tokens and duration only once on checkpoint replay", async () => {
    const measured = { ...result, modelDurationMs: 500 };
    await recordTranscriptionUsage(usage, job, measured);
    await recordTranscriptionUsage(usage, job, measured);
    expect(await usage.getDay("audio", "2026-10-09")).toMatchObject({ calls: { asr: 1 }, costUsd: { asr: 1 },
      modelDurationMs: { asr: 500 }, timedOutputTokens: { asr: 10 }, timedCalls: { asr: 1 } });
  });
  it("leaves output throughput unmeasured for audio-only billing", async () => {
    await recordTranscriptionUsage(usage, job, { ...result, modelDurationMs: 500, usage: { audioSeconds: 10 } });
    expect(await usage.getDay("audio", "2026-10-09")).toMatchObject({ costUsd: { asr: 1 }, timedCalls: { asr: 0 } });
  });
  it("refuses an unknown bill before any usage write", async () => {
    await expect(recordTranscriptionUsage(usage, job, { ...result, accounting: undefined })).rejects.toThrow("transcription_cost_unknown");
    expect(await usage.getDay("audio", "2026-10-09")).toBeNull();
  });
});

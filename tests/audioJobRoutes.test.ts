import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ submit: vi.fn(), list: vi.fn(), get: vi.fn(), cancel: vi.fn(), delete: vi.fn(), retry: vi.fn(), register: vi.fn(), options: vi.fn(), favorites: vi.fn(), getConfig: vi.fn(), saveConfig: vi.fn() }));
vi.mock("@/lib/session", () => ({ withMemberAuth: (handler: (user: { id: string; email: string }, request: Request, context: unknown) => Promise<Response>) =>
  (request: Request, context: unknown) => handler({ id: "owner-1", email: "owner@example.test" }, request, context) }));
vi.mock("@/lib/container", () => ({ getAudioRuntime: () => ({ jobs: mocks, options: mocks.options, references: { register: mocks.register }, configuration: { get: mocks.getConfig, save: mocks.saveConfig } }), modelPreferenceUseCases: { listOptional: mocks.favorites } }));
vi.mock("node:crypto", async (original) => ({ ...await original<typeof import("node:crypto")>(), randomUUID: () => "occurrence-1" }));
import { POST, GET } from "@/app/api/projects/[name]/audio-jobs/route";
import { POST as action } from "@/app/api/projects/[name]/audio-jobs/[job]/route";
import { POST as source } from "@/app/api/projects/[name]/source-references/route";
import { GET as options } from "@/app/api/projects/[name]/audio-options/route";
import { PUT as saveConfig } from "@/app/api/projects/[name]/audio-config/route";

const context = { params: Promise.resolve({ name: "audio" }) };
const input = { source: { kind: "file", fileId: "file-1" }, task: "transcribe", model: "openai/whisper-1",
  retention: { unit: "months", value: 3, timezone: "Asia/Seoul" } };
function request(body: unknown) { return new Request("https://studio.test/api/projects/audio/audio-jobs", {
  method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
}); }
beforeEach(() => { vi.clearAllMocks(); mocks.submit.mockResolvedValue({ status: "accepted", job: { id: "job-1" } }); mocks.favorites.mockResolvedValue([]); });

describe("audio job HTTP contracts", () => {
  it("validates deletion and binds the owner and revision", async () => {
    const ctx = { params: Promise.resolve({ name: "audio", job: "job-1" }) };
    expect((await action(request({ action: "delete" }), ctx)).status).toBe(400);
    expect((await action(request({ action: "delete", revision: 3, userEmail: "other@example.test" }), ctx)).status).toBe(400);
    expect(mocks.delete).not.toHaveBeenCalled();
    mocks.delete.mockResolvedValue({ deleted: true });
    const response = await action(request({ action: "delete", revision: 3 }), ctx);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ deleted: true });
    expect(mocks.delete).toHaveBeenCalledWith("audio", "job-1", "owner@example.test", 3);
  });
  it("validates configuration writes and binds the save to the session owner", async () => {
    const body = { revision: 0, enabled: true, model: input.model, retention: input.retention, maxActive: 1, maxPerOccurrence: 1 };
    mocks.saveConfig.mockResolvedValue({ ...body, revision: 1 });
    expect((await saveConfig(request({ ...body, userEmail: "other@example.test" }), context)).status).toBe(400);
    expect(mocks.saveConfig).not.toHaveBeenCalled();
    expect((await saveConfig(request(body), context)).status).toBe(200);
    const { revision, ...configuration } = body;
    expect(mocks.saveConfig).toHaveBeenCalledWith("audio", "owner@example.test", configuration, revision);
  });
  it("reads configured options with the authenticated identity", async () => {
    const data = { models: [{ id: "openai/whisper-1", displayName: "Whisper 1" }], destinations: ["memory"] };
    mocks.options.mockResolvedValue(data);
    mocks.favorites.mockResolvedValue(["openai/whisper-1"]);
    const response = await options(new Request("https://studio.test/api?email=another@example.test"), context);
    expect(await response.json()).toEqual({ ...data, models: [{ ...data.models[0], favorite: true }] });
    expect(mocks.options).toHaveBeenCalledWith("audio", "owner@example.test");
    expect(mocks.favorites).toHaveBeenCalledWith("owner-1");
  });
  it("keeps audio model options available without optional favorites", async () => {
    const data = { models: [{ id: "openai/whisper-1" }], destinations: [] };
    mocks.options.mockResolvedValue(data);
    const response = await options(new Request("https://studio.test/api/projects/audio/audio-options"), context);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ...data, models: [{ ...data.models[0], favorite: false }] });
  });
  it("binds submitted work to the authenticated email and server occurrence", async () => {
    const response = await POST(request(input), context);
    expect(response.status).toBe(202);
    expect(mocks.submit).toHaveBeenCalledWith("audio", "owner@example.test", input,
      { occurrence: "occurrence-1", actor: { kind: "user", id: "owner@example.test" } });
  });
  it("rejects a caller-supplied identity and invalid retention", async () => {
    expect((await POST(request({ ...input, userEmail: "another@example.test" }), context)).status).toBe(400);
    expect((await POST(request({ ...input, retention: { unit: "months", value: -1, timezone: "Asia/Seoul" } }), context)).status).toBe(400);
    expect(mocks.submit).not.toHaveBeenCalled();
  });
  it("validates the list bound before calling the use case", async () => {
    expect((await GET(new Request("https://studio.test/api?limit=1000"), context)).status).toBe(400);
    expect(mocks.list).not.toHaveBeenCalled();
    mocks.list.mockResolvedValue([{ id: "job-2" }]);
    const response = await GET(new Request("https://studio.test/api?limit=1&after=job-1"), context);
    expect(await response.json()).toEqual({ jobs: [{ id: "job-2" }], nextCursor: "job-2" });
    expect(mocks.list).toHaveBeenCalledWith("audio", "owner@example.test", 1, "job-1");
  });
  it("passes revision checks through cancellation", async () => {
    mocks.cancel.mockResolvedValue({ id: "job-1", status: "cancelled" });
    expect((await action(request({ action: "cancel", revision: 3 }), { params: Promise.resolve({ name: "audio", job: "job-1" }) })).status).toBe(200);
    expect(mocks.cancel).toHaveBeenCalledWith("audio", "job-1", "owner@example.test", 3);
  });
  it("registers URLs through the bound source use case", async () => {
    mocks.register.mockResolvedValue({ sourceRef: "ref-1" });
    const metadata = { url: "https://files.test/audio?signature=test", namespace: "source", itemId: "item-1",
      filename: "audio.mp3", mimeType: "audio/mpeg" };
    const response = await source(request(metadata), context);
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ sourceRef: "ref-1" });
    expect(mocks.register).toHaveBeenCalledWith({ ...metadata, projectName: "audio", userEmail: "owner@example.test" });
  });
});

import { describe, expect, it, vi } from "vitest";
import { createProviderModelDiscovery } from "@/infrastructure/llm/providerModelDiscovery";
import type { ProviderChannelConfig } from "@/domain/settings/types";
import type { DiscoveredModel } from "@/domain/llm/providerModels";

const provider = (name: string, kind: ProviderChannelConfig["kind"] = "selfhosted", baseUrl = "https://provider.test/v1"): ProviderChannelConfig =>
  ({ name, kind, baseUrl, apiKey: "test-key", auth: "bearer", keepModelPrefix: false });

function catalog(models: DiscoveredModel[], refresh = vi.fn(async () => false)) {
  return { list: vi.fn(() => models), refreshIfDue: refresh };
}

describe("model discovery", () => {
  it("uses the published catalog for a registered public provider without sending its URL or key", async () => {
    const fetch = vi.fn();
    const model = { wireId: "claude-sonnet-4-6", displayName: "Claude Sonnet 4.6", type: "text" as const };
    const published = catalog([model]);
    const models = await createProviderModelDiscovery(fetch as unknown as typeof globalThis.fetch, published)
      .list({ ...provider("company-claude", "anthropic"), auth: "sigv4" });

    expect(models).toEqual([model]);
    expect(published.list).toHaveBeenCalledWith("anthropic");
    expect(published.refreshIfDue).toHaveBeenCalledOnce();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("keeps the last validated catalog available when its optional refresh fails", async () => {
    const published = catalog([{ wireId: "gpt-5", displayName: "GPT-5" }], vi.fn(async () => { throw new Error("offline"); }));
    expect(await createProviderModelDiscovery(vi.fn() as unknown as typeof globalThis.fetch, published)
      .list(provider("openai", "openai"))).toEqual([{ wireId: "gpt-5", displayName: "GPT-5" }]);
  });

  it("reads a self-hosted listing without leaking credentials in the URL", async () => {
    const fetch = vi.fn(async () => Response.json({ data: [{
      id: "local/model", type: "image", context_length: 8000,
      architecture: { input_modalities: ["text", "image"], output_modalities: ["image"] },
      supported_parameters: { tools: false, structured_outputs: { supported: true }, reasoning: { supported: false } },
    }] }));
    const published = catalog([]);
    const models = await createProviderModelDiscovery(fetch as unknown as typeof globalThis.fetch, published)
      .list(provider("local", "selfhosted", "http://localhost:1234/v1"));
    expect(models).toEqual([{
      wireId: "local/model", displayName: "local/model", type: "image", contextWindow: 8000,
      inputModalities: ["text", "image"], outputModalities: ["image"],
      capabilities: { tools: false, structuredOutput: true, reasoning: false, imageInput: true },
    }]);
    expect(fetch).toHaveBeenCalledWith("http://localhost:1234/v1/models", expect.objectContaining({
      headers: { accept: "application/json", authorization: "Bearer test-key" },
      redirect: "error",
    }));
    expect(published.refreshIfDue).not.toHaveBeenCalled();
  });

  it("preserves explicit output modalities ahead of name guesses for self-hosted models", async () => {
    const fetch = vi.fn(async () => Response.json({ data: [
      { id: "gpt-audio", architecture: { output_modalities: ["transcription"] } },
      { id: "gpt-video", architecture: { output_modalities: ["video"] } },
    ] }));
    const models = await createProviderModelDiscovery(fetch as unknown as typeof globalThis.fetch)
      .list(provider("local"));
    expect(models.map(model => model.type)).toEqual(["transcription", undefined]);
  });

  it("consumes every self-hosted page and rejects a repeated cursor", async () => {
    const fetch = vi.fn(async (_url: string) => Response.json({ data: [{ id: "a" }], has_more: true, last_id: "a" }));
    await expect(createProviderModelDiscovery(fetch as unknown as typeof globalThis.fetch)
      .list(provider("local"))).rejects.toThrow("repeated a page cursor");
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch.mock.calls[1]?.[0]).toContain("after_id=a");
  });

  it.each([
    "https://user:secret@provider.test/v1",
    "https://provider.test/v1?key=secret",
    "file:///tmp/models",
  ])("rejects an unsafe self-hosted URL before fetch: %s", async baseUrl => {
    const fetch = vi.fn();
    await expect(createProviderModelDiscovery(fetch as unknown as typeof globalThis.fetch)
      .list(provider("local", "selfhosted", baseUrl))).rejects.toThrow("Provider URL");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("bounds self-hosted response bytes and hides upstream errors", async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(new Response("echo: test-key", { status: 401 }))
      .mockResolvedValueOnce(new Response("{}", { headers: { "content-length": String(5 * 1024 * 1024) } }));
    const discovery = createProviderModelDiscovery(fetch as unknown as typeof globalThis.fetch);
    await expect(discovery.list(provider("local"))).rejects.toThrow("Provider model discovery failed (HTTP 401)");
    await expect(discovery.list(provider("local"))).rejects.toThrow("HTTP body exceeds");
  });
});

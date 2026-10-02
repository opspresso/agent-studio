import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchProvider } from "@/infrastructure/llm/providerFetch";
import { getOpenAIClient } from "@/infrastructure/llm/openaiClient";

afterEach(() => vi.unstubAllGlobals());

describe("provider fetch", () => {
  it.each([undefined, "follow", "manual"] as const)("refuses redirects despite caller option %s", async (redirect) => {
    const controller = new AbortController();
    let sent: Request | undefined;
    const fetcher = vi.fn<typeof fetch>(async (input, init) => {
      sent = new Request(input, init);
      return Response.json({ ok: true });
    });
    vi.stubGlobal("fetch", fetcher);
    const request = new Request("https://provider.test/v1/model", {
      method: "POST", body: "private fixture input", redirect: "follow", signal: controller.signal,
      headers: { Authorization: "Bearer fixture", "x-probe": "retained" },
    });

    await fetchProvider(request, { redirect });

    expect(sent?.redirect).toBe("error");
    expect(sent?.method).toBe("POST");
    expect(sent?.headers.get("authorization")).toBe("Bearer fixture");
    expect(sent?.headers.get("x-probe")).toBe("retained");
    expect(await sent?.text()).toBe("private fixture input");
    controller.abort();
    expect(sent?.signal.aborted).toBe(true);
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("keeps bearer SDK requests protected when request options enable redirects", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => Response.json({
      id: "fixture", object: "chat.completion", created: 0, model: "fixture", choices: [],
    }));
    vi.stubGlobal("fetch", fetcher);
    const client = getOpenAIClient({ providerName: "selfhosted", baseUrl: "https://provider-redirect.test/v1",
      auth: "bearer", apiKey: "fixture-key", model: "fixture" });

    await client.chat.completions.create({ model: "fixture", messages: [{ role: "user", content: "private fixture" }] },
      { fetchOptions: { redirect: "follow" } });

    expect(fetcher.mock.calls[0]?.[1]?.redirect).toBe("error");
    expect(fetcher).toHaveBeenCalledOnce();
  });
});

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  generateProjectToken,
  getProjectSlack,
  previewPrompt,
  streamAgent,
  updateProjectSlack,
} from "@/app/projects/lib/api";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("project API client failures", () => {
  it("forwards preview cancellation to the request", async () => {
    const fetchMock = vi.fn(async () => Response.json({
      messages: [],
      toolNames: [],
      tools: [],
      warnings: [],
      discovered: [],
    }));
    vi.stubGlobal("fetch", fetchMock);
    const controller = new AbortController();

    await previewPrompt(
      "demo",
      {
        systemPrompt: "",
        userPromptTemplate: "",
        model: "gpt-test",
        parameters: { piiFiltering: false },
        mcpList: [],
        skillList: [],
        subagentList: [],
      },
      controller.signal,
    );

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/projects/demo/preview",
      expect.objectContaining({ signal: controller.signal }),
    );
  });

  it("uses the shared unauthorized redirect for integration reads", async () => {
    const replace = vi.fn();
    vi.stubGlobal("window", {
      location: {
        origin: "https://studio.example.com",
        pathname: "/projects/demo/integrations",
        search: "",
        hash: "",
        replace,
      },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ error: "Unauthorized" }, { status: 401 })),
    );

    await expect(getProjectSlack("demo")).rejects.toThrow("Authentication required");
    expect(replace).toHaveBeenCalledWith(
      "/login?next=%2Fprojects%2Fdemo%2Fintegrations",
    );
  });

  it("reports a stable fallback when an upstream error is not JSON", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("bad gateway", { status: 502 })),
    );

    await expect(updateProjectSlack("demo", { enabled: true })).rejects.toThrow(
      "Request failed (502)",
    );
  });

  it("preserves server error details for Agent execution", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ error: "Image model is unavailable" }, { status: 503 })),
    );

    await expect(streamAgent("demo", "v1", [{ role: "user", content: "draw" }])).rejects.toThrow(
      "Image model is unavailable",
    );
  });

  it("rejects a successful token response that omits the credential", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ masked: "ast_...", createdAt: "2026-09-04" })),
    );

    await expect(generateProjectToken("demo")).rejects.toThrow(
      "Project API token response did not include a token",
    );
  });
});

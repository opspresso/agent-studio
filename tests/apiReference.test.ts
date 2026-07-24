import { describe, expect, it } from "vitest";
import {
  buildApiReference,
  PLACEHOLDERS,
  type ApiEndpoint,
  type ApiReferenceContext,
} from "@/app/projects/[name]/api-reference/endpoints";

const ORIGIN = "https://studio.example.com";

function ctx(overrides: Partial<ApiReferenceContext> = {}): ApiReferenceContext {
  return {
    projectName: "my-bot",
    projectType: "agent",
    publishedVersion: "3",
    origin: ORIGIN,
    a2a: null,
    slack: null,
    ...overrides,
  };
}

function ids(overrides: Partial<ApiReferenceContext> = {}): string[] {
  return buildApiReference(ctx(overrides)).map((e) => e.id);
}

function codeOf(endpoint: ApiEndpoint, language: string): string | undefined {
  return endpoint.codeExamples.find((c) => c.language === language)?.code;
}

describe("buildApiReference — endpoint selection by project type", () => {
  it("agent project exposes predict, chat/completions, and agent", () => {
    expect(ids({ projectType: "agent" })).toEqual(["predict", "chat-completions", "agent"]);
  });

  it("llm project exposes predict and chat/completions only (no agent/chat)", () => {
    expect(ids({ projectType: "llm" })).toEqual(["predict", "chat-completions"]);
  });

  it("image project exposes only the image predict endpoint", () => {
    const endpoints = buildApiReference(ctx({ projectType: "image" }));
    expect(endpoints.map((e) => e.id)).toEqual(["predict-image"]);
    expect(endpoints[0]?.requestFields?.some((f) => f.name === "prompt")).toBe(true);
    expect(endpoints[0]?.responseFields?.some((f) => f.name === "imageBase64")).toBe(true);
  });
});

describe("buildApiReference — published version gating", () => {
  it("hides all execution endpoints when there is no published version", () => {
    expect(ids({ publishedVersion: null })).toEqual([]);
  });

  it("fills the published version name into execution paths", () => {
    const predict = buildApiReference(ctx({ publishedVersion: "7" })).find(
      (e) => e.id === "predict",
    );
    expect(predict?.path).toBe("/api/projects/my-bot/versions/7/predict");
    expect(codeOf(predict!, "bash")).toContain(`${ORIGIN}/api/projects/my-bot/versions/7/predict`);
  });
});

describe("buildApiReference — request/response field specs", () => {
  it("documents predict request and response fields", () => {
    const predict = buildApiReference(ctx({ projectType: "llm" })).find((e) => e.id === "predict");
    expect(predict?.requestFields?.map((f) => f.name)).toEqual(["variables", "messages", "stream"]);
    expect(predict?.responseFields?.map((f) => f.name)).toEqual(["result", "model", "usage"]);
    // usage carries nested children.
    expect(predict?.responseFields?.find((f) => f.name === "usage")?.children).toBeDefined();
  });

  it("marks chat/completions messages as required", () => {
    const cc = buildApiReference(ctx()).find((e) => e.id === "chat-completions");
    expect(cc?.requestFields?.find((f) => f.name === "messages")?.required).toBe(true);
  });
});

describe("buildApiReference — code examples (curl + Python + Node.js)", () => {
  it("chat/completions offers curl, Python, Node.js, and their streaming variants", () => {
    const cc = buildApiReference(ctx()).find((e) => e.id === "chat-completions");
    expect(cc?.codeExamples.map((c) => c.label)).toEqual([
      "curl",
      "Python",
      "Node.js",
      "Python (stream)",
      "Node.js (stream)",
    ]);
  });

  it("streaming samples hit the same endpoint with stream set", () => {
    const cc = buildApiReference(ctx()).find((e) => e.id === "chat-completions");
    const py = cc?.codeExamples.find((c) => c.label === "Python (stream)")?.code ?? "";
    const node = cc?.codeExamples.find((c) => c.label === "Node.js (stream)")?.code ?? "";
    expect(py).toContain("stream=True");
    expect(node).toContain("stream: true");
    // Same base URL as the non-streaming SDK samples — no separate endpoint.
    expect(py).toContain(`${ORIGIN}/api/projects/my-bot/versions/3`);
  });

  it("non-OpenAI endpoints carry a curl sample only", () => {
    const predict = buildApiReference(ctx()).find((e) => e.id === "predict");
    expect(predict?.codeExamples.map((c) => c.language)).toEqual(["bash"]);
  });

  it("SDK samples point base_url at the version root (SDK appends /chat/completions)", () => {
    const cc = buildApiReference(ctx({ publishedVersion: "3" })).find(
      (e) => e.id === "chat-completions",
    );
    const base = `${ORIGIN}/api/projects/my-bot/versions/3`;
    expect(codeOf(cc!, "python")).toContain(`base_url="${base}"`);
    expect(codeOf(cc!, "javascript")).toContain(`baseURL: "${base}"`);
  });
});

describe("buildApiReference — A2A endpoints", () => {
  it("shows A2A endpoints only when enabled and published", () => {
    expect(ids({ a2a: { enabled: true, published: true } })).toContain("a2a-card");
    expect(ids({ a2a: { enabled: true, published: true } })).toContain("a2a-rpc");
    expect(ids({ a2a: { enabled: true, published: false } })).not.toContain("a2a-rpc");
    expect(ids({ a2a: { enabled: false, published: true } })).not.toContain("a2a-rpc");
    expect(ids({ a2a: null })).not.toContain("a2a-rpc");
  });

  it("marks the Agent Card as public and the JSON-RPC as X-A2A-Key authed", () => {
    const endpoints = buildApiReference(ctx({ a2a: { enabled: true, published: true } }));
    expect(endpoints.find((e) => e.id === "a2a-card")?.auth).toBe("public");
    expect(endpoints.find((e) => e.id === "a2a-rpc")?.auth).toBe("a2a-key");
  });
});

describe("buildApiReference — Slack endpoint", () => {
  it("shows the Slack webhook only when configured (owner view)", () => {
    expect(ids({ slack: { configured: true } })).toContain("slack-events");
    expect(ids({ slack: { configured: false } })).not.toContain("slack-events");
    expect(ids({ slack: null })).not.toContain("slack-events");
  });
});

describe("buildApiReference — no real secrets leak into examples", () => {
  // Every string a viewer can copy, across the richest possible context.
  function allStrings(): string[] {
    const endpoints = buildApiReference(
      ctx({
        a2a: { enabled: true, published: true },
        slack: { configured: true },
      }),
    );
    return endpoints.flatMap((e) =>
      [...e.codeExamples.map((c) => c.code), e.responseExample].filter(
        (s): s is string => s !== undefined,
      ),
    );
  }

  it("only ever emits placeholder tokens for credentials", () => {
    // The context type carries no secret fields, so a concrete secret cannot
    // reach any example. Assert the credential-shaped strings present are
    // exactly the known placeholders.
    for (const value of Object.values(PLACEHOLDERS)) {
      expect(value.startsWith("$")).toBe(true);
    }

    for (const text of allStrings()) {
      expect(text).not.toMatch(/sk-[A-Za-z0-9]/); // OpenAI-style key
      expect(text).not.toMatch(/sk_proj_[A-Za-z0-9]/); // a real project token value
      expect(text).not.toMatch(/xoxb-/); // Slack bot token
    }
  });

  it("authenticated samples carry their credential placeholder", () => {
    const endpoints = buildApiReference(
      ctx({ a2a: { enabled: true, published: true }, slack: { configured: true } }),
    );
    const byId = (id: string) => endpoints.find((e) => e.id === id)!;

    expect(codeOf(byId("predict"), "bash")).toContain(PLACEHOLDERS.token);
    expect(codeOf(byId("predict"), "bash")).toContain("Authorization: Bearer");
    expect(codeOf(byId("chat-completions"), "python")).toContain(PLACEHOLDERS.token);
    expect(codeOf(byId("chat-completions"), "javascript")).toContain(PLACEHOLDERS.token);
    expect(codeOf(byId("a2a-rpc"), "bash")).toContain(PLACEHOLDERS.a2aKey);
    expect(codeOf(byId("slack-events"), "bash")).toContain(PLACEHOLDERS.slackSignature);
    // The public Agent Card carries no credential.
    expect(codeOf(byId("a2a-card"), "bash")).not.toContain(PLACEHOLDERS.token);
    expect(codeOf(byId("a2a-card"), "bash")).not.toContain(PLACEHOLDERS.a2aKey);
  });
});

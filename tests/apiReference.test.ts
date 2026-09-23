import { describe, expect, it } from "vitest";
import { agentSchema, chatCompletionsSchema, predictSchema } from "@/app/api/projects/_lib/schemas";
import {
  buildApiReference,
  PLACEHOLDERS,
  type ApiEndpoint,
  type ApiReferenceContext,
} from "@/app/agents/[name]/api-reference/endpoints";

const ORIGIN = "https://studio.example.com";

function ctx(overrides: Partial<ApiReferenceContext> = {}): ApiReferenceContext {
  return {
    projectName: "my-bot",
    configured: true,
    origin: ORIGIN,
    slack: null,
    telegram: null,
    teams: null,
    webhook: null,
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
    expect(ids({ })).toEqual(["predict", "chat-completions", "agent"]);
  });


});

describe("buildApiReference — current configuration gating", () => {
  it("hides all execution endpoints when there is no current configuration", () => {
    expect(ids({ configured: false })).toEqual([]);
  });

  it("uses project names for execution paths", () => {
    const predict = buildApiReference(ctx({ configured: true })).find(
      (e) => e.id === "predict",
    );
    expect(predict?.path).toBe("/api/projects/my-bot/predict");
    expect(codeOf(predict!, "bash")).toContain(`${ORIGIN}/api/projects/my-bot/predict`);
  });
});

describe("buildApiReference — request/response field specs", () => {
  it("documents predict request and response fields", () => {
    const predict = buildApiReference(ctx({ })).find((e) => e.id === "predict");
    expect(predict?.requestFields?.map((f) => f.name)).toEqual(["messages", "stream", "documents"]);
    expect(predict?.responseFields?.map((f) => f.name)).toEqual([
      "result",
      "model",
      "usage",
      "finishReason",
      "warnings",
      "images",
      "files",
    ]);
    // usage carries nested children.
    expect(predict?.responseFields?.find((f) => f.name === "usage")?.children).toBeDefined();
  });

  it.each([
    ["predict", predictSchema], ["chat-completions", chatCompletionsSchema], ["agent", agentSchema],
  ] as const)("keeps %s request fields and its curl body aligned with the route schema", (id, schema) => {
    const endpoint = buildApiReference(ctx()).find(item => item.id === id)!;
    expect(endpoint.requestFields!.map(field => field.name).sort()).toEqual(Object.keys(schema.shape).sort());
    const required = Object.entries(schema.shape).filter(([, field]) => !field.isOptional()).map(([name]) => name);
    expect(endpoint.requestFields!.filter(field => field.required).map(field => field.name)).toEqual(required);
    const body = JSON.parse(/-d '([^']+)'$/.exec(codeOf(endpoint, "bash")!)![1]!);
    expect(schema.parse(body)).toEqual(body);
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
      "Python (stream)",
      "Node.js",
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
    expect(py).toContain(`${ORIGIN}/api/projects/my-bot`);
  });

  it("non-OpenAI endpoints carry a curl sample only", () => {
    const predict = buildApiReference(ctx()).find((e) => e.id === "predict");
    expect(predict?.codeExamples.map((c) => c.language)).toEqual(["bash"]);
  });

  it("SDK samples point base_url at the project root (SDK appends /chat/completions)", () => {
    const cc = buildApiReference(ctx({ configured: true })).find(
      (e) => e.id === "chat-completions",
    );
    const base = `${ORIGIN}/api/projects/my-bot`;
    expect(codeOf(cc!, "python")).toContain(`base_url="${base}"`);
    expect(codeOf(cc!, "javascript")).toContain(`baseURL: "${base}"`);
  });
});

describe("buildApiReference — project webhook", () => {
  it("shows the webhook only once it is switched on (owner view)", () => {
    expect(ids({ webhook: { enabled: true } })).toContain("webhook");
    expect(ids({ webhook: { enabled: false } })).not.toContain("webhook");
    expect(ids({ webhook: null })).not.toContain("webhook");
  });

  it("addresses it by project name alone and authenticates with the trigger secret", () => {
    const endpoint = buildApiReference(ctx({ webhook: { enabled: true } })).find(
      (e) => e.id === "webhook",
    );
    expect(endpoint?.path).toBe("/api/webhook/my-bot");
    expect(endpoint?.auth).toBe("trigger-secret");
    expect(codeOf(endpoint!, "bash")).toContain(`${ORIGIN}/api/webhook/my-bot`);
    expect(codeOf(endpoint!, "bash")).toContain("X-Trigger-Secret");
    // The header that makes a redelivery safe is part of the sample, not prose
    // a reader has to translate into a curl flag themselves.
    expect(codeOf(endpoint!, "bash")).toContain("Idempotency-Key");
  });

  it("stays listed with no current configuration, because the address is live either way", () => {
    // The other endpoints are hidden without one; this one answers
    // `no-configuration` at 202, which is the thing worth documenting.
    expect(ids({ configured: false, webhook: { enabled: true } })).toEqual(["webhook"]);
  });

  it("documents every status a 202 can carry", () => {
    const status = buildApiReference(ctx({ webhook: { enabled: true } }))
      .find((e) => e.id === "webhook")
      ?.responseFields?.find((f) => f.name === "status");
    for (const value of ["accepted", "disabled", "duplicate", "busy", "no-configuration"]) {
      expect(status?.description).toContain(value);
    }
  });
});

describe("buildApiReference — Slack endpoint", () => {
  it("shows the Slack webhook only when configured (owner view)", () => {
    expect(ids({ slack: { configured: true } })).toContain("slack-events");
    expect(ids({ slack: { configured: false } })).not.toContain("slack-events");
    expect(ids({ slack: null })).not.toContain("slack-events");
  });
});

describe("buildApiReference — Teams endpoint", () => {
  it("shows the Teams messaging endpoint only when configured (owner view)", () => {
    expect(ids({ teams: { configured: true } })).toContain("teams-messages");
    expect(ids({ teams: { configured: false } })).not.toContain("teams-messages");
    expect(ids({ teams: null })).not.toContain("teams-messages");
  });
});

describe("buildApiReference — Telegram endpoint", () => {
  it("shows the Telegram webhook only when configured (owner view)", () => {
    expect(ids({ telegram: { configured: true } })).toContain("telegram-webhook");
    expect(ids({ telegram: { configured: false } })).not.toContain("telegram-webhook");
    expect(ids({ telegram: null })).not.toContain("telegram-webhook");
  });
});

describe("buildApiReference — no real secrets leak into examples", () => {
  // Every string a viewer can copy, across the richest possible context.
  function allStrings(): string[] {
    const endpoints = buildApiReference(
      ctx({
        slack: { configured: true },
        webhook: { enabled: true },
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
      ctx({
        slack: { configured: true },
        telegram: { configured: true },
        teams: { configured: true },
        webhook: { enabled: true },
      }),
    );
    const byId = (id: string) => endpoints.find((e) => e.id === id)!;

    expect(codeOf(byId("predict"), "bash")).toContain(PLACEHOLDERS.token);
    expect(codeOf(byId("predict"), "bash")).toContain("Authorization: Bearer");
    expect(codeOf(byId("chat-completions"), "python")).toContain('os.environ["PROJECT_API_TOKEN"]');
    expect(codeOf(byId("chat-completions"), "javascript")).toContain("process.env.PROJECT_API_TOKEN");
    expect(codeOf(byId("slack-events"), "bash")).toContain(PLACEHOLDERS.slackSignature);
    expect(codeOf(byId("telegram-webhook"), "bash")).toContain(PLACEHOLDERS.telegramSecret);
    expect(codeOf(byId("teams-messages"), "bash")).toContain(PLACEHOLDERS.teamsToken);
    expect(codeOf(byId("webhook"), "bash")).toContain(PLACEHOLDERS.webhookSecret);
  });
});

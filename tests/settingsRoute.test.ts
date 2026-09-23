import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `PUT /api/settings` validates with its own zod schema before anything reaches
 * `settingsUseCases.update`, so a key missing from that schema is silently
 * stripped even though `SettingsUpdate` is typed over every `SettingKey`. That
 * happened once to the repo-sync keys: the view exposed them and the runtime
 * read the stored override, but no request could set it. This pins the schema
 * against the keys this general editor owns. Embedding and reranker selections
 * intentionally use `/api/models/selection`, where type checks and migration
 * approval cannot be bypassed.
 */
const { useCases } = vi.hoisted(() => ({
  useCases: { update: vi.fn(), getView: vi.fn() },
}));

vi.mock("@/lib/session", () => ({
  withAdminAuth:
    (handler: (user: unknown, ...args: any[]) => unknown) =>
    (...args: any[]) =>
      handler({ id: "u1", email: "admin@example.com", name: "A", image: null }, ...args),
}));
vi.mock("@/lib/container", () => ({ settingsUseCases: useCases }));
vi.mock("@/lib/runtime-settings", () => ({ invalidateSettingsCache: vi.fn() }));

const { PUT } = await import("@/app/api/settings/route");

const put = (body: unknown) =>
  PUT(
    new Request("https://studio.example.com/api/settings", {
      method: "PUT",
      body: JSON.stringify(body),
    }),
  );

beforeEach(() => {
  vi.clearAllMocks();
  useCases.update.mockResolvedValue({ fields: {} });
});

describe("PUT /api/settings", () => {
  it("forwards the plugins-repo keys to settingsUseCases.update", async () => {
    const body = {
      pluginsRepo: "org/plugins",
      pluginsRepoBranch: "release",
    };
    const res = await put(body);
    expect(res.status).toBe(200);
    expect(useCases.update).toHaveBeenCalledWith(body, "admin@example.com");
  });

  it("400s on a malformed body without reaching the use case", async () => {
    const res = await put({ pluginsRepo: 42 });
    expect(res.status).toBe(400);
    expect(useCases.update).not.toHaveBeenCalled();
  });

  it("forwards unknownModelPolicy, which the run bracket reads", async () => {
    // The same trap the repo keys fell into: the field exists on AppSettings and
    // the bracket reads it, so a schema that forgets it makes "refuse" an
    // unreachable setting — a 200 that changed nothing.
    const res = await put({ unknownModelPolicy: "refuse" });
    expect(res.status).toBe(200);
    expect(useCases.update).toHaveBeenCalledWith({ unknownModelPolicy: "refuse" }, "admin@example.com");
  });

  it("400s on an unknownModelPolicy outside the two values", async () => {
    // Stored as-is, a typo would read back as `allow` — silently leaving a
    // deployment that asked to refuse running unpriced models.
    const res = await put({ unknownModelPolicy: "refus" });
    expect(res.status).toBe(400);
    expect(useCases.update).not.toHaveBeenCalled();
  });

  it("forwards a valid artifact access mode and rejects unknown values", async () => {
    const res = await put({ artifactAccessMode: "public" });
    expect(res.status).toBe(200);
    expect(useCases.update).toHaveBeenCalledWith(
      { artifactAccessMode: "public" },
      "admin@example.com",
    );

    vi.clearAllMocks();
    const invalid = await put({ artifactAccessMode: "private" });
    expect(invalid.status).toBe(400);
    expect(useCases.update).not.toHaveBeenCalled();
  });

  it("rejects the removed hidden-model setting instead of silently accepting it", async () => {
    const res = await put({ hiddenModels: ["openai/gpt-5.4"] });
    expect(res.status).toBe(400);
    expect(useCases.update).not.toHaveBeenCalled();
  });

  it("rejects retired default LLM channel settings", async () => {
    const res = await put({ llmBaseUrl: "https://unused.example/v1", llmApiKey: "unused-key" });
    expect(res.status).toBe(400);
    expect(useCases.update).not.toHaveBeenCalled();
  });

  it("rejects direct model usage changes outside the selection use case", async () => {
    const res = await put({ embeddingModel: "local/embedding", rerankerModel: "local/reranker" });
    expect(res.status).toBe(400);
    expect(useCases.update).not.toHaveBeenCalled();
  });

  it("400s on a hiddenModels that is not a string array", async () => {
    const res = await put({ hiddenModels: "openai/gpt-5.4" });
    expect(res.status).toBe(400);
    expect(useCases.update).not.toHaveBeenCalled();
  });

  it("accepts an empty unknownModelPolicy, which is how the page clears an override", async () => {
    // The page submits every field on every save and tells the operator to clear
    // one to fall back to env. Refusing "" here made the only un-clearable field
    // 400 the whole form, taking every other edit with it.
    const body = { pluginsRepo: "org/plugins", unknownModelPolicy: "" };
    const res = await put(body);
    expect(res.status).toBe(200);
    expect(useCases.update).toHaveBeenCalledWith(body, "admin@example.com");
  });
});

import { describe, expect, it } from "vitest";
import {
  parseProviderConfigs,
  resolveProviderTarget,
} from "@/infrastructure/llm/providers";


describe("parseProviderConfigs", () => {
  it("parses provider channels from env pairs", () => {
    const configs = parseProviderConfigs({
      LLM_PROVIDER_OPENAI_BASE_URL: "https://api.openai.com/v1",
      LLM_PROVIDER_OPENAI_API_KEY: "sk-1",
      LLM_PROVIDER_GOOGLE_BASE_URL: "https://gemini.example/openai",
      LLM_PROVIDER_GOOGLE_API_KEY: "g-1",
      LLM_PROVIDER_GOOGLE_KEEP_MODEL_PREFIX: "true",
    });
    expect(configs).toHaveLength(2);
    expect(configs.find((c) => c.name === "openai")).toMatchObject({
      baseUrl: "https://api.openai.com/v1",
      apiKey: "sk-1",
      keepModelPrefix: false,
    });
    expect(configs.find((c) => c.name === "google")?.keepModelPrefix).toBe(true);
  });

  it("ignores providers missing an API key", () => {
    const configs = parseProviderConfigs({
      LLM_PROVIDER_OPENAI_BASE_URL: "https://api.openai.com/v1",
    });
    expect(configs).toHaveLength(0);
  });

  it("registers a sigv4 channel with no API key", () => {
    const configs = parseProviderConfigs({
      LLM_PROVIDER_BEDROCK_BASE_URL: "https://bedrock-mantle.us-east-1.api.aws/v1",
      LLM_PROVIDER_BEDROCK_AUTH: "sigv4",
    });
    expect(configs).toEqual([
      {
        name: "bedrock",
        baseUrl: "https://bedrock-mantle.us-east-1.api.aws/v1",
        apiKey: "",
        keepModelPrefix: false,
        auth: "sigv4",
      },
    ]);
  });

  /**
   * A typo in the auth value must not register an unsigned, unkeyed channel —
   * every request on it would 401 with nothing naming the misspelling.
   */
  it("treats an unrecognised auth value as bearer, so a keyless channel is skipped", () => {
    const configs = parseProviderConfigs({
      LLM_PROVIDER_BEDROCK_BASE_URL: "https://bedrock-mantle.us-east-1.api.aws/v1",
      LLM_PROVIDER_BEDROCK_AUTH: "sigv-4",
    });
    expect(configs).toHaveLength(0);
  });

  it("defaults a keyed channel to bearer", () => {
    const configs = parseProviderConfigs({
      LLM_PROVIDER_OPENAI_BASE_URL: "https://api.openai.com/v1",
      LLM_PROVIDER_OPENAI_API_KEY: "sk-1",
    });
    expect(configs[0]?.auth).toBe("bearer");
  });

  it("ignores unrelated env vars", () => {
    const configs = parseProviderConfigs({
      LLM_BASE_URL: "https://router.example/v1",
      LLM_API_KEY: "x",
      SOME_OTHER: "y",
    });
    expect(configs).toHaveLength(0);
  });
});

describe("resolveProviderTarget", () => {
  const providers = parseProviderConfigs({
    LLM_PROVIDER_OPENAI_BASE_URL: "https://api.openai.com/v1",
    LLM_PROVIDER_OPENAI_API_KEY: "sk-1",
    LLM_PROVIDER_GOOGLE_BASE_URL: "https://gemini.example/openai",
    LLM_PROVIDER_GOOGLE_API_KEY: "g-1",
    LLM_PROVIDER_GOOGLE_KEEP_MODEL_PREFIX: "true",
  });

  it("routes a registered provider and strips the prefix by default", () => {
    const target = resolveProviderTarget("openai/gpt-5-mini", providers);
    expect(target).toMatchObject({
      providerName: "openai",
      baseUrl: "https://api.openai.com/v1",
      model: "gpt-5-mini",
    });
  });

  it("keeps the prefix when configured", () => {
    const target = resolveProviderTarget(
      "google/gemini-3.1-flash-lite",
      providers,
    );
    expect(target.model).toBe("google/gemini-3.1-flash-lite");
    expect(target.providerName).toBe("google");
  });

  it("refuses an unregistered provider instead of falling back to an unrelated channel", () => {
    expect(() => resolveProviderTarget("anthropic/claude-sonnet-5", providers)).toThrow("Provider is not registered");
  });

  /**
   * A registry id and the provider's own name for the same model can differ:
   * `anthropic/claude-opus-4.8` is what the router and every stored version
   * hold, but Anthropic serves `claude-opus-4-8` and 404s on the dotted form.
   * Stripping the prefix alone would dispatch a name that does not exist.
   */
  it("sends the provider's own name for a model that has one", () => {
    const anthropic = parseProviderConfigs({
      LLM_PROVIDER_ANTHROPIC_BASE_URL: "https://api.anthropic.com/v1",
      LLM_PROVIDER_ANTHROPIC_API_KEY: "sk-ant",
    });
    const target = resolveProviderTarget("anthropic/claude-opus-4.8", anthropic);
    expect(target.providerName).toBe("anthropic");
    expect(target.model).toBe("claude-opus-4-8");
  });

  it("keeps the full id when the channel wants the prefix, wire id or not", () => {
    const anthropic = parseProviderConfigs({
      LLM_PROVIDER_ANTHROPIC_BASE_URL: "https://router.example/v1",
      LLM_PROVIDER_ANTHROPIC_API_KEY: "sk-ant",
      LLM_PROVIDER_ANTHROPIC_KEEP_MODEL_PREFIX: "true",
    });
    const target = resolveProviderTarget("anthropic/claude-opus-4.8", anthropic);
    expect(target.model).toBe("anthropic/claude-opus-4.8");
  });

  it("refuses models that an administrator has not selected", () => {
    expect(() => resolveProviderTarget("openai/unselected", providers)).toThrow("Model is not selected");
    expect(() => resolveProviderTarget("no-prefix", providers)).toThrow("Model is not selected");
  });
});

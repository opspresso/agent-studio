/**
 * Blank configuration values are unset. Environment reads, provider parsing
 * and stored override views share trimming and blank-value semantics.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { assertRequiredConfig, config } from "@/lib/config";
import { parseProviderConfigs } from "@/infrastructure/llm/providers";
import { createSettingsUseCases } from "@/application/settings/settingsUseCases";
import { secretCipher } from "@/infrastructure/crypto/secretCipher";
import type { SettingsRepository } from "@/domain/settings/repository";

beforeEach(() => {
  vi.stubEnv("AES_ENCRYPTION_KEY", Buffer.alloc(32, 5).toString("base64"));
});
afterEach(() => vi.unstubAllEnvs());

function set(name: string, value: string | undefined): void {
  vi.stubEnv(name, value);
}

// The two ways a blank value is written by hand and by a mounted file.
const BLANK = ["", " ", "\n", "  \t\n"];

describe("optional config", () => {
  it.each(BLANK)("reads %o as unset", (raw) => {
    set("GITHUB_TOKEN", raw);
    set("S3_BUCKET_NAME", raw);
    set("PLUGINS_REPO", raw);
    expect(config.githubToken).toBeUndefined();
    expect(config.objectBucketName).toBeUndefined();
    expect(config.pluginsRepo).toBeUndefined();
  });

  it.each(BLANK)("falls back to the built-in default on %o", (raw) => {
    set("PLUGINS_REPO_BRANCH", raw);
    set("GITHUB_API_URL", raw);
    expect(config.pluginsRepoBranch).toBe("main");
    expect(config.githubApiUrl).toBe("https://api.github.com");
  });

  it("trims the value it returns, not just the test", () => {
    // The token is compared against a header, which cannot carry the newline a
    // file-mounted Secret does.
    set("SCHEDULE_SCAN_TOKEN", " tok-1\n");
    set("PLUGINS_REPO", " opspresso/agent-plugins\n");
    expect(config.scheduleScanToken).toBe("tok-1");
    expect(config.pluginsRepo).toBe("opspresso/agent-plugins");
  });

  it("derives the browser-facing GitHub base only from known API layouts", () => {
    set("GITHUB_WEB_URL", undefined);
    set("GITHUB_API_URL", undefined);
    expect(config.githubWebUrl).toBe("https://github.com");

    set("GITHUB_API_URL", "https://github.example.com/api/v3/");
    expect(config.githubWebUrl).toBe("https://github.example.com");

    set("GITHUB_API_URL", "https://proxy.example.com/github-api");
    expect(config.githubWebUrl).toBeUndefined();

    set("GITHUB_WEB_URL", "https://code.example.com/github/");
    expect(config.githubWebUrl).toBe("https://code.example.com/github");
  });

  it("skips to the next candidate rather than stopping at a blank one", () => {
    set("PUBLIC_BASE_URL", " ");
    set("BETTER_AUTH_URL", "https://studio.example");
    expect(config.publicBaseUrl).toBe("https://studio.example");
  });
});

describe("required config", () => {
  it.each(BLANK)("reports %o as missing at boot", (raw) => {
    set("DATABASE_URL", "postgres://unit:unit@localhost:5432/unit");
    set("AES_ENCRYPTION_KEY", Buffer.alloc(32, 5).toString("base64"));
    set("AES_ENCRYPTION_KEY", raw);
    expect(() => assertRequiredConfig()).toThrow(
      "Missing required environment variables: AES_ENCRYPTION_KEY",
    );
  });

  it("rejects a present but weak AES key at boot", () => {
    set("DATABASE_URL", "postgres://unit:unit@localhost:5432/unit");
    set("AES_ENCRYPTION_KEY", "AA==");

    expect(() => assertRequiredConfig()).toThrow(
      "AES_ENCRYPTION_KEY must be 32 bytes in canonical base64",
    );
  });
});

describe("parseProviderConfigs", () => {
  it("ignores a provider whose base URL or key is blank", () => {
    expect(
      parseProviderConfigs({
        LLM_PROVIDER_OPENAI_BASE_URL: " ",
        LLM_PROVIDER_OPENAI_API_KEY: "sk-1",
        LLM_PROVIDER_GOOGLE_BASE_URL: "https://gemini.example/openai",
        LLM_PROVIDER_GOOGLE_API_KEY: "\n",
      }),
    ).toEqual([]);
  });

  it("trims what it keeps, including the prefix flag", () => {
    // `"true\n" === "true"` is false, which would read as an operator asking
    // for the prefix to be stripped — the opposite of what they configured.
    expect(
      parseProviderConfigs({
        LLM_PROVIDER_OPENAI_BASE_URL: " https://api.openai.com/v1\n",
        LLM_PROVIDER_OPENAI_API_KEY: "sk-1\n",
        LLM_PROVIDER_OPENAI_KEEP_MODEL_PREFIX: "true\n",
      }),
    ).toEqual([
      {
        name: "openai",
        baseUrl: "https://api.openai.com/v1",
        apiKey: "sk-1",
        keepModelPrefix: true,
        auth: "bearer",
      },
    ]);
  });
});

describe("the settings view", () => {
  const emptyRepo: SettingsRepository = {
    async get() {
      return null;
    },
    async update(mutate) {
      const after = mutate(null);
      return { before: null, after };
    },
  };

  // The env is injected, so these read nothing the process happens to carry.
  const viewOf = (vars: Record<string, string>) =>
    createSettingsUseCases(
      emptyRepo,
      secretCipher,
      { NODE_ENV: "test", ...vars },
      parseProviderConfigs,
      ["agent-studio", "agentops"],
    ).getView();

  it("does not report a blank variable as the effective value", async () => {
    const view = await viewOf({ GITHUB_TOKEN: " ", PLUGINS_REPO: "\n" });
    expect(view.fields.githubToken).toMatchObject({ source: "unset", value: "" });
    expect(view.fields.pluginsRepo).toMatchObject({ source: "unset", value: "" });
  });

  it("still shows the built-in default behind a blank variable", async () => {
    const view = await viewOf({ PLUGINS_REPO_BRANCH: "  " });
    expect(view.fields.pluginsRepoBranch).toMatchObject({ source: "default", value: "main" });
  });

  it("answers the blank question the same way an override does", async () => {
    // `update` clears an override on a blank value; the environment now agrees,
    // so the page cannot say "env" for something no run would use.
    const blank = await viewOf({ PUBLIC_BASE_URL: " " });
    const unset = await viewOf({});
    expect(blank.fields.publicBaseUrl).toEqual(unset.fields.publicBaseUrl);
  });

  it("reports the trimmed value when the variable does carry one", async () => {
    const view = await viewOf({ PLUGINS_REPO: " opspresso/agent-plugins\n" });
    expect(view.fields.pluginsRepo).toMatchObject({
      source: "env",
      value: "opspresso/agent-plugins",
    });
  });
});

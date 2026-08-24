process.env.AES_ENCRYPTION_KEY ??= Buffer.alloc(32, 5).toString("base64");

/**
 * Blank is unset, at every point a value is configured.
 *
 * `|| undefined` was the shape every optional env read took, so the empty string
 * already meant "not set" — and whitespace, which carries the same intent, did
 * not. A secret mounted from a file arrives with a trailing newline; one typed
 * with a stray space arrives with that. Both used to survive as values:
 * `A2A_API_KEY=" "` passed the boot guard, read as `source: "env"` on the
 * settings page, and then 401'd every request that presented it.
 *
 * The asymmetry that made it worst lived inside the settings page, which asks
 * the blank question twice: an override is stored trimmed (`update` does it),
 * the environment was not. So the same value cleared the field on one side and
 * counted as configured on the other.
 */

import { afterEach, describe, expect, it } from "vitest";
import { assertRequiredConfig, config } from "@/lib/config";
import { parseProviderConfigs } from "@/infrastructure/llm/providers";
import { createSettingsUseCases } from "@/application/settings/settingsUseCases";
import { secretCipher } from "@/infrastructure/crypto/secretCipher";
import type { SettingsRepository } from "@/domain/settings/repository";

const TOUCHED = [
  "A2A_API_KEY",
  "GITHUB_TOKEN",
  "PLUGINS_REPO",
  "PLUGINS_REPO_BRANCH",
  "S3_BUCKET_NAME",
  "SCHEDULE_SCAN_TOKEN",
  "PUBLIC_BASE_URL",
  "BETTER_AUTH_URL",
  "MANAGED_MCP_NETWORK_CONTAINER",
  "LLM_BASE_URL",
  "LLM_API_KEY",
  "AES_ENCRYPTION_KEY",
] as const;
const ORIGINAL = Object.fromEntries(TOUCHED.map((key) => [key, process.env[key]]));

function set(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}

afterEach(() => {
  for (const key of TOUCHED) {
    set(key, ORIGINAL[key]);
  }
});

// The two ways a blank value is written by hand and by a mounted file.
const BLANK = ["", " ", "\n", "  \t\n"];

describe("optional config", () => {
  it.each(BLANK)("reads %o as unset", (raw) => {
    set("A2A_API_KEY", raw);
    set("S3_BUCKET_NAME", raw);
    set("PLUGINS_REPO", raw);
    expect(config.a2aApiKey).toBeUndefined();
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

  it("skips to the next candidate rather than stopping at a blank one", () => {
    set("PUBLIC_BASE_URL", " ");
    set("BETTER_AUTH_URL", "https://studio.example");
    expect(config.publicBaseUrl).toBe("https://studio.example");
  });
});

describe("required config", () => {
  it.each(BLANK)("refuses %o", (raw) => {
    set("LLM_API_KEY", raw);
    expect(() => config.llmApiKey).toThrow("LLM_API_KEY not configured");
  });

  it.each(BLANK)("reports %o as missing at boot", (raw) => {
    set("DATABASE_URL", "postgres://unit:unit@localhost:5432/unit");
    set("LLM_BASE_URL", "https://router.example/v1");
    set("AES_ENCRYPTION_KEY", Buffer.alloc(32, 5).toString("base64"));
    set("LLM_API_KEY", raw);
    expect(() => assertRequiredConfig()).toThrow(
      "Missing required environment variables: LLM_API_KEY",
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
    async put() {},
  };

  // The env is injected, so these read nothing the process happens to carry.
  const viewOf = (vars: Record<string, string>) =>
    createSettingsUseCases(
      emptyRepo,
      secretCipher,
      { NODE_ENV: "test", ...vars },
      parseProviderConfigs,
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

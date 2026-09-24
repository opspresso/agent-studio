import { describe, expect, it } from "vitest";
import type { SettingKey, SettingsView } from "@/application/settings/settingsUseCases";
import { SETTINGS_FIELDS, settingsPatch } from "@/app/settings/fields";

const current = {
  publicBaseUrl: "https://studio.example.test", artifactAccessMode: "proxied", unknownModelPolicy: "allow",
  adminEmails: "admin@example.test", allowedEmailDomains: "example.test",
  pluginsRepo: "org/plugins", pluginsRepoBranch: "main",
  githubToken: "****************",
};
const view: SettingsView = {
  fields: Object.fromEntries(Object.values(SETTINGS_FIELDS).flat().map(({ key, type }) => [key,
    { value: current[key as keyof typeof current], secret: type === "secret", source: "override" },
  ])) as SettingsView["fields"],
  llmProviders: { source: "override", items: [] },
};

describe("settings tab updates", () => {
  it("does not write unchanged values or masked credentials", () => {
    for (const section of ["service", "access", "plugins"] as const) expect(settingsPatch(section, current, view)).toEqual({});
  });
  it("saves only changed fields owned by the active tab", () => {
    const edits = { ...current, publicBaseUrl: "https://new.example.test", pluginsRepoBranch: "release", githubToken: "replacement-token" };
    expect(settingsPatch("service", edits, view)).toEqual({ publicBaseUrl: "https://new.example.test" });
    expect(settingsPatch("access", edits, view)).toEqual({});
    expect(settingsPatch("plugins", edits, view)).toEqual({ pluginsRepoBranch: "release", githubToken: "replacement-token" });
  });
  it("preserves an intentional clear without resubmitting unrelated secrets", () => {
    expect(settingsPatch("plugins", { ...current, githubToken: "" }, view)).toEqual({ githubToken: "" });
  });
  it("saves the unpriced-model policy from General without touching model selections", () => {
    expect(settingsPatch("service", { ...current, unknownModelPolicy: "refuse" }, view)).toEqual({ unknownModelPolicy: "refuse" });
    expect(settingsPatch("plugins", { ...current, unknownModelPolicy: "refuse" }, view)).toEqual({});
  });
  it("never clears fields missing from a partial draft", () => {
    const values: Partial<Record<SettingKey, string>> = { pluginsRepo: "org/new" };
    expect(settingsPatch("plugins", values, view)).toEqual({ pluginsRepo: "org/new" });
  });
});

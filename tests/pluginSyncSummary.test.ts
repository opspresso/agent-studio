import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MantineProvider } from "@mantine/core";
import { describe, expect, it, vi } from "vitest";
import { PluginSyncSummary } from "@/app/_components/PluginSyncSummary";
import { useT } from "@/app/_i18n/provider";
import { translator } from "@/app/_i18n/translate";
import type { PluginKindReport, PluginSyncResult } from "@/domain/plugin/sync";

vi.mock("@/app/_i18n/provider", () => ({ useT: vi.fn() }));

const empty = (): PluginKindReport => ({ created: [], overwritten: [], unchanged: [], orphaned: [], removed: [], skipped: [] });

describe("Plugin deletion review", () => {
  it.each(["en", "ko"] as const)("distinguishes unknown bindings from unbound entries in %s", locale => {
    const t = translator(locale);
    vi.mocked(useT).mockReturnValue(t);
    const result: PluginSyncResult = {
      repo: "org/plugins", commitSha: "fixture", skipped: [], orphanedPlugins: [], removedPlugins: [],
      plugins: [{ plugin: "example", skills: { ...empty(), orphaned: [
        { name: "unknown", boundTo: null }, { name: "unbound", boundTo: [] },
        { name: "used", boundTo: ["assistant"] },
      ] }, mcpServers: empty() }],
    };
    const markup = renderToStaticMarkup(createElement(MantineProvider, {
      children: createElement(PluginSyncSummary, { result, onApply: async () => {}, busy: false }),
    }));
    expect(markup).toContain(`unknown — ${t("plugins.bindingsUnavailable")}`);
    expect(markup).not.toContain(`unbound — ${t("plugins.bindingsUnavailable")}`);
    expect(markup).toContain("used — bound by assistant");
    expect(markup.match(/type="checkbox"/g)).toHaveLength(3);
  });
});

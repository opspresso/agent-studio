import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MantineProvider } from "@mantine/core";
import { describe, expect, it, vi } from "vitest";
import { UsageBreakdown } from "@/app/_components/UsageBreakdown";
import { translator } from "@/app/_i18n/translate";
import { useLocale, useT } from "@/app/_i18n/provider";

vi.mock("@/app/_i18n/provider", () => ({ useT: vi.fn(), useLocale: vi.fn() }));

describe("usage display", () => {
  it.each(["en", "ko"] as const)("distinguishes a failed read from zero usage in %s", (locale) => {
    const t = translator(locale);
    vi.mocked(useT).mockReturnValue(t);
    vi.mocked(useLocale).mockReturnValue(locale);

    const html = renderToStaticMarkup(createElement(MantineProvider, {
      children: createElement(UsageBreakdown, { groups: [], label: "model", failed: true }),
    }));

    expect(html).toContain(t("usage.loadFailed"));
    expect(html).not.toContain(t("usage.none"));
  });
});

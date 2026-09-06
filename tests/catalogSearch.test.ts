import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MantineProvider } from "@mantine/core";
import { describe, expect, it, vi } from "vitest";
import { CatalogSearch, matchesFilter } from "@/app/_components/CatalogSearch";
import { CardGrid } from "@/app/_components/CardGrid";
import { translator } from "@/app/_i18n/translate";
import { useT } from "@/app/_i18n/provider";

vi.mock("@/app/_i18n/provider", () => ({ useT: vi.fn() }));

function render(children: React.ReactNode) {
  return renderToStaticMarkup(createElement(MantineProvider, { children }));
}

describe("catalog search", () => {
  it("matches visible fields regardless of case and surrounding whitespace", () => {
    expect(matchesFilter("  assistant  ", "demo", "Team Assistant", undefined)).toBe(true);
    expect(matchesFilter("없는 검색어", "지원 도우미", "Support assistant")).toBe(false);
    expect(matchesFilter("  ", undefined)).toBe(true);
  });

  it.each(["en", "ko"] as const)("announces zero results and offers named recovery controls in %s", (locale) => {
    const t = translator(locale);
    vi.mocked(useT).mockReturnValue(t);
    const html = render(createElement(CatalogSearch, {
      value: "missing",
      onChange: vi.fn(),
      placeholder: "Search projects",
      resultCount: 0,
      totalCount: 12,
      onReset: vi.fn(),
    }));
    expect(html).toContain('role="status"');
    expect(html).toContain(t("catalog.resultCount", { count: 0, total: 12 }));
    expect(html).toContain(`aria-label="${t("catalog.clearSearch")}"`);
    expect(html).toContain(t("catalog.resetFilters"));
  });

  it("shows the no-match explanation instead of cards when a filter excludes all items", () => {
    const t = translator("en");
    vi.mocked(useT).mockReturnValue(t);
    const items = [{ name: "Support" }, { name: "Research" }];
    const visible = items.filter((item) => matchesFilter("missing", item.name));
    const html = render(createElement(CardGrid, {
      loading: false,
      empty: visible.length === 0,
      emptyText: t(items.length === 0 ? "projects.empty" : "catalog.noResults"),
      children: visible.map((item) => createElement("article", { key: item.name }, item.name)),
    }));
    expect(html).toContain(t("catalog.noResults"));
    expect(html).not.toContain(t("projects.empty"));
    expect(html).not.toContain("<article");
  });
});

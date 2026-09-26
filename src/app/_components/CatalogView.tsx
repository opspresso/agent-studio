"use client";

import { SegmentedControl } from "@mantine/core";
import { useLocalStorage } from "@mantine/hooks";
import { useT } from "@/app/_i18n/provider";

export type CatalogView = "list" | "grid";

/** One browser preference for the catalog surfaces, independent of their filters. */
export function useCatalogView() {
  return useLocalStorage<CatalogView>({
    key: "agent-studio-catalog-view",
    defaultValue: "list",
    deserialize: value => value === '"grid"' ? "grid" : "list",
    sync: false,
  });
}

export function CatalogViewToggle({ value, onChange }: {
  value: CatalogView;
  onChange: (value: CatalogView) => void;
}) {
  const t = useT();
  return <SegmentedControl aria-label={t("catalog.view")}
    value={value} onChange={next => onChange(next === "grid" ? "grid" : "list")}
    data={[{ value: "list", label: t("catalog.view.list") }, { value: "grid", label: t("catalog.view.grid") }]} />;
}

"use client";

import { Center, SegmentedControl, Tooltip, VisuallyHidden } from "@mantine/core";
import { IconLayoutGrid, IconList } from "@tabler/icons-react";
import { useSyncExternalStore } from "react";
import { useT } from "@/app/_i18n/provider";
import { reportError } from "@/app/_lib/reportError";

export type CatalogView = "list" | "grid";
const STORAGE_KEY = "agent-studio-catalog-view";
const listeners = new Set<() => void>();
let snapshot: CatalogView | undefined;
const deserialize = (value: string | null): CatalogView => value === '"grid"' ? "grid" : "list";

function getSnapshot(): CatalogView {
  if (snapshot === undefined) {
    try { snapshot = deserialize(window.localStorage.getItem(STORAGE_KEY)); }
    catch (error) {
      snapshot = "list";
      queueMicrotask(() => reportError(error, "Catalog view storage is unavailable"));
    }
  }
  return snapshot;
}

function notify() { listeners.forEach(listener => listener()); }

function onStorage(event: StorageEvent) {
  if (event.storageArea !== window.localStorage) return;
  if (event.key === STORAGE_KEY || event.key === null) {
    snapshot = deserialize(event.newValue);
    notify();
  }
}

function subscribe(listener: () => void) {
  if (listeners.size === 0) window.addEventListener("storage", onStorage);
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      window.removeEventListener("storage", onStorage);
      snapshot = undefined;
    }
  };
}

function setCatalogView(view: CatalogView) {
  snapshot = view;
  try { window.localStorage.setItem(STORAGE_KEY, JSON.stringify(view)); }
  catch (error) { reportError(error, "Catalog view could not be persisted"); }
  notify();
}

const getServerSnapshot = (): CatalogView => "list";

/** One browser preference for the catalog surfaces, independent of their filters. */
export function useCatalogView() {
  const view = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  return [view, setCatalogView] as const;
}

export function CatalogViewToggle({ value, onChange }: {
  value: CatalogView;
  onChange: (value: CatalogView) => void;
}) {
  const t = useT();
  return <SegmentedControl aria-label={t("catalog.view")}
    value={value} onChange={next => onChange(next === "grid" ? "grid" : "list")}
    data={[
      { value: "list", label: <Tooltip label={t("catalog.view.list")}>
        <Center w={28} h={24}>
          <IconList size={18} aria-hidden="true" />
          <VisuallyHidden>{t("catalog.view.list")}</VisuallyHidden>
        </Center>
      </Tooltip> },
      { value: "grid", label: <Tooltip label={t("catalog.view.grid")}>
        <Center w={28} h={24}>
          <IconLayoutGrid size={18} aria-hidden="true" />
          <VisuallyHidden>{t("catalog.view.grid")}</VisuallyHidden>
        </Center>
      </Tooltip> },
    ]} />;
}

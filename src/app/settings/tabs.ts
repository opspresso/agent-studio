export const SETTINGS_TABS = ["general", "plugins", "models", "keys"] as const;
export type SettingsTab = (typeof SETTINGS_TABS)[number];
export const SETTINGS_TAB_PATHS: Record<SettingsTab, string> = {
  general: "/settings", plugins: "/settings/plugins", models: "/settings/models", keys: "/settings/keys",
};

export function settingsTabFor(pathname: string): SettingsTab {
  if (pathname === "/settings/plugins") return "plugins";
  if (pathname === "/settings/keys") return "keys";
  if (pathname === "/settings/models" || pathname.startsWith("/settings/models/") || pathname === "/settings/providers" || pathname === "/settings/model-usage") return "models";
  return "general";
}

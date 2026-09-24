export const SETTINGS_TABS = ["service", "access", "plugins", "models"] as const;
export type SettingsTab = (typeof SETTINGS_TABS)[number];
export const SETTINGS_TAB_PATHS: Record<SettingsTab, string> = {
  service: "/settings", access: "/settings/access", plugins: "/settings/plugins", models: "/settings/models",
};

export function settingsTabFor(pathname: string): SettingsTab {
  if (pathname === "/settings/plugins") return "plugins";
  if (pathname === "/settings/access") return "access";
  if (pathname === "/settings/models" || pathname.startsWith("/settings/models/") || pathname === "/settings/providers" || pathname === "/settings/model-usage") return "models";
  return "service";
}

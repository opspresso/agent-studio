export const SETTINGS_TABS = ["service", "access", "plugins", "models"] as const;
export type SettingsTab = (typeof SETTINGS_TABS)[number];
export const SETTINGS_TAB_PATHS: Record<SettingsTab, string> = {
  service: "/settings", access: "/settings/access", plugins: "/settings/plugins", models: "/settings/models",
};
export const SETTINGS_SECTION_TABS = {
  models: [
    ["/settings/models", "modelAdmin.selection"],
    ["/settings/model-usage", "modelAdmin.usage"],
    ["/settings/providers", "modelAdmin.providers"],
  ],
  plugins: [
    ["/settings/plugins", "settings.plugins.usage"],
    ["/settings/plugins/sync", "settings.plugins.sync"],
  ],
} as const;

export function settingsTabFor(pathname: string): SettingsTab {
  if (pathname === "/settings/plugins" || pathname.startsWith("/settings/plugins/")) return "plugins";
  if (pathname === "/settings/access") return "access";
  if (pathname === "/settings/models" || pathname.startsWith("/settings/models/") || pathname === "/settings/providers" || pathname === "/settings/model-usage") return "models";
  return "service";
}

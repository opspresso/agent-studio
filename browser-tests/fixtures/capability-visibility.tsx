import { createRoot } from "react-dom/client";
import { MantineProvider } from "@mantine/core";
import "@mantine/core/styles.css";
import { theme } from "../../src/app/theme";
import { I18nProvider } from "../../src/app/_i18n/provider";
import { CapabilityVisibilitySettings } from "../../src/app/settings/plugins/CapabilityVisibilitySettings";
import { SettingsShell } from "../../src/app/settings/SettingsShell";
import { ViewerProvider } from "../../src/app/_lib/useViewer";
import PluginSyncSettingsPage from "../../src/app/settings/plugins/sync/page";

createRoot(document.getElementById("root")!).render(<MantineProvider theme={theme}>
  <I18nProvider locale={location.pathname === "/ko" ? "ko" : "en"}>
    <ViewerProvider viewer={{ email: "admin@example.test", isAdmin: true, tier: "admin" }}>
      <div style={{ padding: 24 }}>{location.pathname.startsWith("/settings/")
        ? <SettingsShell>{location.pathname.endsWith("/sync") ? <PluginSyncSettingsPage /> : <CapabilityVisibilitySettings />}</SettingsShell> : <CapabilityVisibilitySettings />}</div>
    </ViewerProvider>
  </I18nProvider>
</MantineProvider>);

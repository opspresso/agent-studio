import { createRoot } from "react-dom/client";
import { ConsoleThemeProvider } from "../../src/app/_components/ConsoleThemeProvider";
import "@mantine/core/styles.css";
import { I18nProvider } from "../../src/app/_i18n/provider";
import { ViewerProvider } from "../../src/app/_lib/useViewer";
import PluginsPage from "../../src/app/plugins/page";

createRoot(document.getElementById("root")!).render(<I18nProvider locale={new URLSearchParams(location.search).get("locale") === "ko" ? "ko" : "en"}><ConsoleThemeProvider>
  <ViewerProvider viewer={{ email: "admin@example.test", isAdmin: true, tier: "admin" }}>
    <div style={{ padding: 24 }}><PluginsPage /></div>
  </ViewerProvider>
</ConsoleThemeProvider></I18nProvider>);

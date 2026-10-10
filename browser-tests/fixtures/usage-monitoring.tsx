import { createRoot } from "react-dom/client";
import "@mantine/core/styles.css";
import "@mantine/charts/styles.css";
import "../../src/app/globals.css";
import { ConsoleThemeProvider } from "../../src/app/_components/ConsoleThemeProvider";
import { I18nProvider } from "../../src/app/_i18n/provider";
import { ViewerProvider } from "../../src/app/_lib/useViewer";
import { UsageExplorer } from "../../src/app/_components/UsageExplorer";

document.documentElement.style.setProperty("--font-sans", "system-ui");
document.documentElement.style.setProperty("--font-mono", "monospace");
const params = new URLSearchParams(location.search);
const admin = params.has("admin");
const restricted = params.has("restricted");
createRoot(document.getElementById("root")!).render(
  <I18nProvider locale={params.has("ko") ? "ko" : "en"}><ConsoleThemeProvider>
    <ViewerProvider viewer={params.has("viewerLoading") ? null : { email: "viewer@example.test", tier: restricted ? "member" : "admin", isAdmin: !restricted }}>
      <div style={{ padding: 20, maxWidth: 1400, margin: "auto" }}>
        <UsageExplorer admin={admin} />
      </div>
    </ViewerProvider>
  </ConsoleThemeProvider></I18nProvider>,
);

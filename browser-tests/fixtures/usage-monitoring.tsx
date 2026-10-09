import { createRoot } from "react-dom/client";
import { MantineProvider } from "@mantine/core";
import "@mantine/core/styles.css";
import "@mantine/charts/styles.css";
import "../../src/app/globals.css";
import { theme } from "../../src/app/theme";
import { I18nProvider } from "../../src/app/_i18n/provider";
import { ViewerProvider } from "../../src/app/_lib/useViewer";
import { UsageExplorer } from "../../src/app/_components/UsageExplorer";
import { AdminUsage } from "../../src/app/usage/AdminUsage";

document.documentElement.style.setProperty("--font-sans", "system-ui");
document.documentElement.style.setProperty("--font-mono", "monospace");
const params = new URLSearchParams(location.search);
const admin = params.has("admin");
const restricted = params.has("restricted");
createRoot(document.getElementById("root")!).render(
  <MantineProvider theme={theme}><I18nProvider locale={params.has("ko") ? "ko" : "en"}>
    <ViewerProvider viewer={{ email: "viewer@example.test", tier: restricted ? "member" : "admin", isAdmin: !restricted }}>
      <div style={{ padding: 20, maxWidth: 1400, margin: "auto" }}>
        {admin ? <AdminUsage initialUser={params.get("user") ?? undefined} /> : <UsageExplorer initialModel={params.get("model") ?? undefined} />}
      </div>
    </ViewerProvider>
  </I18nProvider></MantineProvider>,
);

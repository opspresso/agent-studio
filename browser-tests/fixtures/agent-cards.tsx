import { createRoot } from "react-dom/client";
import { MantineProvider } from "@mantine/core";
import "@mantine/core/styles.css";
import { theme } from "../../src/app/theme";
import { I18nProvider } from "../../src/app/_i18n/provider";
import { ViewerProvider } from "../../src/app/_lib/useViewer";
import AgentsPage from "../../src/app/agents/page";

createRoot(document.getElementById("root")!).render(
  <MantineProvider theme={theme}><I18nProvider locale="en">
    <ViewerProvider viewer={{ email: "owner@example.test", isAdmin: false, isConfiguredAdmin: false, tier: "member" }}>
      <div style={{ padding: 24 }}><AgentsPage /></div>
    </ViewerProvider>
  </I18nProvider></MantineProvider>,
);

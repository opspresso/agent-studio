import { createRoot } from "react-dom/client";
import { MantineProvider } from "@mantine/core";
import "@mantine/core/styles.css";
import { theme } from "../../src/app/theme";
import { I18nProvider } from "../../src/app/_i18n/provider";
import { ViewerProvider } from "../../src/app/_lib/useViewer";
import UsagePage from "../../src/app/agents/[name]/usage/page";

createRoot(document.getElementById("root")!).render(
  <MantineProvider theme={theme}><I18nProvider locale="en">
    <ViewerProvider viewer={{ email: "owner@example.test", tier: "member", isAdmin: false, isConfiguredAdmin: false }}>
      <UsagePage />
    </ViewerProvider>
  </I18nProvider></MantineProvider>,
);

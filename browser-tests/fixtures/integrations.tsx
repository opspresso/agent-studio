import { createRoot } from "react-dom/client";
import { MantineProvider } from "@mantine/core";
import "@mantine/core/styles.css";
import { theme } from "../../src/app/theme";
import { I18nProvider } from "../../src/app/_i18n/provider";
import { ViewerProvider } from "../../src/app/_lib/useViewer";
import IntegrationsPage from "../../src/app/agents/[name]/integrations/page";

createRoot(document.getElementById("root")!).render(
  <MantineProvider theme={theme}><I18nProvider locale="en"><ViewerProvider viewer={{
    email: "admin@example.test", tier: "admin", isAdmin: true, isConfiguredAdmin: true,
  }}><div style={{ padding: 24 }}><IntegrationsPage /></div></ViewerProvider></I18nProvider></MantineProvider>,
);

import { createRoot } from "react-dom/client";
import { MantineProvider } from "@mantine/core";
import "@mantine/core/styles.css";
import { theme } from "../../src/app/theme";
import { I18nProvider } from "../../src/app/_i18n/provider";
import ModelSelectionPage from "../../src/app/settings/models/page";
import ModelsPage from "../../src/app/models/page";
import RegisteredModelsPage from "../../src/app/settings/models/registered/page";
import { ViewerProvider } from "../../src/app/_lib/useViewer";

createRoot(document.getElementById("root")!).render(<MantineProvider theme={theme}><I18nProvider locale="en">
  <ViewerProvider viewer={{ email: "admin@example.test", isAdmin: true, isConfiguredAdmin: true, tier: "admin" }}>
    <div style={{ padding: 24 }}>{location.pathname === "/selected" ? <ModelsPage /> : location.pathname === "/registered" ? <RegisteredModelsPage /> : <ModelSelectionPage />}</div>
  </ViewerProvider>
</I18nProvider></MantineProvider>);

import { createRoot } from "react-dom/client";
import { MantineProvider } from "@mantine/core";
import "@mantine/core/styles.css";
import { theme } from "../../src/app/theme";
import { I18nProvider } from "../../src/app/_i18n/provider";
import ModelSelectionPage from "../../src/app/settings/models/page";
import ModelsPage from "../../src/app/models/page";

createRoot(document.getElementById("root")!).render(<MantineProvider theme={theme}><I18nProvider locale="en">
  <div style={{ padding: 24 }}>{location.pathname === "/selected" ? <ModelsPage /> : <ModelSelectionPage />}</div>
</I18nProvider></MantineProvider>);

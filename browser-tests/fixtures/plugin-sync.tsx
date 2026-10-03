import { createRoot } from "react-dom/client";
import { MantineProvider } from "@mantine/core";
import "@mantine/core/styles.css";
import { theme } from "../../src/app/theme";
import { I18nProvider } from "../../src/app/_i18n/provider";
import { ViewerProvider } from "../../src/app/_lib/useViewer";
import PluginsPage from "../../src/app/plugins/page";

createRoot(document.getElementById("root")!).render(<MantineProvider theme={theme}>
  <I18nProvider locale="en"><ViewerProvider viewer={{ email: "admin@example.test", isAdmin: true, tier: "admin" }}>
    <div style={{ padding: 24 }}><PluginsPage /></div>
  </ViewerProvider></I18nProvider>
</MantineProvider>);

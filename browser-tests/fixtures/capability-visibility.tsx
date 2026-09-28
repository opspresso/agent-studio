import { createRoot } from "react-dom/client";
import { MantineProvider } from "@mantine/core";
import "@mantine/core/styles.css";
import { theme } from "../../src/app/theme";
import { I18nProvider } from "../../src/app/_i18n/provider";
import { CapabilityVisibilitySettings } from "../../src/app/settings/plugins/CapabilityVisibilitySettings";

createRoot(document.getElementById("root")!).render(<MantineProvider theme={theme}>
  <I18nProvider locale={location.pathname === "/ko" ? "ko" : "en"}>
    <div style={{ padding: 24 }}><CapabilityVisibilitySettings /></div>
  </I18nProvider>
</MantineProvider>);

import { createRoot } from "react-dom/client";
import { MantineProvider } from "@mantine/core";
import "@mantine/core/styles.css";
import { I18nProvider } from "../../src/app/_i18n/provider";
import { ViewerProvider } from "../../src/app/_lib/useViewer";
import MessagingConnections from "../../src/app/profile/messaging/page";
import { theme } from "../../src/app/theme";

const guest = new URLSearchParams(window.location.search).has("guest");
createRoot(document.getElementById("root")!).render(
  <MantineProvider theme={theme}><I18nProvider locale="en">
    <ViewerProvider viewer={{ email: "member@example.test", tier: guest ? "guest" : "member", isAdmin: false, isConfiguredAdmin: false }}>
      <MessagingConnections />
    </ViewerProvider>
  </I18nProvider></MantineProvider>,
);

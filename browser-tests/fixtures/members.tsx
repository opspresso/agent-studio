import { createRoot } from "react-dom/client";
import { MantineProvider } from "@mantine/core";
import { Notifications } from "@mantine/notifications";
import "@mantine/core/styles.css";
import "@mantine/notifications/styles.css";
import { theme } from "../../src/app/theme";
import { I18nProvider } from "../../src/app/_i18n/provider";
import { ViewerProvider } from "../../src/app/_lib/useViewer";
import MembersPage from "../../src/app/members/page";

createRoot(document.getElementById("root")!).render(
  <MantineProvider theme={theme}><I18nProvider locale="en"><ViewerProvider viewer={{
    email: "admin@example.test", tier: "admin", isAdmin: true,
  }}><Notifications /><div style={{ padding: 24 }}><MembersPage /></div></ViewerProvider></I18nProvider></MantineProvider>,
);

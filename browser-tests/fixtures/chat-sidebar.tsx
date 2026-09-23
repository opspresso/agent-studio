import { createRoot } from "react-dom/client";
import { MantineProvider } from "@mantine/core";
import "@mantine/core/styles.css";
import { theme } from "../../src/app/theme";
import { I18nProvider } from "../../src/app/_i18n/provider";
import { ChatSidebar } from "../../src/app/chats/_components/ChatSidebar";

createRoot(document.getElementById("root")!).render(
  <MantineProvider theme={theme}>
    <I18nProvider locale="en">
      <div style={{ display: "flex", height: "100vh", padding: 24 }}><ChatSidebar /></div>
    </I18nProvider>
  </MantineProvider>,
);

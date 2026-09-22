import { createRoot } from "react-dom/client";
import { MantineProvider } from "@mantine/core";
import "@mantine/core/styles.css";
import { theme } from "../../src/app/theme";
import { I18nProvider } from "../../src/app/_i18n/provider";
import { ChatThread } from "../../src/app/chats/_components/ChatThread";

createRoot(document.getElementById("root")!).render(
  <MantineProvider theme={theme}>
    <I18nProvider locale="en">
      <div style={{ height: "100vh", padding: 24 }}><ChatThread chatId="chat-1" /></div>
    </I18nProvider>
  </MantineProvider>,
);

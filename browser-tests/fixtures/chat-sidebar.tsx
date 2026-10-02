import { createRoot } from "react-dom/client";
import { MantineProvider } from "@mantine/core";
import "@mantine/core/styles.css";
import { theme } from "../../src/app/theme";
import { I18nProvider } from "../../src/app/_i18n/provider";
import { ChatSidebar } from "../../src/app/chats/_components/ChatSidebar";
import { ChatRouteProvider, ChatRouteSelection } from "../../src/app/chats/_components/ChatRouteSelection";
import { NewChatPanel } from "../../src/app/chats/_components/NewChatPanel";
import { ViewerProvider } from "../../src/app/_lib/useViewer";
import { ImageViewerProvider } from "../../src/app/_components/ImageViewer";

const chatId = window.location.pathname.split("/")[2];

createRoot(document.getElementById("root")!).render(
  <MantineProvider theme={theme}>
    <I18nProvider locale="en">
      <ChatRouteProvider>
        {chatId && <ChatRouteSelection chatId={chatId} tab={["chat-2", "ws-outside-page"].includes(chatId) ? "workspaces" : "chats"} />}
        <ViewerProvider viewer={{ email: "reader@example.test", tier: "member", isAdmin: false }}><ImageViewerProvider>
          <div style={{ display: "flex", height: "100vh", padding: 24 }}><ChatSidebar />
            {location.pathname === "/chats" && <main style={{ flex: 1, minWidth: 0 }}><NewChatPanel /></main>}
          </div>
        </ImageViewerProvider></ViewerProvider>
      </ChatRouteProvider>
    </I18nProvider>
  </MantineProvider>,
);

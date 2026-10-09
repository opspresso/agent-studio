import { createRoot } from "react-dom/client";
import { MantineProvider } from "@mantine/core";
import "@mantine/core/styles.css";
import { theme } from "../../src/app/theme";
import { I18nProvider } from "../../src/app/_i18n/provider";
import { ViewerProvider } from "../../src/app/_lib/useViewer";
import Profile from "../../src/app/profile/page";
import Members from "../../src/app/members/page";
import Audits from "../../src/app/audits/page";
import Audio from "../../src/app/agents/[name]/audio/page";
import WorkspaceTools from "../../src/app/agents/[name]/workspace/page";
import Settings from "../../src/app/agents/[name]/settings/page";
import Integrations from "../../src/app/agents/[name]/integrations/page";
import { NewChatEntry } from "../../src/app/chats/_components/NewChatEntry";
import { ChatRouteProvider } from "../../src/app/chats/_components/ChatRouteSelection";
import NotFound from "../../src/app/not-found";

function NewChat() { return <ChatRouteProvider><NewChatEntry workspacesEnabled={false} /></ChatRouteProvider>; }
import { AgentAudioContext } from "../../src/app/agents/[name]/_components/AgentAudioContext";
import { AgentWorkspaceContext } from "../../src/app/agents/[name]/_components/AgentWorkspaceContext";

const query = new URLSearchParams(location.search);
const guest = query.get("role") === "guest";
const Page = query.get("page") === "profile" ? Profile : query.get("page") === "members" ? Members
  : query.get("page") === "audio" ? Audio : query.get("page") === "workspace" ? WorkspaceTools
  : query.get("page") === "settings" ? Settings : query.get("page") === "integrations" ? Integrations
  : query.get("page") === "chat" ? NewChat : query.get("page") === "not-found" ? NotFound : Audits;
const feature = { enabled: query.get("state") === "loading" ? undefined : query.get("state") === "enabled",
  error: query.get("state") === "error" ? "Feature unavailable" : undefined };
createRoot(document.getElementById("root")!).render(
  <MantineProvider theme={theme}><I18nProvider locale="en">
    <ViewerProvider viewer={query.get("role") === "loading" ? null : { email: "viewer@example.test", isAdmin: !guest, tier: guest ? "guest" : "admin" }}>
      <AgentAudioContext.Provider value={feature}><AgentWorkspaceContext.Provider value={feature}>
        <main style={{ padding: 16 }}><Page /></main>
      </AgentWorkspaceContext.Provider></AgentAudioContext.Provider>
    </ViewerProvider>
  </I18nProvider></MantineProvider>,
);

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
import { AgentAudioContext } from "../../src/app/agents/[name]/_components/AgentAudioContext";
import { AgentWorkspaceContext } from "../../src/app/agents/[name]/_components/AgentWorkspaceContext";

const query = new URLSearchParams(location.search);
const guest = query.get("role") === "guest";
const Page = query.get("page") === "profile" ? Profile : query.get("page") === "members" ? Members
  : query.get("page") === "audio" ? Audio : query.get("page") === "workspace" ? WorkspaceTools : Audits;
const feature = { enabled: query.get("state") === "loading" ? undefined : query.get("state") === "enabled",
  error: query.get("state") === "error" ? "Feature unavailable" : undefined };
createRoot(document.getElementById("root")!).render(
  <MantineProvider theme={theme}><I18nProvider locale="en">
    <ViewerProvider viewer={{ email: "viewer@example.test", isAdmin: !guest, tier: guest ? "guest" : "admin" }}>
      <AgentAudioContext.Provider value={feature}><AgentWorkspaceContext.Provider value={feature}>
        <main style={{ padding: 16 }}><Page /></main>
      </AgentWorkspaceContext.Provider></AgentAudioContext.Provider>
    </ViewerProvider>
  </I18nProvider></MantineProvider>,
);

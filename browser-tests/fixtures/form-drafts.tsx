import { createRoot } from "react-dom/client";
import { MantineProvider } from "@mantine/core";
import "@mantine/core/styles.css";
import { theme } from "../../src/app/theme";
import { I18nProvider } from "../../src/app/_i18n/provider";
import { ViewerProvider } from "../../src/app/_lib/useViewer";
import AgentSettings from "../../src/app/agents/[name]/settings/page";
import { ModelRoutingSection } from "../../src/app/models/ModelRoutingSection";
import Skills from "../../src/app/skills/page";
import Skill from "../../src/app/skills/[name]/page";
import Mcp from "../../src/app/tools/[name]/page";

const page = new URLSearchParams(location.search).get("page");
createRoot(document.getElementById("root")!).render(
  <MantineProvider theme={theme}><I18nProvider locale="en">
    <ViewerProvider viewer={{ email: "owner@example.test", tier: "admin", isAdmin: true }}>
      <style>{":root { --font-sans: system-ui; --font-mono: monospace; }"}</style>
      <main style={{ padding: 24 }}>{page === "routing" ? <ModelRoutingSection models={[]} />
        : page === "skills" ? <Skills /> : page === "skill" ? <Skill /> : page === "mcp" ? <Mcp /> : <AgentSettings />}</main>
    </ViewerProvider>
  </I18nProvider></MantineProvider>,
);

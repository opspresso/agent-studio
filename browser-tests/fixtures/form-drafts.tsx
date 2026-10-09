import { createRoot } from "react-dom/client";
import "@mantine/core/styles.css";
import { ConsoleThemeProvider } from "../../src/app/_components/ConsoleThemeProvider";
import { I18nProvider } from "../../src/app/_i18n/provider";
import { ViewerProvider } from "../../src/app/_lib/useViewer";
import AgentSettings from "../../src/app/agents/[name]/settings/page";
import { ModelRoutingSection } from "../../src/app/models/ModelRoutingSection";
import Skills from "../../src/app/skills/page";
import Skill from "../../src/app/skills/[name]/page";
import Mcp from "../../src/app/tools/[name]/page";

const params = new URLSearchParams(location.search);
const page = params.get("page");
createRoot(document.getElementById("root")!).render(
  <I18nProvider locale={params.get("locale") === "ko" ? "ko" : "en"}><ConsoleThemeProvider>
    <ViewerProvider viewer={{ email: "owner@example.test", tier: "admin", isAdmin: true }}>
      <style>{":root { --font-sans: system-ui; --font-mono: monospace; }"}</style>
      <main style={{ padding: 24 }}>{page === "routing" ? <ModelRoutingSection models={[]} />
        : page === "skills" ? <Skills /> : page === "skill" ? <Skill /> : page === "mcp" ? <Mcp /> : <AgentSettings />}</main>
    </ViewerProvider>
  </ConsoleThemeProvider></I18nProvider>,
);

import { createRoot } from "react-dom/client";
import "@mantine/core/styles.css";
import "../../src/app/globals.css";
import { ConsoleThemeProvider } from "../../src/app/_components/ConsoleThemeProvider";
import { I18nProvider } from "../../src/app/_i18n/provider";
import { ViewerProvider } from "../../src/app/_lib/useViewer";
import Agents from "../../src/app/agents/page";
import Skills from "../../src/app/skills/page";
import Tools from "../../src/app/tools/page";
import Plugins from "../../src/app/plugins/page";
import Members from "../../src/app/members/page";
import Models from "../../src/app/models/page";

const Page = location.pathname === "/skills" ? Skills : location.pathname === "/tools" ? Tools
  : location.pathname === "/plugins" ? Plugins : location.pathname === "/members" ? Members
  : location.pathname === "/models" ? Models : Agents;
createRoot(document.getElementById("root")!).render(<I18nProvider locale="en"><ConsoleThemeProvider>
  <ViewerProvider viewer={{ email: "viewer@example.test", isAdmin: true, tier: "admin" }}>
    <main style={{ padding: 24 }}><Page /></main>
  </ViewerProvider>
</ConsoleThemeProvider></I18nProvider>);

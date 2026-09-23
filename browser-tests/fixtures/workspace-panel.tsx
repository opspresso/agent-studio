import { createRoot } from "react-dom/client";
import { MantineProvider } from "@mantine/core";
import "@mantine/core/styles.css";
import { theme } from "../../src/app/theme";
import { I18nProvider } from "../../src/app/_i18n/provider";
import { WorkspacePanel } from "../../src/app/workspaces/_components/WorkspacePanel";

createRoot(document.getElementById("root")!).render(
  <MantineProvider theme={theme}>
    <I18nProvider locale="en">
      <div style={{ height: "100vh", padding: 24 }}><WorkspacePanel id="workspace-1" /></div>
    </I18nProvider>
  </MantineProvider>,
);

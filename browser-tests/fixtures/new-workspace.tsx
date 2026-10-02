import { createRoot } from "react-dom/client";
import { MantineProvider } from "@mantine/core";
import "@mantine/core/styles.css";
import { theme } from "../../src/app/theme";
import { I18nProvider } from "../../src/app/_i18n/provider";
import { ViewerProvider } from "../../src/app/_lib/useViewer";
import { NewWorkspaceForm } from "../../src/app/workspaces/_components/NewWorkspaceForm";

createRoot(document.getElementById("root")!).render(
  <MantineProvider theme={theme}><I18nProvider locale="en"><ViewerProvider viewer={{ email: "member@example.test", tier: "member", isAdmin: false }}><NewWorkspaceForm /></ViewerProvider></I18nProvider></MantineProvider>,
);

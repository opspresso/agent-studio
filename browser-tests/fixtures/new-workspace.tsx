import { createRoot } from "react-dom/client";
import { MantineProvider } from "@mantine/core";
import "@mantine/core/styles.css";
import { theme } from "../../src/app/theme";
import { I18nProvider } from "../../src/app/_i18n/provider";
import { NewWorkspaceForm } from "../../src/app/workspaces/_components/NewWorkspaceForm";

createRoot(document.getElementById("root")!).render(
  <MantineProvider theme={theme}><I18nProvider locale="en"><NewWorkspaceForm /></I18nProvider></MantineProvider>,
);

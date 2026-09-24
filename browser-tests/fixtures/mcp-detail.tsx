import { useState } from "react";
import { createRoot } from "react-dom/client";
import { MantineProvider } from "@mantine/core";
import "@mantine/core/styles.css";
import { theme } from "../../src/app/theme";
import { I18nProvider } from "../../src/app/_i18n/provider";
import { ViewerProvider } from "../../src/app/_lib/useViewer";
import McpDetailPage from "../../src/app/tools/[name]/page";

declare global {
  interface Window { __mcpDetailName: string }
}

function Fixture() {
  const [name, setName] = useState("first");
  window.__mcpDetailName = name;
  return <>
    <button onClick={() => setName("second")}>Switch server</button>
    <McpDetailPage />
  </>;
}

createRoot(document.getElementById("root")!).render(
  <MantineProvider theme={theme}><I18nProvider locale="en"><ViewerProvider viewer={{
    email: "reader@example.test", tier: "member", isAdmin: false, isConfiguredAdmin: false,
  }}><Fixture /></ViewerProvider></I18nProvider></MantineProvider>,
);

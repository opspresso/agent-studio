import { useState } from "react";
import { createRoot } from "react-dom/client";
import { MantineProvider } from "@mantine/core";
import "@mantine/core/styles.css";
import { theme } from "../../src/app/theme";
import { I18nProvider } from "../../src/app/_i18n/provider";
import { ViewerProvider } from "../../src/app/_lib/useViewer";
import SkillDetailPage from "../../src/app/skills/[name]/page";

declare global {
  interface Window { __skillDetailName: string }
}

function Fixture() {
  const [name, setName] = useState("first");
  window.__skillDetailName = name;
  return <>
    <button onClick={() => setName("second")}>Switch skill</button>
    <SkillDetailPage />
  </>;
}

createRoot(document.getElementById("root")!).render(
  <MantineProvider theme={theme}><I18nProvider locale="en"><ViewerProvider viewer={{
    email: "admin@example.test", tier: "admin", isAdmin: true, isConfiguredAdmin: true,
  }}><style>{":root { --font-sans: system-ui; --font-mono: monospace; }"}</style>
    <Fixture /></ViewerProvider></I18nProvider></MantineProvider>,
);

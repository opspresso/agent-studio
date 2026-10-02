import { useState } from "react";
import { McpBindingInput } from "../../src/app/agents/[name]/_components/inputs";
import type { McpBinding } from "../../src/domain/agent/types";
import { createRoot } from "react-dom/client";
import { MantineProvider } from "@mantine/core";
import "@mantine/core/styles.css";
import { theme } from "../../src/app/theme";
import { I18nProvider } from "../../src/app/_i18n/provider";
import { ViewerProvider } from "../../src/app/_lib/useViewer";
import AgentLayout from "../../src/app/agents/[name]/layout";
import IntegrationsPage from "../../src/app/agents/[name]/integrations/page";

const member = new URLSearchParams(window.location.search).has("member");

function BindingFixture() {
  const [values, onChange] = useState<McpBinding[]>([{ name: "constructor" }]);
  return <McpBindingInput agentName="fixture-agent" values={values} onChange={onChange} options={[]}
    save={{ run() {}, saving: false, disabled: false, error: null, saved: false, label: "Save" }} />;
}

createRoot(document.getElementById("root")!).render(
  <MantineProvider theme={theme}><I18nProvider locale="en"><ViewerProvider viewer={{
    email: member ? "member@example.test" : "admin@example.test", tier: member ? "member" : "admin", isAdmin: !member,
  }}><style>{":root { --font-sans: system-ui; --font-mono: monospace; }"}</style>
  <div style={{ padding: 24 }}>{new URLSearchParams(window.location.search).has("binding") ? <BindingFixture /> : <AgentLayout><IntegrationsPage /></AgentLayout>}</div></ViewerProvider></I18nProvider></MantineProvider>,
);

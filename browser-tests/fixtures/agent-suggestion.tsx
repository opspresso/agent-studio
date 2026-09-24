import { createRoot } from "react-dom/client";
import { useState } from "react";
import { MantineProvider, Textarea, Text } from "@mantine/core";
import "@mantine/core/styles.css";
import { theme } from "../../src/app/theme";
import { I18nProvider } from "../../src/app/_i18n/provider";
import { AgentSuggestion } from "../../src/app/_components/AgentSuggestion";
import type { RecommendationSurface } from "../../src/application/llm/agentRecommendation";
import ModelUsagePage from "../../src/app/settings/model-usage/page";
import { AgentConfigurationEditor } from "../../src/app/agents/[name]/_components/AgentConfigurationEditor";
import { ViewerProvider } from "../../src/app/_lib/useViewer";
import type { AgentConfigurationInput } from "../../src/app/agents/lib/api";

function Fixture() {
  const [request, setRequest] = useState("");
  const [surface, setSurface] = useState<RecommendationSurface>("chat");
  const [selected, setSelected] = useState("writer");
  return <div style={{ padding: 24, width: 480 }}>
    <button onClick={() => setSurface(value => value === "chat" ? "workspace" : "chat")}>Switch surface</button>
    <Textarea label="Request" value={request} onChange={event => setRequest(event.currentTarget.value)} />
    <Text>Selected: {selected}</Text>
    <AgentSuggestion surface={surface} request={request}
      candidates={[{ name: "writer", displayName: "Writer" }, { name: "coder", displayName: "Coder" }]}
      selected={selected} onSelect={setSelected} />
  </div>;
}

function ConfigurationFixture() {
  const [value, setValue] = useState<AgentConfigurationInput>({
    model: "", systemPrompt: "", parameters: { piiFiltering: false },
    mcpList: [], skillList: [], subagentList: [],
  });
  return <ViewerProvider viewer={{ email: "reader@example.test", tier: "member", isAdmin: false, isConfiguredAdmin: false }}>
    <div style={{ padding: 24, maxWidth: 800 }}>
      <AgentConfigurationEditor projectName="agent" models={[]} imageModels={[]} value={value} onChange={setValue}
        schemaText="" onSchemaChange={() => {}} schemaError={null}
        save={{ run: () => {}, saving: false, disabled: false, error: null, saved: false, label: "Save" }} />
    </div>
  </ViewerProvider>;
}

createRoot(document.getElementById("root")!).render(<MantineProvider theme={theme}><I18nProvider locale="en">
  {location.pathname === "/usage" ? <ModelUsagePage /> : location.pathname === "/configuration" ? <ConfigurationFixture /> : <Fixture />}
</I18nProvider></MantineProvider>);

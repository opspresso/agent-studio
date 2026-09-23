import { createRoot } from "react-dom/client";
import { useState } from "react";
import { MantineProvider, Textarea, Text } from "@mantine/core";
import "@mantine/core/styles.css";
import { theme } from "../../src/app/theme";
import { I18nProvider } from "../../src/app/_i18n/provider";
import { AgentSuggestion } from "../../src/app/_components/AgentSuggestion";
import type { RecommendationSurface } from "../../src/application/llm/agentRecommendation";
import ModelUsagePage from "../../src/app/settings/model-usage/page";

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

createRoot(document.getElementById("root")!).render(<MantineProvider theme={theme}><I18nProvider locale="en">
  {location.pathname === "/usage" ? <ModelUsagePage /> : <Fixture />}
</I18nProvider></MantineProvider>);

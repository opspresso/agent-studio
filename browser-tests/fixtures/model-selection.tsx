import { createRoot } from "react-dom/client";
import { useState } from "react";
import { MantineProvider } from "@mantine/core";
import "@mantine/core/styles.css";
import { theme } from "../../src/app/theme";
import { I18nProvider } from "../../src/app/_i18n/provider";
import ModelSelectionPage from "../../src/app/settings/models/page";
import ModelsPage from "../../src/app/models/page";
import RegisteredModelsPage from "../../src/app/settings/models/registered/page";
import { ViewerProvider } from "../../src/app/_lib/useViewer";
import { ModelSelect } from "../../src/app/_components/modelOptions";
import type { ModelOption } from "../../src/app/_components/modelOptions";
import { useCatalogView } from "../../src/app/_components/CatalogView";

const pickerModels: ModelOption[] = [
  { id: "office/long-model-name-with-many-segments-and-a-provider-route", provider: "office", family: "long-model", maker: "office",
    displayName: "Office model", favorite: false, contextWindow: 8192, maxTokens: 2048,
    pricing: { inputPer1M: 2, outputPer1M: 8 },
    capabilities: { tools: true, structuredOutput: false, imageInput: false, reasoning: false } },
  { id: "router/vendor/jev-latest", provider: "router", family: "jev-latest", maker: "vendor",
    displayName: "Jev Latest", favorite: true, contextWindow: 32000, maxTokens: 8000,
    pricing: { inputPer1M: 0.042, outputPer1M: 0 },
    capabilities: { tools: true, structuredOutput: false, imageInput: false, reasoning: false } },
];

function PickerFixture() {
  const [model, setModel] = useState<string | null>(pickerModels[0]!.id);
  return <ModelSelect label="Model" models={pickerModels} value={model} searchable onChange={setModel} />;
}

function ViewFixture() {
  const [view] = useCatalogView();
  const [firstView] = useState(view);
  return <output aria-label="First catalog view">{firstView}</output>;
}

createRoot(document.getElementById("root")!).render(<MantineProvider theme={theme}><I18nProvider locale="en">
  <ViewerProvider viewer={{ email: "admin@example.test", isAdmin: true, isConfiguredAdmin: true, tier: "admin" }}>
    <div style={{ padding: 24, maxWidth: location.pathname === "/narrow" ? 600 : undefined }}>{location.pathname === "/view" ? <ViewFixture /> : location.pathname === "/selected" ? <ModelsPage /> : location.pathname === "/registered" ? <RegisteredModelsPage /> : location.pathname === "/picker" ? <PickerFixture /> : <ModelSelectionPage />}</div>
  </ViewerProvider>
</I18nProvider></MantineProvider>);

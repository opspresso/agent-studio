import { useState } from "react";
import { createRoot } from "react-dom/client";
import { MantineProvider } from "@mantine/core";
import "@mantine/core/styles.css";
import { theme } from "../../src/app/theme";
import { I18nProvider } from "../../src/app/_i18n/provider";
import TraceDetailPage from "../../src/app/agents/[name]/traces/[traceId]/page";

declare global {
  interface Window { __traceDetailId: string }
}

function Fixture() {
  const [traceId, setTraceId] = useState("missing");
  window.__traceDetailId = traceId;
  return <>
    <button onClick={() => setTraceId("present")}>Switch trace</button>
    <TraceDetailPage />
  </>;
}

createRoot(document.getElementById("root")!).render(
  <MantineProvider theme={theme}><I18nProvider locale="en"><Fixture /></I18nProvider></MantineProvider>,
);

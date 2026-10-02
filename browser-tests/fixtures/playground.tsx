import { createRoot } from "react-dom/client";
import { MantineProvider } from "@mantine/core";
import "@mantine/core/styles.css";
import { theme } from "../../src/app/theme";
import { I18nProvider } from "../../src/app/_i18n/provider";
import { ViewerProvider } from "../../src/app/_lib/useViewer";
import { ImageViewerProvider } from "../../src/app/_components/ImageViewer";
import { RunPanel } from "../../src/app/agents/[name]/_components/RunPanel";

createRoot(document.getElementById("root")!).render(
  <MantineProvider theme={theme}><I18nProvider locale="en"><ViewerProvider viewer={{ email: "member@example.test", tier: "member", isAdmin: false }}><ImageViewerProvider>
    {/* The Next layout supplies these variables in the application. */}
    <style>{":root { --font-sans: system-ui; --font-mono: monospace; }"}</style>
    <main style={{ maxWidth: 760, margin: "auto", padding: 16 }}>
      <RunPanel agentName="fixture" configured />
    </main>
  </ImageViewerProvider></ViewerProvider></I18nProvider></MantineProvider>,
);

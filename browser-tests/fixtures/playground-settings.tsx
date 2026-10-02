import { createRoot } from "react-dom/client";
import { MantineProvider } from "@mantine/core";
import "@mantine/core/styles.css";
import { theme } from "../../src/app/theme";
import { I18nProvider } from "../../src/app/_i18n/provider";
import { ViewerProvider } from "../../src/app/_lib/useViewer";
import { ImageViewerProvider } from "../../src/app/_components/ImageViewer";
import PlaygroundPage from "../../src/app/agents/[name]/page";

const role = new URLSearchParams(location.search).get("role");
createRoot(document.getElementById("root")!).render(
  <MantineProvider theme={theme}><I18nProvider locale="en"><ViewerProvider viewer={{
    email: role === "owner" ? "owner@example.test" : "member@example.test",
    tier: role === "guest" ? "guest" : role === "admin" ? "admin" : "member", isAdmin: role === "admin",
  }}><ImageViewerProvider>
    <style>{":root { --font-sans: system-ui; --font-mono: monospace; }"}</style>
    <main style={{ padding: 24 }}><PlaygroundPage /></main>
  </ImageViewerProvider></ViewerProvider></I18nProvider></MantineProvider>,
);

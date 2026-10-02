import { createRoot } from "react-dom/client";
import { MantineProvider } from "@mantine/core";
import "@mantine/core/styles.css";
import "../../src/app/globals.css";
import { theme } from "../../src/app/theme";
import { I18nProvider } from "../../src/app/_i18n/provider";
import { ViewerProvider } from "../../src/app/_lib/useViewer";
import { ImageViewerProvider } from "../../src/app/_components/ImageViewer";
import ArtifactsPage from "../../src/app/artifacts/page";
import { ArtifactGallery } from "../../src/app/artifacts/_components/ArtifactGallery";
import { listAgentArtifacts, type ArtifactQuery } from "../../src/app/artifacts/api";

const loadAgent = (query: ArtifactQuery) => listAgentArtifacts("helper", query);
const guest = new URLSearchParams(location.search).get("role") === "guest";

createRoot(document.getElementById("root")!).render(
  <MantineProvider theme={theme}>
    <I18nProvider locale="en">
      <ViewerProvider viewer={{ email: "viewer@example.test", tier: guest ? "guest" : "admin", isAdmin: !guest }}>
        <ImageViewerProvider>
          <div style={{ padding: 24 }}>
            {location.pathname === "/agent"
              ? <ArtifactGallery load={loadAgent} emptyText="No agent files" showAgent={false} />
              : <ArtifactsPage />}
          </div>
        </ImageViewerProvider>
      </ViewerProvider>
    </I18nProvider>
  </MantineProvider>,
);

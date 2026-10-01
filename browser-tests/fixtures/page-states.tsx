import { createRoot } from "react-dom/client";
import { MantineProvider } from "@mantine/core";
import "@mantine/core/styles.css";
import { theme } from "../../src/app/theme";
import { I18nProvider } from "../../src/app/_i18n/provider";
import { ViewerProvider } from "../../src/app/_lib/useViewer";
import Profile from "../../src/app/profile/page";
import Members from "../../src/app/members/page";
import Audits from "../../src/app/audits/page";

const query = new URLSearchParams(location.search);
const guest = query.get("role") === "guest";
const Page = query.get("page") === "profile" ? Profile : query.get("page") === "members" ? Members : Audits;
createRoot(document.getElementById("root")!).render(
  <MantineProvider theme={theme}><I18nProvider locale="en">
    <ViewerProvider viewer={{ email: "viewer@example.test", isAdmin: !guest, isConfiguredAdmin: !guest, tier: guest ? "guest" : "admin" }}>
      <main style={{ padding: 16 }}><Page /></main>
    </ViewerProvider>
  </I18nProvider></MantineProvider>,
);

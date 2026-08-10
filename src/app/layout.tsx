import type { Metadata } from "next";
import { ColorSchemeScript, MantineProvider, mantineHtmlProps } from "@mantine/core";
import { Notifications } from "@mantine/notifications";
import { AppLayout } from "@/components/AppLayout";
import { getSessionUser } from "@/lib/session";
import { resolveViewer } from "@/lib/viewer";
import { theme } from "./theme";
import { version } from "../../package.json";

// Order matters: core first, then the other @mantine packages, then ours.
import "@mantine/core/styles.css";
import "@mantine/notifications/styles.css";
import "@mantine/charts/styles.css";
import "./globals.css";

export const metadata: Metadata = {
  title: "Agent Studio",
  description: "LLM platform for prompt, agent, and cost management",
};

/**
 * The viewer is resolved here, before anything renders, and handed to the chrome
 * as a prop.
 *
 * `AppLayout` used to ask `useSession()` for it. That hook has no cookie during
 * SSR, so it answered `isPending` — which the layout counted as signed in, and
 * every visitor was served the whole navigation. A signed-out one then watched
 * it disappear once the session resolved: a flash, a hydration mismatch, and the
 * shape of the workspace handed to someone who cannot use it, which is exactly
 * what `src/proxy.ts` turns navigation away to avoid.
 *
 * The cost is that a per-viewer shell cannot be prerendered, so every route
 * renders on demand. The prerendered ones were only ever *wrong* — a shell built
 * for nobody in particular, carrying a nav it could not know applied — and React
 * threw each one away on hydration regardless.
 */
export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const user = await getSessionUser();
  const viewer = user ? await resolveViewer(user) : null;

  return (
    <html lang="en" {...mantineHtmlProps}>
      <head>
        {/*
         * Applies the stored colour scheme before first paint. Replaces the
         * hand-written localStorage script this file used to inline; Mantine
         * owns the key and the toggle now.
         */}
        <ColorSchemeScript defaultColorScheme="auto" />
      </head>
      <body>
        <MantineProvider theme={theme} defaultColorScheme="auto">
          <Notifications position="top-right" />
          <AppLayout version={version} viewer={viewer}>
            {children}
          </AppLayout>
        </MantineProvider>
      </body>
    </html>
  );
}

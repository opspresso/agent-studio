import type { Metadata } from "next";
import { ColorSchemeScript, MantineProvider, mantineHtmlProps } from "@mantine/core";
import { Notifications } from "@mantine/notifications";
import { Chakra_Petch, Figtree, JetBrains_Mono } from "next/font/google";
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
  title: "AgentDure",
  description: "Build AI agents that work together.",
};

/*
 * The three faces, self-hosted at build time so nothing is fetched from a font
 * CDN at runtime. They reach the styles as CSS variables rather than class
 * names because `theme.ts` is a `"use client"` module and cannot import a font
 * object across that boundary — it reads `var(--font-sans)` instead.
 *
 * Neither Figtree nor Chakra Petch carries Hangul, so the system stack stays
 * behind them in `theme.ts` as the fallback that actually renders Korean.
 */
const sans = Figtree({ subsets: ["latin"], variable: "--font-sans", display: "swap" });

// The display face: geometric, squared-off, and only used for headings — three
// weights is the whole range `theme.ts` asks for.
const display = Chakra_Petch({
  subsets: ["latin"],
  weight: ["500", "600", "700"],
  variable: "--font-display",
  display: "swap",
});

const mono = JetBrains_Mono({ subsets: ["latin"], variable: "--font-mono", display: "swap" });

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
    <html
      lang="en"
      className={`${sans.variable} ${display.variable} ${mono.variable}`}
      {...mantineHtmlProps}
    >
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

import type { Metadata } from "next";
import { ColorSchemeScript, MantineProvider, mantineHtmlProps } from "@mantine/core";
import { Notifications } from "@mantine/notifications";
import { Chakra_Petch, Figtree, JetBrains_Mono } from "next/font/google";
import { AppLayout } from "@/components/AppLayout";
import { ImageViewerProvider } from "./_components/ImageViewer";
import { config } from "@/lib/config";
import { getSessionUser } from "@/lib/session";
import { resolveViewer } from "@/lib/viewer";
import { I18nProvider } from "./_i18n/provider";
import { resolveLocale } from "./_i18n/server";
import { theme } from "./theme";
import { version } from "../../package.json";

// Order matters: core first, then the other @mantine packages, then ours.
import "@mantine/core/styles.css";
import "@mantine/notifications/styles.css";
import "@mantine/charts/styles.css";
import "./globals.css";

/*
 * `template` is what names the tab, and it is the reason every route segment
 * carries a `layout.tsx` that renders nothing but its children: 24 of the 29
 * pages are `"use client"`, and a client component cannot export `metadata`.
 * The segment layout is the only place left to say what the page is called, so
 * a bare one there is deliberate — deleting it as an empty file puts the tab
 * back to reading `Agent Studio` like every other one.
 *
 * A page that names itself gets `<name> · Agent Studio`; anything under it that
 * does not — every project sub-tab — inherits the nearest ancestor that did.
 */
export const metadata: Metadata = {
  title: { default: "Agent Studio", template: "%s · Agent Studio" },
  description: "Build and operate production AI agents.",
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
  /*
   * Resolved here rather than per page so `lang` and every translated string
   * come from one read of the cookie. `lang` is not decoration: it is what a
   * screen reader picks a voice from, and what tells the browser which
   * line-breaking rules to apply to Hangul.
   */
  const locale = await resolveLocale();

  return (
    <html
      lang={locale}
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
          <I18nProvider locale={locale}>
            <Notifications position="top-right" />
            <ImageViewerProvider>
              <AppLayout
                version={version}
                viewer={viewer}
                userImage={user?.image ?? null}
                signInProviders={config.authProviders}
              >
                {children}
              </AppLayout>
            </ImageViewerProvider>
          </I18nProvider>
        </MantineProvider>
      </body>
    </html>
  );
}

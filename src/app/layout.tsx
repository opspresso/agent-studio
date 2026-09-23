import type { Metadata } from "next";
import { ColorSchemeScript, MantineProvider, mantineHtmlProps } from "@mantine/core";
import { Notifications } from "@mantine/notifications";
import { Figtree, JetBrains_Mono } from "next/font/google";
import { AppLayout } from "@/components/AppLayout";
import { ImageViewerProvider } from "./_components/ImageViewer";
import { config } from "@/lib/config";
import { getSessionUser } from "@/lib/session";
import { resolveViewer } from "@/lib/viewer";
import { I18nProvider } from "./_i18n/provider";
import { ViewerProvider } from "./_lib/useViewer";
import { resolveLocale } from "./_i18n/server";
import { theme } from "./theme";
import { version } from "../../package.json";

// Order matters: core first, then the other @mantine packages, then ours.
import "@mantine/core/styles.css";
import "@mantine/notifications/styles.css";
import "@mantine/charts/styles.css";
import "./globals.css";

/** Page titles and icons use the deployment's runtime branding. */
export function generateMetadata(): Metadata {
  const branding = config.branding;
  return {
    title: { default: branding.name, template: `%s · ${branding.name}` },
    applicationName: branding.name,
    description: "Build and operate production AI agents.",
    icons: {
      icon: [
        { url: branding.faviconUrl, sizes: "any", type: "image/x-icon" },
        { url: branding.favicon32Url, sizes: "32x32", type: "image/png" },
        { url: branding.icon192Url, sizes: "192x192", type: "image/png" },
      ],
      apple: [{ url: branding.appleTouchUrl, sizes: "180x180", type: "image/png" }],
    },
  };
}

/*
 * The two faces, self-hosted at build time so nothing is fetched from a font
 * CDN at runtime. They reach the styles as CSS variables rather than class
 * names because `theme.ts` is a `"use client"` module and cannot import a font
 * object across that boundary — it reads `var(--font-sans)` instead.
 *
 * Figtree does not carry Hangul, so the system stack in `theme.ts` renders Korean.
 */
const sans = Figtree({ subsets: ["latin"], variable: "--font-sans", display: "swap" });

const mono = JetBrains_Mono({ subsets: ["latin"], variable: "--font-mono", display: "swap" });

/**
 * The viewer is resolved here, before anything renders, and handed to the chrome
 * as a prop.
 *
 * A client `useSession()` has no cookie during SSR and answers `isPending`.
 * Counting that as signed in serves every visitor the whole navigation, then
 * removes it on hydration — a flash, a mismatch, and workspace shape leaked to
 * someone `src/proxy.ts` turns away.
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
  const branding = config.branding;

  return (
    <html
      lang={locale}
      className={`${sans.variable} ${mono.variable}`}
      {...mantineHtmlProps}
    >
      <head>
        {/*
         * Applies the stored colour scheme before first paint. Mantine owns the
         * storage key and the toggle.
         */}
        <ColorSchemeScript defaultColorScheme="auto" />
      </head>
      <body>
        <MantineProvider theme={theme} defaultColorScheme="auto">
          <I18nProvider locale={locale} serviceName={branding.name}>
            <Notifications position="top-right" />
            <ViewerProvider viewer={viewer}>
              <ImageViewerProvider>
                <AppLayout
                  branding={branding}
                  version={version}
                  viewer={viewer}
                  userImage={user?.image ?? null}
                  signInProviders={config.authProviders}
                >
                  {children}
                </AppLayout>
              </ImageViewerProvider>
            </ViewerProvider>
          </I18nProvider>
        </MantineProvider>
      </body>
    </html>
  );
}

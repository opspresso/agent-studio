import type { Metadata } from "next";
import { ColorSchemeScript, MantineProvider, mantineHtmlProps } from "@mantine/core";
import { Notifications } from "@mantine/notifications";
import { AppLayout } from "@/components/AppLayout";
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

export default function RootLayout({ children }: { children: React.ReactNode }) {
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
          <AppLayout version={version}>{children}</AppLayout>
        </MantineProvider>
      </body>
    </html>
  );
}

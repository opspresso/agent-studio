import type { Metadata } from "next";
import { AppHeader } from "@/components/AppHeader";
import { version } from "../../package.json";
import "./globals.css";

export const metadata: Metadata = {
  title: "Agent Studio",
  description: "LLM platform for prompt, agent, and cost management",
};

const themeScript = `
try {
  const theme = localStorage.getItem("agent-studio-theme") || "system";
  const dark = theme === "dark" || (theme === "system" && matchMedia("(prefers-color-scheme: dark)").matches);
  document.documentElement.classList.toggle("dark", dark);
  document.documentElement.dataset.theme = theme;
} catch {}
`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
      </head>
      <body>
        <AppHeader />
        <main id="main-content" className="mx-auto min-h-[calc(100vh-9rem)] max-w-7xl px-4 py-6">
          {children}
        </main>
        <footer className="mx-auto max-w-7xl px-4 py-6 text-center text-xs text-neutral-400 dark:text-neutral-600">
          Agent Studio v{version}
        </footer>
      </body>
    </html>
  );
}

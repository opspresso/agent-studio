import type { Metadata } from "next";
import Image from "next/image";
import Link from "next/link";
import { UserMenu } from "@/components/UserMenu";
import "./globals.css";

export const metadata: Metadata = {
  title: "Agent Studio",
  description: "LLM platform for prompt, agent, and cost management",
};

const NAV_ITEMS = [
  { href: "/projects", label: "Projects" },
  { href: "/chats", label: "Chats" },
  { href: "/skills", label: "Skills" },
  { href: "/tools", label: "Tools" },
  { href: "/agents", label: "Agents" },
  { href: "/dashboard", label: "Dashboard" },
  { href: "/settings", label: "Settings" },
] as const;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <header className="sticky top-0 z-10 border-b border-neutral-200 bg-white/90 backdrop-blur dark:border-neutral-800 dark:bg-neutral-950/90">
          <div className="mx-auto flex h-14 max-w-7xl items-center gap-6 px-4">
            <Link href="/projects" className="flex items-center gap-2 text-lg font-semibold">
              <Image src="/logo.png" alt="Agent Studio" width={28} height={28} />
              Agent Studio
            </Link>
            <nav className="flex items-center gap-4 text-sm text-neutral-600 dark:text-neutral-300">
              {NAV_ITEMS.map((item) => (
                <Link key={item.href} href={item.href} className="hover:text-brand">
                  {item.label}
                </Link>
              ))}
            </nav>
            <div className="ml-auto">
              <UserMenu />
            </div>
          </div>
        </header>
        <main className="mx-auto max-w-7xl px-4 py-6">{children}</main>
      </body>
    </html>
  );
}

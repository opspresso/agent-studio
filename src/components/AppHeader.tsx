"use client";

import Image from "next/image";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { ThemeToggle } from "./ThemeToggle";
import { UserMenu } from "./UserMenu";

const NAV_ITEMS = [
  { href: "/projects", label: "Projects" },
  { href: "/chats", label: "Chats" },
  { href: "/skills", label: "Skills" },
  { href: "/tools", label: "Tools" },
  { href: "/agents", label: "Agents" },
  { href: "/settings", label: "Settings" },
] as const;

export function AppHeader() {
  const pathname = usePathname();

  return (
    <header className="sticky top-0 z-10 border-b border-neutral-200/80 bg-white/85 backdrop-blur-xl dark:border-neutral-800/80 dark:bg-neutral-950/85">
      <div className="mx-auto flex h-14 max-w-7xl items-center gap-5 px-4">
        <Link
          href="/"
          className="flex shrink-0 items-center gap-2 rounded-md text-lg font-semibold tracking-tight focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-brand"
        >
          <Image src="/logo.png" alt="" width={28} height={28} priority />
          <span className="hidden sm:inline">Agent Studio</span>
        </Link>
        <nav
          aria-label="Primary navigation"
          className="hidden h-full items-center gap-1 text-sm md:flex"
        >
          {NAV_ITEMS.map((item) => {
            const active = pathname === item.href || pathname.startsWith(`${item.href}/`);
            return (
              <Link
                key={item.href}
                href={item.href}
                aria-current={active ? "page" : undefined}
                className={`relative inline-flex h-full items-center px-2.5 transition-colors focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-brand ${
                  active
                    ? "font-medium text-neutral-950 after:absolute after:inset-x-2.5 after:bottom-0 after:h-0.5 after:rounded-full after:bg-brand dark:text-white"
                    : "text-neutral-500 hover:text-neutral-950 dark:text-neutral-400 dark:hover:text-white"
                }`}
              >
                {item.label}
              </Link>
            );
          })}
        </nav>
        <div className="ml-auto flex items-center gap-2">
          <ThemeToggle />
          <UserMenu />
        </div>
      </div>
      <nav
        aria-label="Primary navigation"
        className="scrollbar-none mx-auto flex max-w-7xl gap-1 overflow-x-auto px-4 md:hidden"
      >
        {NAV_ITEMS.map((item) => {
          const active = pathname === item.href || pathname.startsWith(`${item.href}/`);
          return (
            <Link
              key={item.href}
              href={item.href}
              aria-current={active ? "page" : undefined}
              className={`shrink-0 border-b-2 px-2.5 pb-2 pt-1 text-sm transition-colors focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-brand ${
                active
                  ? "border-brand font-medium text-neutral-950 dark:text-white"
                  : "border-transparent text-neutral-500 hover:text-neutral-950 dark:text-neutral-400 dark:hover:text-white"
              }`}
            >
              {item.label}
            </Link>
          );
        })}
      </nav>
    </header>
  );
}

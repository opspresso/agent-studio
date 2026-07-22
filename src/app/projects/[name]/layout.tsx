"use client";

import Link from "next/link";
import { useParams, usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { useSession } from "@/lib/auth-client";
import { getProject } from "../lib/api";

export default function ProjectLayout({ children }: { children: React.ReactNode }) {
  const params = useParams<{ name: string }>();
  const pathname = usePathname();
  const name = params.name;
  const base = `/projects/${name}`;

  const { data: session } = useSession();
  const [ownerEmail, setOwnerEmail] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    getProject(name)
      .then((project) => !cancelled && setOwnerEmail(project.ownerEmail))
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [name]);

  const tabs = [
    { href: base, label: "Playground" },
    { href: `${base}/versions`, label: "Versions" },
    { href: `${base}/usage`, label: "Usage" },
    { href: `${base}/settings`, label: "Settings" },
  ];

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <Link href="/projects" className="text-sm text-neutral-500 hover:text-brand">
          ← Projects
        </Link>
        <span className="font-mono text-sm font-medium">{name}</span>
        {ownerEmail && (
          <span className="flex items-center gap-1.5 text-xs text-neutral-400">
            owner: {ownerEmail}
            {session?.user.email === ownerEmail && (
              <span className="rounded bg-neutral-100 px-1 py-0.5 font-medium text-neutral-500 dark:bg-neutral-800 dark:text-neutral-400">
                you
              </span>
            )}
          </span>
        )}
      </div>
      <nav className="flex gap-1 border-b border-neutral-200 dark:border-neutral-800">
        {tabs.map((tab) => {
          const active = pathname === tab.href;
          return (
            <Link
              key={tab.href}
              href={tab.href}
              className={`-mb-px border-b-2 px-3 py-2 text-sm ${
                active
                  ? "border-brand font-medium text-brand"
                  : "border-transparent text-neutral-500 hover:text-neutral-800 dark:hover:text-neutral-200"
              }`}
            >
              {tab.label}
            </Link>
          );
        })}
      </nav>
      {children}
    </div>
  );
}

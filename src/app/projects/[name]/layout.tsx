"use client";

import Link from "next/link";
import { useParams, usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { useSession } from "@/lib/auth-client";
import { OwnerLine } from "@/app/_components/OwnerLine";
import { getProject } from "../lib/api";
import { textButtonClass } from "@/app/_components/buttonStyles";

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
    { href: `${base}/traces`, label: "Traces" },
    { href: `${base}/api-reference`, label: "API Reference" },
    { href: `${base}/settings`, label: "Settings" },
  ];

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <Link href="/projects" className={textButtonClass}>
          ← Projects
        </Link>
        <span className="font-mono text-sm font-medium">{name}</span>
        {ownerEmail && (
          <OwnerLine
            ownerEmail={ownerEmail}
            isMine={session?.user.email === ownerEmail}
            prefix="owner: "
          />
        )}
      </div>
      <nav className="scrollbar-none flex gap-1 overflow-x-auto border-b border-neutral-200 dark:border-neutral-800">
        {tabs.map((tab) => {
          const active = pathname === tab.href;
          return (
            <Link
              key={tab.href}
              href={tab.href}
              className={`-mb-px shrink-0 border-b-2 px-3 py-2 text-sm ${
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

"use client";

import Link from "next/link";
import { IconDownload, IconExternalLink } from "@tabler/icons-react";
import { useT } from "@/app/_i18n/provider";
import classes from "./NavigationLink.module.css";

type Destination = { newTab?: boolean; download?: never } | { download: string | true; newTab?: never };

/** Content navigation has one visible affordance; menu items and creation CTAs own their layouts. */
export function NavigationLink({ href, children, resource = false, newTab, download, label, className }: {
  href: string;
  children: React.ReactNode;
  resource?: boolean;
  label?: string;
  className?: string;
} & Destination) {
  const t = useT();
  const props = {
    href,
    className: [classes.link, className].filter(Boolean).join(" "),
    "data-resource": resource || undefined,
    "aria-label": label && newTab ? `${label} (${t("navigation.newTab")})` : label,
    ...(newTab ? { target: "_blank", rel: "noopener noreferrer" } : {}),
    ...(download ? { download } : {}),
    children: <>
      {download && <IconDownload size={14} aria-hidden="true" />}
      <span>{children}</span>
      {newTab && <><IconExternalLink size={14} aria-hidden="true" /><span className={classes.srOnly}> ({t("navigation.newTab")})</span></>}
    </>,
  };
  // Downloads and artifact views must keep their response headers and never be prefetched as pages.
  const internalPage = href.startsWith("/") && !href.startsWith("//") && !href.startsWith("/api/") && !download;
  return internalPage ? <Link {...props} /> : <a {...props} />;
}

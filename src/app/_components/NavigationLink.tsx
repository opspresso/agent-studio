"use client";

import Link from "next/link";
import { IconArrowLeft, IconArrowRight, IconDownload, IconExternalLink } from "@tabler/icons-react";
import { useT } from "@/app/_i18n/provider";
import classes from "./NavigationLink.module.css";
import interaction from "./InteractiveSurface.module.css";

type Destination = { newTab?: boolean; download?: never } | { download: string | true; newTab?: never };

/** Boxed navigation, or one primary link stretched over an InteractiveSurface. */
export function NavigationLink({ href, children, resource = false, surface = false, back = false, newTab, download, label, className }: {
  href: string;
  children: React.ReactNode;
  resource?: boolean;
  surface?: boolean;
  back?: boolean;
  label?: string;
  className?: string;
} & Destination) {
  const t = useT();
  const props = {
    href,
    className: [classes.link, (surface || resource) && interaction.trigger, className].filter(Boolean).join(" "),
    "data-resource": resource || undefined,
    "data-surface-trigger": surface || resource || undefined,
    "aria-label": label && newTab ? `${label} (${t("navigation.newTab")})` : label,
    ...(newTab ? { target: "_blank", rel: "noopener noreferrer" } : {}),
    ...(download ? { download } : {}),
    children: <>
      {back && <IconArrowLeft size={16} aria-hidden="true" />}
      {download && <IconDownload size={14} aria-hidden="true" />}
      <span className={classes.label}>{children}</span>
      {newTab && <><IconExternalLink size={14} aria-hidden="true" /><span className={classes.srOnly}> ({t("navigation.newTab")})</span></>}
      {!back && !newTab && !download && <IconArrowRight size={16} className={classes.arrow} aria-hidden="true" />}
    </>,
  };
  // Downloads and artifact views must keep their response headers and never be prefetched as pages.
  const internalPage = href.startsWith("/") && !href.startsWith("//") && !href.startsWith("/api/") && !download;
  return internalPage ? <Link {...props} /> : <a {...props} />;
}

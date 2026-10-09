"use client";

import Link from "next/link";
import { Group, UnstyledButton } from "@mantine/core";
import type { TablerIcon } from "@tabler/icons-react";
import classes from "./PageTabs.module.css";

/** Match segment boundaries and choose the most specific tab for nested pages. */
export function activeTabHref(pathname: string, items: readonly { href: string }[]): string | null {
  return items.reduce<string | null>((active, { href }) =>
    (pathname === href || pathname.startsWith(`${href}/`)) && href.length > (active?.length ?? 0) ? href : active, null);
}

/** Page navigation uses native links; ARIA tabs are reserved for panels within one page. */
export function PageTabs({ value, items, label, variant = "default" }: {
  value: string;
  items: readonly { href: string; label: string; Icon?: TablerIcon }[];
  label: string;
  variant?: "default" | "pills";
}) {
  const active = activeTabHref(value, items);
  return <div className={classes.viewport}>
    <Group component="nav" aria-label={label} className={classes.list} data-variant={variant}>
      {items.map(({ href, label, Icon }) => <UnstyledButton component={Link} key={href} href={href}
        className={classes.tab} data-active={active === href || undefined} aria-current={active === href ? "page" : undefined}>
        {Icon && <Icon size={16} stroke={1.8} aria-hidden="true" />}{label}
      </UnstyledButton>)}
    </Group>
  </div>;
}

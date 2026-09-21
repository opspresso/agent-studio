"use client";

import Link from "next/link";
import { Tabs } from "@mantine/core";
import type { TablerIcon } from "@tabler/icons-react";
import classes from "./PageTabs.module.css";

/** Route-backed tabs share active, keyboard and overflow behavior across settings and projects. */
export function PageTabs({ value, items, label, variant = "default" }: {
  value: string;
  items: readonly { href: string; label: string; Icon?: TablerIcon }[];
  label: string;
  variant?: "default" | "pills";
}) {
  return <div className={classes.viewport}>
    <Tabs value={value} variant={variant} activateTabWithKeyboard={false} classNames={{ list: classes.list, tab: classes.tab }}>
      <Tabs.List aria-label={label}>{items.map(({ href, label, Icon }) => <Tabs.Tab key={href} value={href}
        renderRoot={props => <Link {...props} href={href} aria-current={value === href ? "page" : undefined} />}>
        {Icon && <Icon size={16} stroke={1.8} />}{label}
      </Tabs.Tab>)}</Tabs.List>
    </Tabs>
  </div>;
}

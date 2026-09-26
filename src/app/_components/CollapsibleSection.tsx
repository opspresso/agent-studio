"use client";

import { Accordion, ActionIcon, Group, Text } from "@mantine/core";
import { IconHistory } from "@tabler/icons-react";
import { BADGE } from "@/app/_components/badgeColors";
import classes from "./CollapsibleSection.module.css";

/**
 * Collapsible card, closed unless the call site says otherwise. The title and
 * optional badge stay visible while collapsed so state is readable without
 * opening it.
 *
 * A single-item `Accordion`: five call sites would otherwise each repeat the
 * `Accordion` / `Accordion.Item` / `Accordion.Control` scaffolding to show one
 * section. Titles keep the same casing and weight as other console sections.
 *
 * `danger` paints the title in the "broken" red: a section whose contents are
 * destructive must read as such while collapsed, before anyone opens it.
 *
 * `defaultOpen` is for the section a page exists to use — the Playground's run
 * panel — rather than one kept out of the way until wanted. It is the initial
 * state only; opening and closing stays the reader's.
 */
export function CollapsibleSection({
  title,
  badge,
  danger,
  defaultOpen,
  selected,
  onSelect,
  selectLabel,
  children,
}: {
  title: string;
  badge?: React.ReactNode;
  danger?: boolean;
  defaultOpen?: boolean;
  selected?: boolean;
  onSelect?: () => void;
  selectLabel?: string;
  children: React.ReactNode;
}) {
  return (
    <Accordion
      variant="contained"
      chevronPosition="left"
      radius="md"
      defaultValue={defaultOpen ? "section" : null}
    >
      <Accordion.Item value="section" className={selected ? classes.selected : undefined}>
        <div className={classes.heading}>
          <Accordion.Control className={classes.control}>
            <Group justify="space-between" gap="sm" pr="sm" wrap="nowrap">
              <Text
                fz="sm"
                fw={600}
                c={danger ? BADGE.broken : undefined}
              >
                {title}
              </Text>
              {badge}
            </Group>
          </Accordion.Control>
          {onSelect && selectLabel && (
            <ActionIcon type="button" variant={selected ? "light" : "subtle"}
              size="md" className={classes.action} onClick={onSelect}
              aria-label={selectLabel} title={selectLabel}>
              <IconHistory size={18} stroke={1.8} aria-hidden="true" />
            </ActionIcon>
          )}
        </div>
        <Accordion.Panel>{children}</Accordion.Panel>
      </Accordion.Item>
    </Accordion>
  );
}

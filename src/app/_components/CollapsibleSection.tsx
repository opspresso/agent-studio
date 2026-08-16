"use client";

import { Accordion, Group, Text } from "@mantine/core";
import { BADGE } from "@/app/_components/badgeColors";

/**
 * Collapsible card, closed unless the call site says otherwise. The title and
 * optional badge stay visible while collapsed so state is readable without
 * opening it.
 *
 * A single-item `Accordion`: five call sites would otherwise each repeat the
 * `Accordion` / `Accordion.Item` / `Accordion.Control` scaffolding to show one
 * section, and the uppercase caption is the shape those sections share.
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
  children,
}: {
  title: string;
  badge?: React.ReactNode;
  danger?: boolean;
  defaultOpen?: boolean;
  children: React.ReactNode;
}) {
  return (
    <Accordion
      variant="contained"
      chevronPosition="left"
      radius="md"
      defaultValue={defaultOpen ? "section" : null}
    >
      <Accordion.Item value="section">
        <Accordion.Control>
          <Group justify="space-between" gap="sm" pr="sm" wrap="nowrap">
            <Text
              fz="sm"
              fw={600}
              tt="uppercase"
              c={danger ? BADGE.broken : "dimmed"}
              style={{ letterSpacing: "0.05em" }}
            >
              {title}
            </Text>
            {badge}
          </Group>
        </Accordion.Control>
        <Accordion.Panel>{children}</Accordion.Panel>
      </Accordion.Item>
    </Accordion>
  );
}

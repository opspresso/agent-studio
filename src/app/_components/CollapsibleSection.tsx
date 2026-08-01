"use client";

import { Accordion, Group, Text } from "@mantine/core";
import { BADGE } from "@/app/_components/badgeColors";

/**
 * Collapsible card, closed by default. The title and optional badge stay
 * visible while collapsed so state is readable without opening it.
 *
 * A single-item `Accordion`: five call sites would otherwise each repeat the
 * `Accordion` / `Accordion.Item` / `Accordion.Control` scaffolding to show one
 * section, and the uppercase caption is the shape those sections share.
 *
 * `danger` paints the title in the "broken" red: a section whose contents are
 * destructive must read as such while collapsed, before anyone opens it.
 */
export function CollapsibleSection({
  title,
  badge,
  danger,
  children,
}: {
  title: string;
  badge?: React.ReactNode;
  danger?: boolean;
  children: React.ReactNode;
}) {
  return (
    <Accordion variant="contained" chevronPosition="left" radius="md">
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

"use client";

import { Group, Text, ThemeIcon, Title } from "@mantine/core";
import type { TablerIcon } from "@tabler/icons-react";
import classes from "./CatalogHeader.module.css";

export function CatalogHeader({
  title,
  description,
  Icon,
  children,
}: {
  title: string;
  description: string;
  Icon: TablerIcon;
  children?: React.ReactNode;
}) {
  return (
    <div className={classes.header}>
      <Group justify="space-between" align="center" gap="md" wrap="wrap">
        <Group gap="md" align="flex-start" wrap="nowrap" style={{ flex: "1 1 320px", minWidth: 0 }}>
          <ThemeIcon
            size={42}
            radius="lg"
            variant="light"
            color="brand"
            style={{ flexShrink: 0 }}
          >
            <Icon size={23} stroke={1.7} />
          </ThemeIcon>
          <div style={{ minWidth: 0 }}>
            <Title order={1} fz={{ base: 26, md: 30 }} lts="-0.025em">
              {title}
            </Title>
            <Text fz="sm" c="dimmed" mt={5} maw={680} style={{ wordBreak: "keep-all" }}>
              {description}
            </Text>
          </div>
        </Group>
        {children}
      </Group>
    </div>
  );
}

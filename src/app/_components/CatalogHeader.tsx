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
      <Group justify="space-between" align="flex-end" gap="xl" wrap="wrap">
        <Group gap="md" align="flex-start" wrap="nowrap">
          <ThemeIcon
            size={48}
            radius="lg"
            variant="gradient"
            gradient={{ from: "brand.6", to: "violet.5", deg: 135 }}
          >
            <Icon size={23} stroke={1.7} />
          </ThemeIcon>
          <div>
            <Text fz={10} fw={650} c="brand" tt="uppercase" lts="0.13em" mb={4}>
              Studio library
            </Text>
            <Title order={1} fz={{ base: 28, md: 36 }} lts="-0.035em">
              {title}
            </Title>
            <Text fz="sm" c="dimmed" mt={5} maw={620}>
              {description}
            </Text>
          </div>
        </Group>
        {children}
      </Group>
    </div>
  );
}

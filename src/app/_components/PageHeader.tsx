import { Group, Text, ThemeIcon, Title } from "@mantine/core";
import type { TablerIcon } from "@tabler/icons-react";
import classes from "./PageHeader.module.css";

export function PageHeader({
  title,
  description,
  Icon,
  badges,
  details,
  children,
}: {
  title: React.ReactNode;
  description?: React.ReactNode;
  Icon?: TablerIcon;
  badges?: React.ReactNode;
  details?: React.ReactNode;
  children?: React.ReactNode;
}) {
  return (
    <header className={classes.header}>
      <Group justify="space-between" gap="lg" align="flex-start" wrap="wrap">
        <Group gap="md" wrap="nowrap" align="flex-start" className={classes.identity}>
          {Icon && <ThemeIcon size={42} radius="lg" variant="light" color="brand" style={{ flexShrink: 0 }}>
            <Icon size={23} stroke={1.7} />
          </ThemeIcon>}
          <div className={classes.content}>
            <Group gap="xs" wrap="wrap"><Title order={1} className={classes.title}>{title}</Title>{badges}</Group>
            {description && <Text fz="sm" c="dimmed" mt={5} maw={720} className={classes.description}>{description}</Text>}
            {details && <div className={classes.details}>{details}</div>}
          </div>
        </Group>
        {children && <Group gap="xs" wrap="wrap" className={classes.actions}>{children}</Group>}
      </Group>
    </header>
  );
}

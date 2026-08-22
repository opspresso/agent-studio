"use client";

/**
 * A URL the console has no page for.
 *
 * `"use client"` for the same reason `PageState` is: the copy is translated,
 * and the link back is the only thing on it. It renders inside the root layout,
 * so the navigation a reader needs to get anywhere else is already on screen.
 */

import Link from "next/link";
import { Button, Card, Group, Stack, Text, Title } from "@mantine/core";
import { useT } from "@/app/_i18n/provider";

export default function NotFound() {
  const t = useT();
  return (
    <Card withBorder padding="lg" radius="lg">
      <Stack gap="sm" align="flex-start">
        <Title order={3}>{t("error.notFoundTitle")}</Title>
        <Text fz="sm" c="dimmed">
          {t("error.notFoundBody")}
        </Text>
        <Group mt="xs">
          <Button component={Link} href="/">
            {t("error.backHome")}
          </Button>
        </Group>
      </Stack>
    </Card>
  );
}

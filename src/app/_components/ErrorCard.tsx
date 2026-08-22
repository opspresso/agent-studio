"use client";

/**
 * What every segment error boundary draws.
 *
 * The boundaries themselves are one file per segment — Next resolves them by
 * name and position, so `error.tsx` cannot be shared by importing it — but the
 * copy and the shape are one thing and live here. Two of them existed for a
 * day and had already disagreed about whether the digest is shown.
 */

import { useEffect } from "react";
import { Alert, Button, Card, Group, Stack, Text } from "@mantine/core";
import { IconAlertTriangle, IconReload } from "@tabler/icons-react";
import { useT } from "@/app/_i18n/provider";

export function ErrorCard({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const t = useT();
  // The only record there is. A throw that happens in the browser never
  // reaches the server log, and React hands the boundary a `digest` only for
  // one it rendered on the server — so an operator reading logs alone would
  // see nothing at all for the failures this component exists to catch.
  useEffect(() => {
    console.error("[console] page render failed", error);
  }, [error]);

  return (
    <Card withBorder padding="lg" radius="lg">
      <Stack gap="md">
        <Alert
          color="red"
          variant="light"
          icon={<IconAlertTriangle size={18} />}
          title={t("error.pageTitle")}
        >
          <Text fz="sm">{t("error.pageBody")}</Text>
        </Alert>
        {/*
         * The digest and not the message: on a production build React replaces
         * the thrown text with a redacted string, while the digest is what the
         * server log line carries. It is the only half of the pair a reader can
         * usefully quote.
         */}
        {error.digest && (
          <Text fz="xs" c="dimmed" ff="monospace">
            {error.digest}
          </Text>
        )}
        <Group>
          <Button leftSection={<IconReload size={16} />} onClick={reset}>
            {t("error.retry")}
          </Button>
        </Group>
      </Stack>
    </Card>
  );
}

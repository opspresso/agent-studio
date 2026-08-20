"use client";

import { useEffect, useState } from "react";
import { CollapsibleSection } from "@/app/_components/CollapsibleSection";
import { CopyButton } from "@/app/_components/CopyButton";
import { useConfirm } from "@/app/_components/useConfirm";
import {
  generateProjectToken,
  getProjectToken,
  revealProjectToken,
  revokeProjectToken,
  type ApiTokenStatus,
} from "../../lib/api";
import { Alert, Badge, Button, Code, Group, Stack, Text } from "@mantine/core";
import { stateColor } from "@/app/_components/badgeColors";
import { useLocale, useT } from "@/app/_i18n/provider";
import { formatDate } from "@/shared/date";

export function TokenSection({ projectName }: { projectName: string }) {
  const t = useT();
  const locale = useLocale();
  const [status, setStatus] = useState<ApiTokenStatus | null>(null);
  // The plaintext token, either just generated or read back on request. Held in
  // component state only, so leaving the page hides it again.
  const [rawToken, setRawToken] = useState<string | null>(null);
  const [freshlyIssued, setFreshlyIssued] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    getProjectToken(projectName)
      .then((s) => !cancelled && setStatus(s))
      .catch((e) => !cancelled && setError(e instanceof Error ? e.message : "Load failed"));
    return () => {
      cancelled = true;
    };
  }, [projectName]);

  const { confirm, confirmModal } = useConfirm();

  async function generate(regenerate: boolean) {
    if (
      regenerate &&
      !(await confirm({
        title: "Regenerate token",
        message: "The current token stops working immediately.",
        confirmLabel: "Regenerate",
      }))
    ) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const { token, masked, createdAt } = await generateProjectToken(projectName);
      setRawToken(token);
      setFreshlyIssued(true);
      setStatus({ configured: true, masked, createdAt, revealable: true });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to generate token");
    } finally {
      setBusy(false);
    }
  }

  async function revoke() {
    if (
      !(await confirm({
        title: "Revoke token",
        message: "Callers using it will stop working immediately.",
        confirmLabel: "Revoke",
      }))
    ) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await revokeProjectToken(projectName);
      setStatus({ configured: false });
      setRawToken(null);
      setFreshlyIssued(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to revoke token");
    } finally {
      setBusy(false);
    }
  }

  async function reveal() {
    setBusy(true);
    setError(null);
    try {
      setRawToken(await revealProjectToken(projectName));
      setFreshlyIssued(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to reveal token");
    } finally {
      setBusy(false);
    }
  }

  if (!status) {
    return error ? (
      <Text fz="sm" c="red">
        {error}
      </Text>
    ) : null;
  }

  return (
    <CollapsibleSection
      title={t("pset.apiToken")}
      badge={
        <Badge color={stateColor(status.configured)} radius="xl">
          {status.configured ? "set" : "none"}
        </Badge>
      }
    >
      <Stack gap="sm">
        {confirmModal}
        <Text fz="xs" c="dimmed" lh={1.6}>
          A token lets external callers run this project&apos;s execution APIs (predict, chat
          completions, agent) with an <Code>Authorization: Bearer</Code> header instead of a
          browser session. It authenticates as the project owner — its runs are attributed to
          the token, spend against this project&apos;s cost limits, and stay out of anyone&apos;s
          personal budget. It is scoped to this project and stored encrypted, so you can read
          it back here.
        </Text>

        {rawToken && (
          <Alert color="yellow" variant="light" p="sm">
            <Group gap="xs" wrap="nowrap">
              <Code style={{ flex: 1, minWidth: 0, overflowWrap: "anywhere" }}>{rawToken}</Code>
              <CopyButton text={rawToken} />
              <Button variant="default" size="compact-xs" onClick={() => setRawToken(null)}>
                Hide
              </Button>
            </Group>
            <Text fz="xs" mt={4}>
              {freshlyIssued
                ? "This token is now live; the previous one stopped working."
                : "Anyone holding this token can run this project's APIs."}
            </Text>
          </Alert>
        )}

        {status.configured && !rawToken && (
          <Stack gap={4}>
            <Group gap="xs" wrap="nowrap">
              {status.masked && (
                <Code style={{ flex: 1, minWidth: 0, overflowWrap: "anywhere" }}>
                  {status.masked}
                </Code>
              )}
              {status.revealable !== false && (
                <Button variant="default" size="compact-xs" onClick={reveal} disabled={busy}>
                  Reveal
                </Button>
              )}
            </Group>
            <Text fz="sm" c="dimmed">
              A token is set{status.createdAt ? ` (created ${formatDate(status.createdAt, locale)})` : ""}.
              {status.revealable === false
                ? " It was issued before tokens could be shown again, so only its hash is stored — regenerate to get one you can read back."
                : ""}
            </Text>
          </Stack>
        )}

        <Group gap="xs" wrap="wrap">
          {status.configured ? (
            <>
              <Button variant="default" onClick={() => generate(true)} loading={busy}>
                Regenerate
              </Button>
              <Button variant="default" color="red" onClick={revoke} disabled={busy}>
                Revoke
              </Button>
            </>
          ) : (
            <Button onClick={() => generate(false)} loading={busy}>
              Generate token
            </Button>
          )}
        </Group>

        {error && (
          <Text fz="sm" c="red">
            {error}
          </Text>
        )}
      </Stack>
    </CollapsibleSection>
  );
}

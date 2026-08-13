"use client";

import { useState } from "react";
import { Alert, Code, Stack, Text } from "@mantine/core";
import { FormModal } from "@/app/_components/FormModal";
import { jsonHeaders, readJson } from "@/app/_lib/httpClient";

interface ModelTestResult {
  ok: boolean;
  latencyMs: number;
  error?: string;
}

/**
 * One probe completion against a model, reported as it comes back. A failed
 * probe arrives as `ok: false` in a 200 — the transport `error` slot is only
 * for the request itself failing.
 */
export function TestModelModal({
  model,
  opened,
  onClose,
}: {
  /** Registry id, e.g. "openai/gpt-5.4"; null while no test is open. */
  model: string | null;
  opened: boolean;
  onClose: () => void;
}) {
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<ModelTestResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  function close() {
    setResult(null);
    setError(null);
    onClose();
  }

  async function run() {
    if (!model) return;
    setSubmitting(true);
    setResult(null);
    setError(null);
    try {
      const res = await fetch("/api/models/test", {
        method: "POST",
        headers: jsonHeaders,
        body: JSON.stringify({ model }),
      });
      setResult(await readJson<ModelTestResult>(res));
    } catch (runError) {
      setError(runError instanceof Error ? runError.message : "Test request failed");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <FormModal
      opened={opened}
      onClose={close}
      title="Test model"
      error={error}
      onSubmit={run}
      submitLabel={result ? "Run again" : "Run test"}
      submitting={submitting}
      hint="Sends one tiny completion through the real channel."
    >
      <Stack gap="sm">
        <Text fz="sm">
          Model <Code>{model}</Code>
        </Text>
        {result &&
          (result.ok ? (
            <Alert color="teal" variant="light">
              Responded in {result.latencyMs} ms.
            </Alert>
          ) : (
            <Alert color="red" variant="light" title={`Failed after ${result.latencyMs} ms`}>
              {result.error}
            </Alert>
          ))}
      </Stack>
    </FormModal>
  );
}

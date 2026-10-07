"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Alert, Badge, Button, Group, List, Paper, Stack, TagsInput, Text, Textarea } from "@mantine/core";
import { EVALUATION_CRITERIA, MAX_EVALUATION_EXPECTATIONS, MAX_EVALUATION_NAME_CHARS, MAX_EVALUATION_OUTCOME_CHARS, type EvaluationExpectations, type EvaluationReceipt, type EvaluationStatus } from "@/domain/evaluation/types";
import type { AgentEvaluation } from "@/application/evaluation/evaluationUseCases";
import { useLocale, useT } from "@/app/_i18n/provider";
import { CollapsibleSection } from "@/app/_components/CollapsibleSection";
import { JsonHighlight } from "@/app/_components/JsonHighlight";
import { formatUsd } from "@/app/_lib/formatUsd";
import { evaluateAgent } from "../../lib/api";

const COLORS: Record<EvaluationStatus, string> = { pass: "teal", "needs-improvement": "orange", unknown: "gray", "not-applicable": "gray" };

export function EvaluationPanel({ agentName, inputKey, receipt, canEvaluate, running, unsaved, ensureRun, onBusyChange }: {
  agentName: string;
  inputKey: object;
  receipt: EvaluationReceipt | null;
  canEvaluate: boolean;
  running: boolean;
  unsaved: boolean;
  ensureRun: () => Promise<EvaluationReceipt>;
  onBusyChange: (busy: boolean) => void;
}) {
  const t = useT();
  const locale = useLocale();
  const [expectations, setExpectations] = useState<EvaluationExpectations>({ skills: [], tools: [], outcome: "" });
  const [result, setResult] = useState<{ report: AgentEvaluation; token: string; inputKey: object; criteria: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const active = useRef<AbortController | null>(null);
  const criteria = JSON.stringify([expectations, locale]);
  const stale = result !== null && (result.inputKey !== inputKey || result.token !== receipt?.token || result.criteria !== criteria || unsaved);
  const invalidNames = [...expectations.skills, ...expectations.tools].some(name => name.length > MAX_EVALUATION_NAME_CHARS);
  const evidenceText = useMemo(() => result ? JSON.stringify(result.report.evidence, null, 2) : "", [result]);

  useEffect(() => () => { active.current?.abort(); active.current = null; }, []);

  async function evaluate() {
    if (!canEvaluate || active.current || invalidNames) return;
    const controller = new AbortController();
    active.current = controller;
    setBusy(true);
    onBusyChange(true);
    setError(null);
    try {
      const used = await ensureRun();
      controller.signal.throwIfAborted();
      const report = await evaluateAgent(agentName, used.token, expectations, locale, controller.signal);
      if (active.current === controller) setResult({ report, token: used.token, inputKey, criteria });
    } catch (error) {
      if (active.current === controller && !controller.signal.aborted) setError(error instanceof Error ? error.message : t("evaluation.failed"));
    } finally {
      if (active.current === controller) {
        active.current = null;
        setBusy(false);
        onBusyChange(false);
      }
    }
  }

  return <Stack gap="sm">
    <Text size="sm" c="dimmed">{t("evaluation.description")}</Text>
    {unsaved && <Alert color="yellow">{t("evaluation.saveFirst")}</Alert>}
    <TagsInput label={t("evaluation.skills")} description={t("evaluation.optional")}
      value={expectations.skills} onChange={skills => setExpectations(current => ({ ...current, skills }))}
      maxTags={MAX_EVALUATION_EXPECTATIONS} disabled={busy || running} />
    <TagsInput label={t("evaluation.tools")} description={t("evaluation.toolHint")}
      value={expectations.tools} onChange={tools => setExpectations(current => ({ ...current, tools }))}
      maxTags={MAX_EVALUATION_EXPECTATIONS} disabled={busy || running} />
    <Textarea label={t("evaluation.outcome")} placeholder={t("evaluation.outcomePlaceholder")}
      value={expectations.outcome} onChange={event => { const outcome = event.currentTarget.value; setExpectations(current => ({ ...current, outcome })); }}
      maxLength={MAX_EVALUATION_OUTCOME_CHARS} autosize minRows={2} maxRows={8} readOnly={busy || running} />
    {invalidNames && <Text c="red" size="sm">{t("evaluation.nameTooLong", { count: MAX_EVALUATION_NAME_CHARS })}</Text>}
    <Group>
      <Button onClick={evaluate} loading={busy} disabled={!canEvaluate || invalidNames}>
        {busy && running ? t("evaluation.runningFirst") : receipt ? t("evaluation.evaluate") : t("evaluation.runThenEvaluate")}
      </Button>
    </Group>
    {error && <Alert color="red">{error}</Alert>}
    {stale && <Alert color="yellow">{t("evaluation.stale")}</Alert>}
    {result && <Stack gap="sm">
      <Paper withBorder p="sm">
        <Stack gap="xs">
          <Text fw={600} size="sm">{t("evaluation.observedFacts")}</Text>
          <Text size="sm">{t("evaluation.activity", { calls: result.report.evidence.capabilities.toolCalls, results: result.report.evidence.capabilities.toolResults })}</Text>
          {result.report.observations.map((item, index) => <Group key={index} gap="xs">
            <Text size="sm" ff="monospace">{item.name}</Text>
            <Badge color={item.available === "offered" ? "teal" : "gray"}>{t(`evaluation.availability.${item.available}`)}</Badge>
            <Text size="xs">{item.requests === null ? t("evaluation.requestsUnknown") : t("evaluation.requests", { count: item.requests })}</Text>
          </Group>)}
          <Text size="xs" c="dimmed">{t("evaluation.factsHint")}</Text>
        </Stack>
      </Paper>
      <Text fw={600}>{result.report.summary}</Text>
      <Text size="xs" c="dimmed">{t("evaluation.modelAssessment", { model: result.report.model })}</Text>
      {EVALUATION_CRITERIA.map(key => {
        const check = result.report.checks[key];
        return <Paper key={key} withBorder p="sm">
          <Stack gap="xs">
            <Group justify="space-between"><Text fw={600} size="sm">{t(`evaluation.criterion.${key}`)}</Text>
              <Badge color={COLORS[check.status]}>{t(`evaluation.status.${check.status}`)}</Badge></Group>
            <Text size="sm">{check.summary}</Text>
            {check.evidence.length > 0 && <><Text size="xs" fw={600}>{t("evaluation.evidence")}</Text>
              <List size="sm">{check.evidence.map((note, index) => <List.Item key={index}>{note}</List.Item>)}</List></>}
            {check.improvements.length > 0 && <><Text size="xs" fw={600}>{t("evaluation.improvements")}</Text>
              <List size="sm">{check.improvements.map((note, index) => <List.Item key={index}>{note}</List.Item>)}</List></>}
          </Stack>
        </Paper>;
      })}
      {result.report.evidence.limitations.length > 0 && <Alert color="yellow" title={t("evaluation.limitations")}>
        <List size="sm">{result.report.evidence.limitations.map((note, index) => <List.Item key={index}>{note}</List.Item>)}</List>
      </Alert>}
      <CollapsibleSection title={t("evaluation.recordedEvidence")}>
        <pre style={{ maxHeight: 400, overflow: "auto", whiteSpace: "pre-wrap", overflowWrap: "anywhere", fontSize: 12 }}>
          <JsonHighlight text={evidenceText} />
        </pre>
      </CollapsibleSection>
      <Text size="xs" c="dimmed">{t("evaluation.cost", { cost: formatUsd(result.report.usage.costUsd, 6) })}</Text>
    </Stack>}
  </Stack>;
}

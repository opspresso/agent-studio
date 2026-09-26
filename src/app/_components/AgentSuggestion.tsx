"use client";

import { useEffect, useRef, useState } from "react";
import { Alert, Button, Group, Text } from "@mantine/core";
import { useT } from "@/app/_i18n/provider";
import { jsonHeaders, readJson } from "@/app/_lib/httpClient";
import { createAgentSuggestionQueue } from "@/app/_lib/agentSuggestionQueue";
import type { AgentRecommendationResponse } from "@/app/api/agent-recommendations/route";
import type { RecommendationSurface } from "@/application/llm/agentRecommendation";

interface Candidate { name: string; displayName: string }
interface Result { surface: RecommendationSurface; name: string }

/** A reversible suggestion shared by the new Chat and Workspace forms. */
export function AgentSuggestion({ surface, request, candidates, selected, onSelect, disabled }: {
  surface: RecommendationSurface;
  request: string;
  candidates: Candidate[];
  selected: string | null;
  onSelect(name: string): void;
  disabled?: boolean;
}) {
  const t = useT();
  const [result, setResult] = useState<Result | null>(null);
  const [errorKey, setErrorKey] = useState<string | null>(null);
  const queueRef = useRef<ReturnType<typeof createAgentSuggestionQueue> | null>(null);
  const text = request.trim();
  const names = candidates.map(candidate => candidate.name).join("\0");
  const key = JSON.stringify([surface, text, names]);

  useEffect(() => {
    if (candidates.length === 0 || disabled) return;
    const queue = createAgentSuggestionQueue(async (requestText, signal) => {
      const requestKey = JSON.stringify([surface, requestText, names]);
      try {
        const response = await fetch("/api/agent-recommendations", {
          method: "POST", headers: jsonHeaders,
          body: JSON.stringify({ surface, request: requestText }), signal,
        });
        if (response.status === 429) {
          const retryAfter = Number(response.headers.get("Retry-After"));
          if (Number.isFinite(retryAfter) && retryAfter > 0) queue.cooldown(retryAfter * 1_000);
        }
        const body = await readJson<AgentRecommendationResponse>(response);
        if (!signal.aborted) {
          const name = body.recommendation?.name;
          if (name && candidates.some(candidate => candidate.name === name)) {
            setResult({ surface, name });
          }
          setErrorKey(null);
        }
      } catch {
        if (!signal.aborted) setErrorKey(requestKey);
      }
    });
    queueRef.current = queue;
    return () => { queue.stop(); queueRef.current = null; };
  }, [surface, names, disabled]);

  useEffect(() => {
    queueRef.current?.update(text);
  }, [surface, text, names, disabled]);

  const recommended = result?.surface === surface
    ? candidates.find(candidate => candidate.name === result.name)
    : undefined;
  if (disabled || candidates.length === 0 || (!recommended && errorKey !== key)) return null;
  return <>
    {recommended && <Group gap="xs" align="center" role="status">
      <Text size="xs" c="dimmed">{t("agentSuggestion.label")}</Text>
      <Text size="xs" fw={600}>{recommended.displayName}</Text>
      {selected !== recommended.name && <Button size="compact-xs" variant="light" onClick={() => onSelect(recommended.name)}>
        {t("agentSuggestion.apply")}
      </Button>}
    </Group>}
    {errorKey === key && <Alert color="yellow" variant="light" py={4}>{t("agentSuggestion.failed")}</Alert>}
  </>;
}

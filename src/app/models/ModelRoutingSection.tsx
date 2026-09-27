"use client";

import { useEffect, useState } from "react";
import { Alert, Button, Stack } from "@mantine/core";
import { useT } from "@/app/_i18n/provider";
import { CollapsibleSection } from "@/app/_components/CollapsibleSection";
import { readJson, jsonHeaders } from "@/app/_lib/httpClient";
import { ModelRoutingPolicyEditor } from "./ModelRoutingPolicyEditor";
import type { CallRoutingPolicy } from "@/domain/llm/callRouting";
import type { ModelRoutingResponse } from "@/app/api/models/routing/route";
import type { SelectableModel } from "@/app/api/models/route";

export function ModelRoutingSection({ models }: { models: SelectableModel[] }) {
  const t = useT();
  const [policy, setPolicy] = useState<CallRoutingPolicy>();
  const [saved, setSaved] = useState<string>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let current = true;
    void fetch("/api/models/routing").then(response => readJson<ModelRoutingResponse>(response))
      .then(view => { if (current) { setPolicy(view.policy); setSaved(JSON.stringify(view.policy)); } })
      .catch(error => { if (current) setError(error instanceof Error ? error.message : "Could not load model routing policy"); });
    return () => { current = false; };
  }, []);
  async function save() {
    if (!policy || busy) return;
    setBusy(true); setError(undefined);
    try {
      const view = await readJson<ModelRoutingResponse>(await fetch("/api/models/routing", { method: "PUT", headers: jsonHeaders, body: JSON.stringify({ policy }) }));
      setPolicy(view.policy); setSaved(JSON.stringify(view.policy));
    } catch (error) { setError(error instanceof Error ? error.message : "Could not save model routing policy"); }
    finally { setBusy(false); }
  }
  return <CollapsibleSection title={t("routing.globalTitle")} defaultOpen>
    <Stack gap="sm">
      {error && <Alert color="red">{error}</Alert>}
      {policy && <>
        <ModelRoutingPolicyEditor value={policy} models={models} onChange={setPolicy} />
        <Button loading={busy} disabled={busy || saved === JSON.stringify(policy)} onClick={() => void save()}>{t("routing.saveShared")}</Button>
      </>}
    </Stack>
  </CollapsibleSection>;
}

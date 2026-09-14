"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { readJson } from "@/app/_lib/httpClient";
import type { WorkspaceDetailResponse } from "@/app/api/workspaces/[id]/route";
import type { WorkspaceEventsResponse } from "@/app/api/workspaces/[id]/events/route";
import type { WorkspaceEvent } from "@/domain/workspace/types";
import { WORKSPACE_LIMITS } from "@/domain/workspace/limits";

function mergeRows<T extends { id: string }>(previous: T[], latest: T[]): T[] {
  const rows = new Map(previous.map(row => [row.id, row]));
  for (const row of latest) rows.set(row.id, JSON.stringify(rows.get(row.id)) === JSON.stringify(row) ? rows.get(row.id)! : row);
  return [...rows.values()].sort((a, b) => b.id.localeCompare(a.id)).slice(0, WORKSPACE_LIMITS.page);
}

export function useWorkspace(id: string, selectedRun: string | null) {
  const [detail, setDetail] = useState<WorkspaceDetailResponse | null>(null);
  const [events, setEvents] = useState<WorkspaceEvent[]>([]);
  const [error, setError] = useState<string | null>(null);
  const loaded = useRef(false);
  const revision = useRef(-1);
  const alive = useRef(true);
  const detailRef = useRef(detail);
  detailRef.current = detail;
  const refresh = useCallback(async () => {
    const data = await readJson<WorkspaceDetailResponse>(await fetch(`/api/workspaces/${id}${loaded.current ? "?tail=1" : ""}`));
    if (!alive.current) return;
    loaded.current = true;
    if (data.workspace.revision > revision.current) {
      revision.current = data.workspace.revision;
      setDetail(previous => previous ? { ...data, runs: mergeRows(previous.runs, data.runs), approvals: mergeRows(previous.approvals, data.approvals) } : data);
    }
    setError(null);
  }, [id]);

  useEffect(() => {
    alive.current = true;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      try { await refresh(); } catch (error) { if (!stopped) setError(error instanceof Error ? error.message : "Workspace could not be loaded"); }
      const workspace = detailRef.current?.workspace;
      if (!stopped) timer = setTimeout(poll, workspace && !workspace.activeRunId && !workspace.activeActionId && !["closing", "suspending"].includes(workspace.status) ? 5000 : 1000);
    }
    void poll();
    return () => { stopped = true; alive.current = false; clearTimeout(timer); };
  }, [refresh]);

  const runId = selectedRun ?? detail?.runs[0]?.id;
  useEffect(() => {
    setEvents([]);
    if (!runId) return;
    let stopped = false;
    let after = Math.max(0, (detailRef.current?.runs.find(run => run.id === runId)?.lastEventSeq ?? 0) - 2000);
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      let more = false;
      try {
        const data = await readJson<WorkspaceEventsResponse>(await fetch(`/api/workspaces/${id}/events?run=${encodeURIComponent(runId!)}&after=${after}`));
        if (stopped) return;
        after = data.nextSeq; more = data.hasMore;
        if (data.events.length) setEvents(previous => [...previous, ...data.events].slice(-2000));
      } catch (error) { if (!stopped) setError(error instanceof Error ? error.message : "Workspace output could not be read"); }
      const run = detailRef.current?.runs.find(run => run.id === runId);
      const finished = run && run.status !== "queued" && run.status !== "running" && after >= run.lastEventSeq;
      if (!stopped && !finished) timer = setTimeout(poll, more ? 0 : 700);
    }
    void poll();
    return () => { stopped = true; clearTimeout(timer); };
  }, [id, runId]);
  return { detail, events, error, refresh, runId };
}

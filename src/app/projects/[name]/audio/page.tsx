"use client";

import { SectionHeading } from "@/app/_components/SectionHeading";
import { useCallback, useEffect, useRef, useState } from "react";
import { useParams } from "next/navigation";
import { Alert, Badge, Button, Checkbox, FileInput, Group, NumberInput, Paper, Progress, Select, SimpleGrid, Stack, Text, TextInput } from "@mantine/core";
import { useLocale, useT } from "@/app/_i18n/provider";
import { readJson, jsonHeaders } from "@/app/_lib/httpClient";
import { useConfirm } from "@/app/_components/useConfirm";
import { useViewer } from "@/app/_lib/useViewer";
import { listProjects, type SanitizedProject } from "../../lib/api";
import { formatDateTime } from "@/shared/date";
import type { AudioOptionsResponse } from "@/app/api/projects/[name]/audio-options/route";
import type { AudioJobsResponse } from "@/app/api/projects/[name]/audio-jobs/route";
import type { AudioJobView } from "@/application/audio/audioJobUseCases";
import type { SourceFile } from "@/domain/artifact/sourceFile";
import type { AudioConfigResponse } from "@/app/api/projects/[name]/audio-config/route";
import { isAudioJobTerminal, MAX_ACTIVE_AUDIO_JOBS } from "@/domain/audio/job";
import { useProjectAudio } from "../_components/ProjectAudioContext";
import { loadActiveAudioJobs, mergeAudioJobUpdates } from "./jobPolling";

export default function AudioPage() {
  const { enabled, error } = useProjectAudio();
  const t = useT();
  if (error) return <Alert color="red">{error}</Alert>;
  if (enabled === undefined) return <Text c="dimmed">{t("common.loading")}</Text>;
  if (!enabled) return <Alert color="blue">{t("audio.toolsRequired")}</Alert>;
  return <AudioProjectPage />;
}

function AudioProjectPage() {
  const { name } = useParams<{ name: string }>();
  return <AudioWorkspace key={name} name={name} />;
}

function AudioWorkspace({ name }: { name: string }) {
  const t = useT(); const locale = useLocale(); const viewer = useViewer();
  const { confirm, confirmModal } = useConfirm();
  const base = `/api/projects/${encodeURIComponent(name)}`;
  const [options, setOptions] = useState<AudioOptionsResponse>({ models: [], destinations: [] });
  const [optionsLoaded, setOptionsLoaded] = useState(false);
  const [savedConfig, setSavedConfig] = useState<AudioConfigResponse>(null);
  const [useSaved, setUseSaved] = useState(false);
  const [configEnabled, setConfigEnabled] = useState(true);
  const [maxActive, setMaxActive] = useState<number | string>(1);
  const [maxPerOccurrence, setMaxPerOccurrence] = useState<number | string>(1);
  const [loadingJobs, setLoadingJobs] = useState(true);
  const listRequest = useRef<AbortController | null>(null);
  const [projects, setProjects] = useState<SanitizedProject[]>([]);
  const [jobs, setJobs] = useState<AudioJobView[]>([]);
  const [next, setNext] = useState<string | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [uploaded, setUploaded] = useState<{ source: File; file: SourceFile } | null>(null);
  const [model, setModel] = useState<string | null>(null);
  const [language, setLanguage] = useState("");
  const [unit, setUnit] = useState<string | null>("months");
  const [duration, setDuration] = useState<number | string>(3);
  const [timezone, setTimezone] = useState("Asia/Seoul");
  const [writer, setWriter] = useState<string | null>(null);
  const [destination, setDestination] = useState<string | null>(null);
  const [documents, setDocuments] = useState(true);
  const [memories, setMemories] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async (after?: string) => {
    listRequest.current?.abort();
    const request = new AbortController();
    listRequest.current = request;
    setLoadingJobs(true);
    try {
      const result = await fetch(`${base}/audio-jobs?limit=20${after ? `&after=${encodeURIComponent(after)}` : ""}`, { signal: request.signal }).then(readJson<AudioJobsResponse>);
      if (!request.signal.aborted) {
        setJobs((previous) => after ? [...previous, ...result.jobs] : result.jobs);
        setNext(result.nextCursor);
      }
    } catch (error) { if (!request.signal.aborted) throw error; }
    finally { if (!request.signal.aborted) setLoadingJobs(false); }
  }, [base]);
  useEffect(() => {
    let active = true;
    Promise.all([fetch(`${base}/audio-options`).then(readJson<AudioOptionsResponse>), listProjects(), fetch(`${base}/audio-config`).then(readJson<AudioConfigResponse>)])
      .then(([options, projects, config]) => { if (active) {
        setOptions(options); setProjects(projects); setOptionsLoaded(true); setSavedConfig(config); setUseSaved(Boolean(config));
        if (config) { setConfigEnabled(config.enabled); setMaxActive(config.maxActive); setMaxPerOccurrence(config.maxPerOccurrence); }
      } })
      .catch((error) => { if (active) setError(error.message); });
    refresh().catch((error) => { if (active) setError(error.message); });
    return () => { active = false; listRequest.current?.abort(); };
  }, [base, refresh]);
  useEffect(() => {
    if (!jobs.some((job) => !isAudioJobTerminal(job.status))) return;
    const request = new AbortController();
    let pending = false;
    const timer = setInterval(async () => {
      if (document.hidden || pending) return;
      pending = true;
      try {
        const updates = await loadActiveAudioJobs(base, jobs, request.signal);
        if (!request.signal.aborted) setJobs((previous) => mergeAudioJobUpdates(previous, updates));
      } catch (error) {
        if (!request.signal.aborted) setError(error instanceof Error ? error.message : String(error));
      } finally { pending = false; }
    }, 5000);
    return () => { clearInterval(timer); request.abort(); };
  }, [base, jobs]);

  const validRetention = typeof duration === "number" && Number.isSafeInteger(duration) && duration > 0 && timezone.trim().length > 0;
  const processing = useSaved && savedConfig ? {
    model: savedConfig.model, language: savedConfig.language, retention: savedConfig.retention,
    postprocess: savedConfig.postprocess, destination: savedConfig.destination,
  } : { model: model ?? "", ...(language.trim() ? { language: language.trim() } : {}), retention: { unit: unit as "months" | "days", value: Number(duration), timezone },
    ...(writer ? { postprocess: { projectName: writer } } : {}),
    ...(destination ? { destination: { serverName: destination, documents, memories } } : {}) };
  const validProcessing = useSaved ? Boolean(savedConfig) : Boolean(model) && validRetention &&
    (!language.trim() || /^[a-z]{2,3}$/i.test(language.trim())) &&
    (!destination || ((documents || memories) && (!memories || Boolean(writer))));

  async function saveConfiguration() {
    if (!validProcessing) return;
    setBusy(true); setError(null);
    try {
      const result = await fetch(`${base}/audio-config`, { method: "PUT", headers: jsonHeaders,
        body: JSON.stringify({ ...processing, enabled: configEnabled, maxActive, maxPerOccurrence, revision: savedConfig?.revision ?? 0 }) }).then(readJson<AudioConfigResponse>);
      setSavedConfig(result); setUseSaved(Boolean(result));
    } catch (error) { setError(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  }

  async function submit() {
    if (!file || !validProcessing) return;
    setBusy(true); setError(null);
    try {
      const selectedRetention = processing.retention;
      const query = new URLSearchParams({ unit: selectedRetention.unit, value: String(selectedRetention.value), timezone: selectedRetention.timezone });
      const types: Record<string, string> = { mp3: "audio/mpeg", wav: "audio/wav", flac: "audio/flac", ogg: "audio/ogg" };
      const mimeType = types[file.name.split(".").at(-1)?.toLowerCase() ?? ""] || file.type || "application/octet-stream";
      const existing = uploaded?.source === file && uploaded.file.retention.unit === selectedRetention.unit && uploaded.file.retention.value === selectedRetention.value && uploaded.file.retention.timezone === selectedRetention.timezone ? uploaded.file : null;
      const stored = existing ? existing : await fetch(`${base}/source-files?${query}`, { method: "POST", body: file,
        headers: { "content-type": mimeType, "x-filename": encodeURIComponent(file.name) } }).then(readJson<SourceFile>);
      setUploaded({ source: file, file: stored });
      await fetch(`${base}/audio-jobs`, { method: "POST", headers: jsonHeaders, body: JSON.stringify({
        source: { kind: "file", fileId: stored.id },
        ...(useSaved && savedConfig ? { configRevision: savedConfig.revision } : { ...processing, task: writer || destination ? "process" : "transcribe" }),
      }) }).then(readJson<unknown>);
      setFile(null); setUploaded(null); await refresh();
    } catch (error) { setError(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  }
  async function act(job: AudioJobView, action: "retry" | "cancel" | "delete") {
    if (action === "delete" && !await confirm({ title: t("audio.deleteTitle"),
      message: t("audio.deleteBody"), confirmLabel: t("audio.delete") })) return;
    setBusy(true); setError(null);
    try { await fetch(`${base}/audio-jobs/${job.id}`, { method: "POST", headers: jsonHeaders,
      body: JSON.stringify({ action, revision: job.revision }) }).then(readJson<unknown>); await refresh(); }
    catch (error) { setError(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  }

  return <Stack gap="lg">
    {confirmModal}
    <SectionHeading title={t("audio.title")} description={t("audio.pageHint")} />
    {error && <Alert color="red">{error}</Alert>}
    {optionsLoaded && !options.models.length && <Alert>{t("audio.noModels")}</Alert>}
    <Paper withBorder p="lg"><Stack>
      {savedConfig && <>
        <Checkbox label={t("audio.useSaved")} checked={useSaved} onChange={(e) => {
          const checked = e.currentTarget.checked;
          if (!checked) {
            setModel(savedConfig.model); setLanguage(savedConfig.language ?? ""); setUnit(savedConfig.retention.unit); setDuration(savedConfig.retention.value); setTimezone(savedConfig.retention.timezone);
            setWriter(savedConfig.postprocess?.projectName ?? null);
            setDestination(savedConfig.destination?.serverName ?? null); setDocuments(savedConfig.destination?.documents ?? true); setMemories(savedConfig.destination?.memories ?? false);
          }
          setUseSaved(checked);
        }} disabled={busy} />
        {useSaved && <Text size="sm">{savedConfig.model} · {t("audio.configRevision")}: {savedConfig.revision} · {savedConfig.retention.value} {t(savedConfig.retention.unit === "months" ? "audio.months" : "audio.days")} · {savedConfig.retention.timezone}</Text>}
        {useSaved && savedConfig.language && <Text size="sm">{t("audio.language")}: {savedConfig.language}</Text>}
        {useSaved && savedConfig.postprocess && <Text size="sm">{t("audio.writer")}: {savedConfig.postprocess.projectName}</Text>}
        {useSaved && savedConfig.destination && <Text size="sm">{t("audio.destination")}: {savedConfig.destination.serverName} · {savedConfig.destination.documents ? t("audio.saveDocuments") : ""} {savedConfig.destination.memories ? t("audio.saveMemories") : ""}</Text>}
        {!savedConfig.enabled && <Alert>{t("audio.configDisabled")}</Alert>}
      </>}
        <FileInput label={t("audio.file")} placeholder={t("audio.chooseFile")} description="MP3, WAV, FLAC, Ogg" accept=".mp3,.wav,.flac,.ogg" value={file} onChange={(file) => { setFile(file); setUploaded(null); }} clearable disabled={busy} />
      {uploaded && <Text component="a" size="sm" href={`${base}/source-files/${uploaded.file.id}`}>{t("audio.uploadedFile")}: {uploaded.file.filename}</Text>}
      {!useSaved && <>
        <Select label={t("audio.model")} searchable data={options.models.map((model) => ({ value: model.id, label: `${model.displayName} · ${model.id}` }))} value={model} onChange={setModel} disabled={busy} />
        <TextInput label={t("audio.language")} placeholder="ko, en" value={language} onChange={(e) => setLanguage(e.currentTarget.value)} maxLength={3} disabled={busy} />
      <SimpleGrid cols={{ base: 1, sm: 3 }}>
        <NumberInput label={t("audio.retention")} min={1} allowDecimal={false} value={duration} onChange={setDuration} disabled={busy} />
        <Select label={t("audio.retentionUnit")} data={[{ value: "days", label: t("audio.days") }, { value: "months", label: t("audio.months") }]} value={unit} onChange={setUnit} allowDeselect={false} disabled={busy} />
        <TextInput label={t("audio.timezone")} value={timezone} onChange={(e) => setTimezone(e.currentTarget.value)} disabled={busy} />
      </SimpleGrid>
      <SimpleGrid cols={{ base: 1, sm: 2 }}>
        <Select label={t("audio.writer")} clearable searchable value={writer} onChange={setWriter} disabled={busy}
          data={projects.filter(project => project.ownerEmail === viewer?.email && project.configured)
            .map(project => ({ value: project.name, label: project.displayName }))} />
      </SimpleGrid>
      <Select label={t("audio.destination")} description={t("audio.destinationHint")} clearable value={destination} onChange={setDestination} data={options.destinations} disabled={busy} />
      {destination && <Group><Checkbox label={t("audio.saveDocuments")} checked={documents} onChange={(e) => setDocuments(e.currentTarget.checked)} disabled={busy} />
        <Checkbox label={t("audio.saveMemories")} checked={memories} onChange={(e) => setMemories(e.currentTarget.checked)} disabled={busy || !writer} /></Group>}
      </>}
      <Group justify="space-between"><Text size="sm" c="dimmed">{t("audio.personalOnly")}</Text>
        <Button loading={busy} disabled={!file || !validProcessing || savedConfig?.enabled === false} onClick={submit}>{t("audio.submit")}</Button></Group>
      <details><Text component="summary">{t("audio.projectConfig")}</Text><Stack mt="sm">
        <Checkbox label={t("audio.configEnabled")} checked={configEnabled} onChange={(e) => setConfigEnabled(e.currentTarget.checked)} disabled={busy} />
        <SimpleGrid cols={{ base: 1, sm: 2 }}>
          <NumberInput label={t("audio.maxActive")} value={maxActive} onChange={setMaxActive} min={1} max={MAX_ACTIVE_AUDIO_JOBS} allowDecimal={false} disabled={busy} />
          <NumberInput label={t("audio.maxPerOccurrence")} value={maxPerOccurrence} onChange={setMaxPerOccurrence} min={1} max={MAX_ACTIVE_AUDIO_JOBS} allowDecimal={false} disabled={busy} />
        </SimpleGrid>
        <Text size="sm" c="dimmed">{t("audio.saveConfigHint")}</Text>
        <Button onClick={saveConfiguration} loading={busy} disabled={!validProcessing || !Number.isInteger(maxActive) || !Number.isInteger(maxPerOccurrence)}>{t("audio.saveConfig")}</Button>
      </Stack></details>
    </Stack></Paper>
    <SectionHeading title={t("audio.jobs")}><Button variant="default" loading={loadingJobs} onClick={() => refresh().catch((error) => setError(error.message))}>{t("audio.refresh")}</Button></SectionHeading>
    {jobs.some((job) => !isAudioJobTerminal(job.status)) && <Text size="xs" c="dimmed">{t("audio.pollingHint")}</Text>}
    {!loadingJobs && !jobs.length && <Text c="dimmed">{t("audio.noJobs")}</Text>}
    {jobs.map((job) => <Paper key={job.id} withBorder p="md"><Stack gap="xs">
      <Group justify="space-between"><Text ff="monospace" size="sm">{job.id}</Text><Badge>{t(`audio.status.${job.status}`)}</Badge></Group>
      <Text size="sm" fw={600}>{t(`audio.task.${job.task ?? "process"}`)} · {t(`audio.stage.${job.stage}`)}</Text>
      <Text size="sm" c="dimmed">{job.model} · {t("audio.updatedAt")}: {formatDateTime(job.updatedAt, locale)}</Text>
      <Text size="sm" c="dimmed">{t("audio.createdAt")}: {formatDateTime(job.createdAt, locale)} · {t("audio.attempt", { count: job.attempt })}</Text>
      {job.status === "running" && <Text size="sm">{t(`audio.activity.${job.stage}`)}</Text>}
      {job.status === "queued" && <Text size="sm" c="dimmed">{t("audio.queuedHint")}</Text>}
      {job.status === "waiting" && <Text size="sm">{t(job.errorCode ? "audio.retryHint" : "audio.deliveryWaitHint")}</Text>}
      {job.fileInfo && <Text size="sm">{job.fileInfo.filename} · {t("audio.expiresAt")}: {formatDateTime(job.fileInfo.expiresAt, locale)}</Text>}
      {job.transcriptionProgress && <Stack gap={4}>
        <Text size="sm">{t("audio.coverage")}: {job.transcriptionProgress.processedSeconds.toFixed(1)} / {job.transcriptionProgress.totalSeconds.toFixed(1)} {t("audio.seconds")} · {t("audio.completedSegments", { count: job.transcriptionProgress.completedSegments })}</Text>
        {job.transcriptionProgress.totalSeconds > 0 && <>
          <Progress aria-label={t("audio.coverage")} value={Math.min(100, job.transcriptionProgress.processedSeconds / job.transcriptionProgress.totalSeconds * 100)} />
          <Text size="xs" c="dimmed">{Math.min(100, Math.floor(job.transcriptionProgress.processedSeconds / job.transcriptionProgress.totalSeconds * 100))}%</Text>
        </>}
      </Stack>}
      {job.postprocessProgress && <Stack gap={4}>
        <Text size="sm">{t(`audio.postprocess.${job.postprocessProgress.phase}`)}{job.postprocessProgress.phase === "reduce" ? ` · ${t("audio.round", { count: job.postprocessProgress.round })}` : ""} · {t("audio.completedParts", { count: job.postprocessProgress.completed, total: job.postprocessProgress.total })}</Text>
        {job.postprocessProgress.total > 0 && <Progress aria-label={t(`audio.postprocess.${job.postprocessProgress.phase}`)} value={Math.min(100, job.postprocessProgress.completed / job.postprocessProgress.total * 100)} />}
      </Stack>}
      {job.status === "waiting" && <Text size="sm" c="dimmed">{t("audio.resumeAt")}: {formatDateTime(job.dueAt, locale)}</Text>}
      {job.errorCode && <Text c="red" size="sm">{job.errorCode}</Text>}
      {job.movedTo && <Text size="sm">{t("audio.moved")}: {job.movedTo.serverName}</Text>}
      {Object.keys(job.receipts).some((key) => key.startsWith("document:") || key.startsWith("memory:")) && <details>
        <Text component="summary" size="sm">{t("audio.receipts")}</Text>
        <Stack gap={4} mt="xs">
          <Text size="xs" c="dimmed">{t("audio.receiptsHint")}</Text>
          {Object.entries(job.receipts).filter(([key]) => key.startsWith("document:") || key.startsWith("memory:")).map(([key, id]) =>
            <Text key={key} size="xs" style={{ overflowWrap: "anywhere" }}>
              {key === "document:transcript" ? t("audio.transcript") : key === "document:result" ? t("audio.result") : "Memory"} · {id}
            </Text>)}
        </Stack>
      </details>}
      {job.unavailableArtifacts && <Text size="sm" c="dimmed">{t("audio.unavailableArtifacts")}</Text>}
      <Group gap="xs">
        {job.artifactLinks.source && <Button component="a" href={job.artifactLinks.source} variant="light" size="xs">{t("audio.original")}</Button>}
        {job.artifactLinks.transcript && <Button component="a" href={job.artifactLinks.transcript} variant="light" size="xs">{t("audio.transcript")}</Button>}
        {job.artifactLinks.processed && <Button component="a" href={job.artifactLinks.processed} variant="light" size="xs">{t("audio.result")}</Button>}
        {job.artifactLinks.dialogue && <Button component="a" href={job.artifactLinks.dialogue} variant="light" size="xs">{t("audio.dialogue")}</Button>}
        {(job.status === "failed" || job.status === "blocked") && <Button size="xs" variant="default" disabled={busy} onClick={() => act(job, "retry")}>{t("audio.retry")}</Button>}
        {isAudioJobTerminal(job.status) && <Button size="xs" variant="subtle" color="red" disabled={busy} onClick={() => act(job, "delete")}>{t("audio.delete")}</Button>}
        {["queued", "running", "waiting"].includes(job.status) && <Button size="xs" variant="subtle" color="red" disabled={busy} onClick={() => act(job, "cancel")}>{t("audio.cancel")}</Button>}
      </Group>
    </Stack></Paper>)}
    {next && <Button variant="subtle" disabled={loadingJobs} onClick={() => refresh(next).catch((error) => setError(error.message))}>{t("audio.more")}</Button>}
  </Stack>;
}

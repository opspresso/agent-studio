import {
  isAudioJobTerminal, MAX_ACTIVE_AUDIO_JOBS,
  type AudioJob, type AudioJobRepository,
} from "@/domain/audio/job";
import { keys } from "../keys";
import { projectIsLive } from "../projectLifecycle";
import {
  conditions, getItem, queryItems, transact,
  CONDITIONAL_WRITE_FAILED, TRANSACTION_CANCELLED, type Item, type TransactOp,
} from "../store";

function lostCondition(error: unknown): boolean {
  return error instanceof Error && [CONDITIONAL_WRITE_FAILED, TRANSACTION_CANCELLED].includes(error.name);
}

function jobOf(item: Item | null): AudioJob | null {
  return item ? item.job as AudioJob : null;
}

function row(job: AudioJob): Item {
  return {
    ...keys.audioJob(job.projectName, job.id), entityType: "AudioJob", job, userEmail: job.userEmail,
  };
}

function owned(current: AudioJob | null, expected: AudioJob, now: string): boolean {
  return current !== null && current.status === "running" && current.revision === expected.revision &&
    !!expected.lease && current.lease?.token === expected.lease.token && current.lease.until > now;
}

function checkLimit(value: number): void {
  if (!Number.isInteger(value) || value < 1 || value > MAX_ACTIVE_AUDIO_JOBS) {
    throw new Error(`Audio job limit must be between 1 and ${MAX_ACTIVE_AUDIO_JOBS}`);
  }
}

function activeIds(item: Item | null): string[] {
  return item?.jobIds as string[] | undefined ?? [];
}

/** Only the queue head is indexed, so a busy project's backlog cannot starve other projects. */
function queueRow(projectName: string, jobIds: string[], dueAt: string): Item {
  return { ...keys.audioJobSlots(projectName), entityType: "AudioJobQueue", projectName, jobIds,
    ...(jobIds[0] ? { dueAt, ...keys.audioJobDueIndex(dueAt, projectName, jobIds[0]) } : {}) };
}

/** Admission appends to the bounded project queue; execution claims only its head. */
function reserve(projectName: string, id: string, limit: number, now: string): TransactOp {
  return { kind: "update", key: keys.audioJobSlots(projectName),
    condition: (item) => activeIds(item).length < limit && !activeIds(item).includes(id),
    patch: (item) => queueRow(projectName, [...activeIds(item), id],
      activeIds(item).length ? item!.dueAt as string : now) };
}

function release(projectName: string, id: string, now: string): TransactOp {
  return { kind: "update", key: keys.audioJobSlots(projectName),
    condition: (item) => activeIds(item).includes(id),
    patch: (item) => queueRow(projectName, activeIds(item).filter((held) => held !== id),
      activeIds(item)[0] === id ? now : item!.dueAt as string) };
}

function advanceQueue(projectName: string, id: string, dueAt: () => string): TransactOp {
  return { kind: "update", key: keys.audioJobSlots(projectName),
    condition: (item) => activeIds(item)[0] === id,
    patch: (item) => queueRow(projectName, activeIds(item), dueAt()) };
}

export const audioJobRepository: AudioJobRepository = {
  async submit(input, admission) {
    checkLimit(admission.maxActive);
    checkLimit(admission.maxPerOccurrence);
    const sourceKey = keys.audioJobSource(input.projectName, input.sourceKey);
    const previous = await getItem(sourceKey);
    if (previous) {
      const job = await this.get(input.projectName, previous.jobId as string);
      // A concurrent explicit deletion can remove the job after its source claim was read.
      if (!job) return { status: "busy", reason: "conflict" };
      return { status: "duplicate", job };
    }
    const job: AudioJob = {
      ...input, id: admission.id, revision: 1, status: "queued", stage: "importing",
      createdAt: admission.now, updatedAt: admission.now, dueAt: admission.now, attempt: 0, failures: 0, receipts: {},
    };
    try {
      await transact([
        { kind: "check", key: keys.project(input.projectName), condition: projectIsLive },
        { kind: "put", item: row(job), condition: conditions.notExists },
        { kind: "put", item: { ...sourceKey, jobId: job.id }, condition: conditions.notExists },
        reserve(input.projectName, job.id, admission.maxActive, admission.now),
        { kind: "update", key: keys.audioJobOccurrence(input.projectName, admission.occurrence),
          condition: (current) => Number(current?.count ?? 0) < admission.maxPerOccurrence,
          patch: (current) => ({ count: Number(current?.count ?? 0) + 1 }) },
      ]);
      return { status: "accepted", job };
    } catch (error) {
      if (!lostCondition(error)) throw error;
      const winner = await getItem(sourceKey);
      if (winner) {
        const existing = await this.get(input.projectName, winner.jobId as string);
        if (!existing) return { status: "busy", reason: "conflict" };
        return { status: "duplicate", job: existing };
      }
    }
    const [occurrence, slots] = await Promise.all([
      getItem(keys.audioJobOccurrence(input.projectName, admission.occurrence)),
      getItem(keys.audioJobSlots(input.projectName)),
    ]);
    return { status: "busy", reason: Number(occurrence?.count ?? 0) >= admission.maxPerOccurrence ? "occurrence_limit"
      : activeIds(slots).length >= admission.maxActive ? "active_limit" : "conflict" };
  },

  async get(projectName, id) { return jobOf(await getItem(keys.audioJob(projectName, id))); },

  async list(projectName, limit, after, userEmail) {
    checkLimit(limit);
    return (await queryItems({ pk: keys.projectPartition(projectName), sk: { prefix: keys.audioJobPrefix() },
      limit, ...(after ? { after: keys.audioJob(projectName, after).SK } : {}),
      ...(userEmail ? { filter: { userEmail } } : {}) })).map((item) => jobOf(item)!);
  },

  async due(now, limit) {
    checkLimit(limit);
    const queues = await queryItems({ index: "GSI1", ...keys.audioJobDueQuery(now), limit });
    const heads = await Promise.all(queues.map((item) => this.get(item.projectName as string, activeIds(item)[0]!)));
    return heads.filter((job): job is AudioJob => job !== null && !isAudioJobTerminal(job.status) && job.dueAt <= now);
  },

  async claim(projectName, id, now, token, until) {
    if (!token || until <= now) throw new Error("Audio job lease must expire in the future");
    try {
      let next: AudioJob | null = null;
      await transact([
        { kind: "update", key: keys.audioJob(projectName, id), patch: (item) => {
          const job = jobOf(item)!;
          next = { ...job, status: "running", revision: job.revision + 1, attempt: job.attempt + 1,
            startedAt: job.startedAt ?? now, lease: { token, until }, dueAt: until, updatedAt: now };
          return row(next);
        }, condition: (item) => {
          const job = jobOf(item);
          return job !== null && !isAudioJobTerminal(job.status) && job.dueAt <= now &&
            (!job.lease || job.lease.until <= now);
        } },
        advanceQueue(projectName, id, () => until),
      ]);
      return next;
    } catch (error) { if (lostCondition(error)) return null; throw error; }
  },

  async heartbeat(job, now, until) {
    if (until <= now) throw new Error("Audio job lease must expire in the future");
    try {
      await transact([
        { kind: "update", key: keys.audioJob(job.projectName, job.id), patch: (item) => {
          const current = jobOf(item)!;
          return row({ ...current, lease: { token: current.lease!.token, until }, dueAt: until, updatedAt: now });
        }, condition: (item) => owned(jobOf(item), job, now) },
        advanceQueue(job.projectName, job.id, () => until),
      ]);
      return true;
    } catch (error) { if (lostCondition(error)) return false; throw error; }
  },

  async checkpoint(job, patch, now) {
    const terminal = isAudioJobTerminal(patch.status);
    let next: AudioJob | null = null;
    try {
      await transact([
        { kind: "update", key: keys.audioJob(job.projectName, job.id),
          condition: (item) => owned(jobOf(item), job, now),
          patch: (item) => {
            const current = jobOf(item)!;
            next = { ...current, ...patch, revision: current.revision + 1, updatedAt: now,
              receipts: { ...current.receipts, ...patch.receipts } };
            if (patch.status !== "running") delete next.lease;
            else next.dueAt = current.lease!.until;
            return row(next);
          } },
        terminal ? release(job.projectName, job.id, now) : advanceQueue(job.projectName, job.id, () => next!.dueAt),
      ]);
      return next;
    } catch (error) { if (lostCondition(error)) return null; throw error; }
  },

  async cancel(projectName, id, revision, now) {
    const job = await this.get(projectName, id);
    if (!job || job.revision !== revision || isAudioJobTerminal(job.status)) return false;
    const next: AudioJob = { ...job, status: "cancelled", revision: revision + 1, updatedAt: now };
    delete next.lease;
    try {
      await transact([
        { kind: "put", item: row(next), condition: (item) => {
          const current = jobOf(item);
          return current !== null && current.revision === revision && !isAudioJobTerminal(current.status);
        } },
        release(projectName, id, now),
      ]);
      return true;
    } catch (error) { if (lostCondition(error)) return false; throw error; }
  },

  async delete(projectName, id, revision) {
    const job = await this.get(projectName, id);
    if (!job || job.revision !== revision || !isAudioJobTerminal(job.status)) return false;
    try {
      await transact([
        { kind: "delete", key: keys.audioJob(projectName, id), condition: (item) => {
          const current = jobOf(item);
          return current !== null && current.revision === revision && isAudioJobTerminal(current.status);
        } },
        { kind: "delete", key: keys.audioJobSource(projectName, job.sourceKey),
          condition: (item) => item === null || item.jobId === id },
      ]);
      return true;
    } catch (error) { if (lostCondition(error)) return false; throw error; }
  },

  async retry(projectName, id, revision, now, maxActive) {
    checkLimit(maxActive);
    const job = await this.get(projectName, id);
    if (!job || job.revision !== revision || !["blocked", "failed"].includes(job.status)) return null;
    const next: AudioJob = { ...job, status: "queued", revision: revision + 1, updatedAt: now, dueAt: now, failures: 0, retryStartedAt: now };
    delete next.lease;
    delete next.errorCode;
    delete next.startedAt;
    try {
      await transact([
        { kind: "check", key: keys.project(projectName), condition: projectIsLive },
        { kind: "put", item: row(next), condition: (item) => jobOf(item)?.revision === revision },
        reserve(projectName, id, maxActive, now),
      ]);
      return next;
    } catch (error) { if (lostCondition(error)) return null; throw error; }
  },
};

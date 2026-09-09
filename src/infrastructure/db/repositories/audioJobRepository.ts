import {
  isAudioJobTerminal, MAX_ACTIVE_AUDIO_JOBS,
  type AudioJob, type AudioJobRepository,
} from "@/domain/audio/job";
import { keys } from "../keys";
import { projectIsLive } from "../projectLifecycle";
import {
  conditions, getItem, queryItems, transact, updateItem,
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
    ...(!isAudioJobTerminal(job.status) ? keys.audioJobDueIndex(job.dueAt, job.projectName, job.id) : {}),
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

/** One bounded ledger makes changes to the concurrency limit atomic too. */
function reserve(projectName: string, id: string, limit: number): TransactOp {
  return { kind: "update", key: keys.audioJobSlots(projectName),
    condition: (item) => activeIds(item).length < limit && !activeIds(item).includes(id),
    patch: (item) => ({ jobIds: [...activeIds(item), id] }) };
}

function release(projectName: string, id: string): TransactOp {
  return { kind: "update", key: keys.audioJobSlots(projectName),
    condition: (item) => activeIds(item).includes(id),
    patch: (item) => ({ jobIds: activeIds(item).filter((held) => held !== id) }) };
}

export const audioJobRepository: AudioJobRepository = {
  async submit(input, admission) {
    checkLimit(admission.maxActive);
    checkLimit(admission.maxPerOccurrence);
    const sourceKey = keys.audioJobSource(input.projectName, input.sourceKey);
    const previous = await getItem(sourceKey);
    if (previous) {
      const job = await this.get(input.projectName, previous.jobId as string);
      if (!job) throw new Error("Audio job source claim has no job");
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
        reserve(input.projectName, job.id, admission.maxActive),
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
        if (!existing) throw new Error("Audio job source claim has no job");
        return { status: "duplicate", job: existing };
      }
    }
    return { status: "busy" };
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
    return (await queryItems({ index: "GSI1", ...keys.audioJobDueQuery(now), limit })).map((item) => jobOf(item)!);
  },

  async claim(projectName, id, now, token, until) {
    if (!token || until <= now) throw new Error("Audio job lease must expire in the future");
    try {
      const { after } = await updateItem(keys.audioJob(projectName, id), (item) => {
        const job = jobOf(item)!;
        return row({ ...job, status: "running", revision: job.revision + 1, attempt: job.attempt + 1,
          lease: { token, until }, dueAt: until, updatedAt: now });
      }, (item) => {
        const job = jobOf(item);
        return job !== null && !isAudioJobTerminal(job.status) && job.dueAt <= now &&
          (!job.lease || job.lease.until <= now);
      });
      return jobOf(after);
    } catch (error) { if (lostCondition(error)) return null; throw error; }
  },

  async heartbeat(job, now, until) {
    if (until <= now) throw new Error("Audio job lease must expire in the future");
    try {
      await updateItem(keys.audioJob(job.projectName, job.id), (item) => {
        const current = jobOf(item)!;
        return row({ ...current, lease: { token: current.lease!.token, until }, dueAt: until, updatedAt: now });
      }, (item) => owned(jobOf(item), job, now));
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
        ...(terminal ? [release(job.projectName, job.id)] : []),
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
        release(projectName, id),
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
    try {
      await transact([
        { kind: "check", key: keys.project(projectName), condition: projectIsLive },
        { kind: "put", item: row(next), condition: (item) => jobOf(item)?.revision === revision },
        reserve(projectName, id, maxActive),
      ]);
      return next;
    } catch (error) { if (lostCondition(error)) return null; throw error; }
  },
};

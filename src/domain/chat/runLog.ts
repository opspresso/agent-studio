/**
 * A chat run's replay log: what a reader who lost the connection catches up from.
 *
 * A run outlives the request that started it, so the answer keeps arriving with
 * nobody reading it. The log is what makes that visible again — the frames the
 * departed reader would have received, kept just long enough for it to come back.
 *
 * It is **not** the record of the conversation. That is the chat's messages,
 * written when the run finishes; this expires within the hour and is read by one
 * reader, once. Two consequences shape it:
 *
 * - **Written only after the reader leaves.** While someone is attached they are
 *   already seeing every frame, so writing them down as well would cost a
 *   DynamoDB write per half-second of every run for the sake of the few that get
 *   abandoned. The tee buffers instead, and flushes what it has the moment the
 *   connection drops.
 * - **Frames come in batches.** One row carries several, because the flush at
 *   the moment of detach is the whole run so far and a row per frame would make
 *   the reader wait on a hundred writes.
 */

/** A batch of a run's frames, as one stored row. */
export interface RunLogEntry {
  /** Position in the run's log, dense and ascending from 0. */
  seq: number;
  /** JSON array of the frames this batch carries. Empty on the terminal entry. */
  payload: string;
  /** Present exactly once, on the last entry: the run is over. */
  terminal?: true;
  /** What ended it, when that was an error. Only ever set on the terminal entry. */
  error?: string;
}

export interface ChatRunLogRepository {
  /** Append entries, which must carry the sequence numbers they are stored at. */
  append(chatId: string, runId: string, entries: RunLogEntry[]): Promise<void>;
  /** Every entry from `fromSeq` on, oldest first. */
  read(chatId: string, runId: string, fromSeq: number): Promise<RunLogEntry[]>;
}

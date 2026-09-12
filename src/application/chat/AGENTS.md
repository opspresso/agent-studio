# Chat application

Chat use cases orchestrate injected `ChatDeps`. The route wiring binds the execution facade;
there are no framework, adapter or composition-root imports here. Read
[design/chat.md](../../../docs/design/chat.md) and `../runtime/AGENTS.md` when changing persistence.

## Ownership

- `run.ts` resolves the runnable version, folds display output and persists it.
- `runLease.ts` claims one active run per chat; `runLog.ts` owns terminal logging and release.
- `replayRunLog.ts` replays/follows a detached run; `cancelRun.ts` persists and polls cancellation.
- `approval.ts` checks chat ownership/project access, claims the lease and resumes or discards
  an SDK checkpoint. `application/runtime/session.ts` owns native history, CAS and approval state.
- `resolveImages.ts` and `resolveFiles.ts` sign references for the reader. Neither rebuilds model
  context. `messageList.ts` owns bounded display history reads.

## Run and connection

- A run outlives its initiating browser connection. Routes keep the detach wrapper outermost;
  connection loss starts log recording and does not abort the run. An explicit stop persists
  cancellation and the running side polls it, including while no model chunks arrive.
- Ordering is **persist → terminal entry → release the lease**. Only `runLog.ts` releases a
  running lease. Setup failures before a run is returned release their own claim.
- Log rows are collection-windowed batches written after detachment. A connected run does not
  write its entire stream twice. A terminal log entry is written only when recording began.
- Source generators are lazy. Head frames precede the first pull, carrying `runId`, elapsed
  time, and the new turn's `userSeq` where one exists. Approval resume inserts no user turn.
  An `ended` frame distinguishes a complete stream from a severed connection.
- A stop is a warning persisted on the visible answer. Preserve the distinction between
  user stop and supersession. The run log must not turn either into a provider error.
- `withLeadingWarnings` pulls the source before reporting loss, preserving pre-run refusals.
- On a detached drain, persistence failures must not strand the run lease. Late output from
  a deleted chat cannot recreate its SDK history: deletion installs a Session tombstone first.

## Display records and SDK Session

- `createChat` and `sendMessage` pass only the new user input to execution. Native SDK Session
  items are the sole model history. Do not reconstruct turns from flattened `ChatMessage` rows.
  Memory recall is an independent Context capability, not a Session persistence mechanism.
- `runAndPersist` keeps the top-level visible answer and reasoning, tool rows and artifact
  references. Store top-level tool calls on the assistant message; authored child results remain
  visible with author metadata. A call-only assistant turn is worth persisting for approval UI.
- Within-turn display storage is tool rows followed by the assistant row. UI pairing preserves
  call IDs and run/author scope; provider wire order is owned separately by native SDK items.
- Native reasoning stays on its own SDK model turn regardless of display recording. The
  flattened display reasoning is never fed back to the model as if it were one model turn.
- Answer and reasoning share one item-size budget. Tool output and argument bounds are applied
  at the runtime boundary. Do not truncate tool arguments into a different executable request.
- Keep Session history/image/storage budgets in `application/runtime`, separate from bounded
  sidebar/thread reads and the short-lived reconnect log. Every context omission is reported.
- A pending approval disables new sends. Resume checks the exact revision and decision IDs;
  the runtime claims the checkpoint before any effect. A changed version or binding is refused.
  A crashed approved run has an uncertain outcome and is never automatically replayed.
- Discard refuses a live lease, keeps display records and removes the unfinished run from model
  context. Reads and mutations treat every non-owner as 404. Resume rechecks project access.

## Attachments and output

- Receiving surfaces extract documents once through `DocumentExtractor`/`documentParts` and
  send bounded framed text to the SDK. The native Session retains that exact input on later turns.
- New image attachments carry bounded inline bytes. SDK Session retains the newest model
  images and image-edit handles; remote URLs never become provider-managed fetches.
- The run bracket captures generated image/file bytes. Chat stores references and signs them
  per reader. Original attachments go through the artifact use case with their user actor.
- Files and images are separate axes. Files do not enter model context. A file-only run must
  persist its message; a failed file store reports that no download exists.
- Artifact storage absence/failure is visible. Session model bytes do not provide a downloadable
  artifact or a durable display URL. Reader-facing signatures use the shared URL lifetime.
- Display document reads omit extracted text and return name, note and signed original-file
  reference. The SDK Session, not a browser response, carries the model's document context.

Focused coverage: `chatApproval.test.ts`, `chatApprovalRoute.test.ts`, `runtimeSession.test.ts`,
`chat.test.ts`, `chatRunLog.test.ts`, `chatResume.test.ts`, `chatRunStore.test.ts`, `chatToolPairs.test.ts`.

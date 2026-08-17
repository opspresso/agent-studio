# Slack

Per-project bots: how a reply is delivered, which of the messages a bot receives are for it,
what a run may read of the workspace, and who the model is told is asking.

What those reads are allowed to hand back, and why the workspace tools are a per-version
opt-in, is [SECURITY.md](../SECURITY.md#reading-the-slack-workspace). Per-project settings
live on the project, not in the environment —
[CONFIGURATION.md](../CONFIGURATION.md#slack).

Bots are **per project**: `/api/slack/events/[project]` is the only events endpoint, and it
resolves that project's own bot token and signing secret, so an event always runs that project
and no selector is needed.

**How a reply is delivered is one decision, owned by `src/application/slack/replyStream.ts`.**
The sink it hands back opens on the first output and prefers `chat.startStream` →
`chat.appendStream` → `chat.stopStream`, which is what the agent surface renders as text
arriving and what Slack rate-limits generously (Tier 4). A workspace that cannot stream falls
back to `chat.postMessage` + `chat.update`, paced at Slack's documented one edit per three
seconds and marked with a trailing indicator so an interim state does not read as a finished
answer. Streaming sends **deltas**, so the sink advances its flushed offset only on a
successful write: a rejected append is re-sent with the next one instead of being lost.
Streaming into a channel additionally names the recipient (`recipient_user_id` /
`recipient_team_id`); a DM does not.

The **agent experience** is answered natively where the surface offers it (a DM, not a channel
thread): progress goes to `assistant.threads.setStatus` — "is thinking…", then each tool by
name — rather than overwriting the message body, and the opening question of a new thread names
it via `assistant.threads.setTitle`. The thinking status carries `loading_messages`, which Slack
rotates as an animated indicator, and **a heartbeat re-sends it every 45 seconds**: Slack expires
a status two minutes after it is set, and a run may take longer, so a status set once would
vanish while the agent was still working. The heartbeat runs on its own clock rather than on
chunk arrival, because the case it exists for — a slow provider, a long tool — is exactly the one
where no chunks arrive. Opening the agent container is its own event, handled by
`handleThreadStart` rather than by a run: `app_home_opened` on the Messages tab (the agent
messaging experience) pins the project's suggested prompts, and the legacy
`assistant_thread_started` also introduces the project, because unlike `app_home_opened` it
fires once per thread rather than on every visit. `app_context_changed` is deliberately not
subscribed to — acting on the channel a user is looking at needs per-user context storage that
does not exist. **A channel has no status line, but it is not without a
rendering** — a stream carries two independent axes, and progress goes on the other one. The
run reports what it is doing once; the sink picks the mechanism the surface has: a DM gets
`assistant.threads.setStatus`, a channel gets a `task_update` chunk on the open stream
(`task_display_mode: "timeline"`, declared at `chat.startStream` because it describes the
message rather than a chunk). Slack renders and animates that task, and the answer keeps
streaming into the same message's text.

It is a **checklist**: the ambient row ("is thinking…") under a constant id while the run is
still deciding, then a row **per tool** — opened when a call is announced, ticked off when its
result comes back. The ambient row closes as soon as the first step opens, because a row
spinning above a list that is visibly moving reads as a stuck run.

**Per tool, not per call**, and a subagent's calls get no row at all. A row per call is what a
checklist looks like before anyone uses it: five reads of the same channel became five identical
rows, and one hand-off became a row per tool the child ran — twenty rows for work a reader would
describe in three. So repeats collapse into one row that counts them (`SlackHistory ×5`), and the
parent's own `transfer_to_agent` row stands for the whole hand-off, closing when the child
returns. The decorated title a result carries is only shown while a row stands for a single
call; past that the count is what the row says, and one result's detail would misdescribe it.

A nested step still **moves a DM's status line**, which cannot accumulate and would otherwise sit
still through a long hand-off — a status that stops moving is how a working run comes to look
like a stuck one. Which is the sink's decision to make, not the caller's: same report, different
rendering.

**Only a real boundary may tick a row off**, which is the whole constraint. `status` has none —
a line changing means the run stopped saying something, not that it finished it — so a
checklist driven by status changes would claim the run completed things it merely stopped
mentioning. A tool result is a boundary, so steps close as the run goes; anything still open at
the end is closed on its own `chat.appendStream` just before the stop, since a step left
`in_progress` on a finished message reads as a run that never came back.

**A stream has a mode, and Slack decides it.** `chat.startStream` fixes whether the message
speaks `markdown_text` (a top-level argument) or `chunks`; the other one later is
`streaming_mode_mismatch`, and both on one call is
`cannot_provide_both_markdown_text_and_chunks`. A channel is therefore **always chunks** — its
progress rows are chunks and they open the message before any text exists — so the answer
travels as a `markdown_text` *chunk*, which is a listed chunk type and is how Slack means one
message to carry both axes. A DM has no rows and stays on the plain argument.

That was learned twice, in production both times, because `push` swallows a failed append: a
channel's every text append was rejected and only the final close ever logged, so the answer was
silently dropped and then re-posted by the fallback below as a plain message. The test fakes
enforce both rules now — passing tests had been accepting calls Slack rejects.

The close therefore carries the unfinished rows *and* the last of the answer in one call, since
in this mode both are chunks. If it fails anyway, whatever Slack never took is posted as a plain
message — that failure was silent for a release, and a reader had no way to tell a lost answer
from a slow one.

The two surfaces phrase the same step differently, and the sink owns that: a checklist row
stands alone and keeps the bare name (`Skill: deep-research`), while the DM's status line and
the text-note fallback need a verb, because Slack renders the line after the app's name
("AgentDure is using search…").

That shape is the fix for a deeper problem than the missing animation. Modelling status as *the
DM mechanism* left the channel nothing but text to imitate it with; text had to live in the
reply body; and a note in the reply could not be replaced by what it stood in for, because
`chat.appendStream` only ever adds. So every channel run that reported progress was pushed onto
edit-in-place and gave up streaming altogether — one edit per three seconds instead of a hundred
appends a minute, and none of Slack's native rendering. The axes are independent, so none of
that follows any more. The **text note survives as the fallback** for a workspace that cannot
stream at all, which is the only place it was ever the right answer. Either way, a run whose
answer never arrives as text (a picture, an upload) takes its message back rather than leave the
thread captioned as still working — closing the stream first, since deleting one Slack still
considers open leaves it mid-write.

Suggested prompts are per-project configuration (`SlackIntegration.suggestedPrompts`, at most
four — `src/domain/slack/types.ts` owns the shape and the cap). They reach Slack twice: in the
generated manifest's `features.agent_view`, and at runtime through
`assistant.threads.setSuggestedPrompts`. The runtime path is what lets a prompt change take
effect on its own, but it depends on the manifest: an app whose Slack config predates the
`app_home_opened` subscription never receives the event, so its prompts only ever come from the
manifest and changing them means applying the manifest again.

**Who is asking** reaches the model only when the version opts in
(`parameters.callerContext`). The opt-in gates the *lookup*, not just the prompt — a project
that did not ask does not send anyone's id to Slack's profile API either. With it on,
`users.info` resolves the asker through `callerFrom`, the single place a `RunCaller` is built
and its attacker-controlled name is made prompt-safe (name, timezone, avatar **URL**;
deliberately no email — see [SECURITY.md](../SECURITY.md#caller-context)). The engine renders it as
a caller block next to the run clock, and when a thread holds more than one human every turn —
including the newest — is prefixed with its speaker. One human needs no labels.

Resolution happens **after** the status line goes out and over **the turns that survived the
history slice**, not the whole thread Slack returned: a cold cache is several round trips, and
neither the acknowledgement nor a dropped turn should pay for them. Profiles are cached per
workspace, bounded in size (`src/infrastructure/slack/profileCache.ts`), and a failed lookup
costs the reply nothing.

A mention inside a thread carries the thread (its 50 most recent turns) as multi-turn context.
Image attachments are downloaded with the bot token — the mention's own images first, then
whatever budget is left goes to the newest images in the 10 most recent turns of the thread, so
"make the picture I sent blue" still has the picture without re-fetching a long thread's whole
history. Only humans' pictures count; the bot's own uploads are skipped, and anything skipped is
reported in the reply.

**Document attachments** are read into the turn as text (see [Attachments](chat.md#attachments)), and
only from the current message: a document is expensive to fetch and parse where an image is
not, and its text is already in the thread from the turn that sent it. A Slack file lives
behind `url_private` and needs this bot's token, which is why no URL-fetching MCP tool can
stand in for reading one. A file that is neither an image nor a readable document is the only
thing still reported as ignored.

Each download is bounded **while it is read** (`readBodyBytes`), with the cap passed per call
because an image's ceiling is not a document's. The size check beside it reads Slack's declared
`size`, which Slack may omit — so on its own it is a measurement taken once the memory is
already spent.

Events are deduplicated exactly-once via `slackEventRepository.claim` (a conditional put) whose
claim is a **lease** settled by `settle` — an instance that dies mid-processing leaves a
reclaimable claim rather than an event recorded as handled by nobody.

## Which events are for the bot

The app subscribes to `message.channels` and `message.groups`, so it receives **every message in
every channel it was invited to** — not the workspace, but far more than is for it. Deciding
which of those to answer is one function, `classifySlackEvent`
(`src/application/slack/engagement.ts`), and **it runs in the route ahead of the dedup claim**.
That ordering is the cost contract: a message nobody addressed costs a signature check and
nothing else — no write, no run, and no reply that would have to be taken back. It is also what
answers *a run that decides not to answer*: a channel run opens its reply as a progress note the
moment it starts, so a decision made inside the run could only ever retract something already on
screen. Made here it is not a run at all.

The funnel, in order:

1. **the bot's own message** — first, because everything below can start a run, and with
   `message.channels` subscribed the bot's own reply lands in a thread it is engaged in, which is
   the one shape that answers itself forever. `bot_id` is not enough on its own (a file shared
   through the external upload flow is attributed to the bot *user*), so the app's own id from
   `authorizations` is checked too;
2. **an `app_mention`** — always answered;
3. **a DM** — every message in one is addressed to the bot, mention or not;
4. **a thread the bot already answered in** — the only branch that needs storage;
5. **a keyword the project named** (`SlackIntegration.channelKeywords`, case-insensitive
   substring — substring because Korean glues particles onto nouns and a word-boundary rule would
   never fire);
6. otherwise nothing.

Only step 4 costs a read, and only a *reply* reaches it: ordinary channel traffic carries no
`thread_ts` and is dropped by step 6 without touching the database. Engagement is a row per
channel thread (`slackThreadRepository`) with a day-long window
(`SLACK_ENGAGEMENT_TTL_SECONDS`) refreshed on every reply, written after the reply because that
is what makes it true. A DM writes none — every message in one already qualifies.

**A channel mention arrives twice**, once as `app_mention` and once as the `message.channels` the
same text produces, under two event ids the claim cannot join. The mention is the canonical
delivery, so the `message` copy is dropped. This is applied to channels only: whether
`app_mention` also fires in a DM is not something the gate depends on.

## Commands, and being told to stop

Three messages are answered without a run: `!help`, `!mute` and `!unmute`. Answered directly
because the answer is a constant, and because two of them change *whether the bot speaks again*
— which no amount of prompting makes reliable. A person silencing a thread has to be obeyed,
not interpreted. That is also why a command has to stand alone: `!mute this thread please` is an
ordinary request, since guessing at intent is how the bot stops answering somebody who never
asked it to.

`!mute` sets a flag on the same engagement row, which `isEngaged` reads — so a muted thread
falls out of the funnel at step 4 and costs nothing more. **Muting needs no opposite to undo
it**: `markEngaged` clears the flag and runs after every ordinary reply, so a direct mention
brings the bot back on its own. Muting is per thread; a top-level `!mute` is answered with where
to put it rather than with silence, and in a DM it is answered with the fact that a DM answers
everything.

Commands are handled *ahead of the project lookup*, because `!mute` has to work on a bot that is
currently failing — which is exactly when someone reaches for it.

## Saying it was picked up

A channel run reacts to the message it started from (`:eyes:`) before anything else. A reply
lives in a thread, which is somewhere nobody is necessarily looking yet, and several people may
be talking at once — so the only acknowledgement that says *this message, and I have it* is one
on the message itself. It matters most where nothing was addressed to the bot explicitly. A DM
gets none: every message there is for the bot and the thread has a native status line.

Never fatal, and not even a warning in the reply: the run answering is a louder acknowledgement
than the one that failed.

## Reading the workspace

A version may opt into six read-only tools (`parameters.slackWorkspace`): `SlackHistory`,
`SlackThread`, `SlackUser`, `SlackUsers`, `SlackChannels` and `SlackReactions`. The bot already
holds the scopes; what was missing was a way for a *run* to spend them.

Two of them exist because **Slack addresses everything by id while people use names**:
`SlackChannels` turns `#deploy` into a channel id, and `SlackUsers` does the same for a person —
by walking `users.list` and filtering, since a bot gets no name search. That walk is bounded and
*says when it stopped*, because a search that quietly missed someone is worse than one that
admits it. `SlackReactions` is there because a team often answers with an emoji rather than a
reply, so "who has seen this" is unanswerable from a transcript alone.

`SlackUser` returns the whole profile — name, job title, timezone, the status line where
"OOO until Friday" lives, the avatar, and whether the account is an app or deactivated. The
caller block gets a narrower view of the same lookup: it is spliced into the system prompt on
every turn, so it carries the least that identifies someone, while a tool result is asked for
once. **One `users.info` answers both**, and the cache holds the wider one — caching the
narrower would make a project using caller context and this tool fetch the same person twice.

The engine routes all six names to one injected reader
(`AgentCapabilityDeps.readSlack`), which holds the bot token — so *which* workspace is read is
never the model's to choose. The composition root binds it: resolving a project's token is the
Slack slice's knowledge, and reaching for it from execution makes the two slices mutually
dependent, which `tests/architecture.test.ts` refuses. `SlackReaderPort`
(`src/domain/slack/reader.ts`) is the read half both sides can name, and `SlackClientPort`
extends it rather than restating it.

What the tools may hand back is bounded twice over — see
[SECURITY.md](../SECURITY.md#reading-the-slack-workspace).


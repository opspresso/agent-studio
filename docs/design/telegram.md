# Telegram

Per-project bots on the shared [messaging pipeline](messaging.md): how a reply is delivered
where nothing streams, which of the updates a bot receives are for it, and how a follow-up
carries the question before it when the platform hands back no history.

The credentials and the webhook are per project, like Slack's — [API.md](../API.md#registry-and-integration-operations)
has the settings endpoints and what the events endpoint answers; how the webhook is
authenticated is [SECURITY.md](../SECURITY.md#request-authentication-for-machine-callers).

Bots are **per project**: `/api/telegram/webhook/[project]` is the only endpoint, registered
with Telegram by the settings page together with a secret token this platform mints
(`adg_…`); Telegram echoes it on every delivery, and that echo is the whole authentication.
The bot's own `@username` is learned from `getMe` when the token is saved and stored beside
it, because it is what tells a mention of *this* bot in a group from a mention of anyone
else — and its user id is the number in front of the colon of every bot token, so a reply
to one of the bot's messages is recognised without a round trip.

## Delivering a reply

**Telegram has one way to put a growing answer on screen: send a message, then edit it.**
There is no streaming call and no status line; what it offers instead is the typing
indicator, which lasts five seconds and says only that the bot is doing something. So
progress is the typing indicator kept alive on its own clock (`keepStatusAlive`, every four
seconds — the case it exists for, a slow provider or a long tool, is exactly the one where
no chunks arrive), and the answer is a message edited in place, paced at one edit per two
seconds because Telegram documents about one message a second per chat and refuses bursts.
`step` and `stepDone` render as the same indicator; what the run is doing shows up in the
answer.

Two of Telegram's limits shape the rest, and both are owned by
`src/application/telegram/replyChannel.ts`:

- **A message holds 4,096 characters.** A longer answer becomes several messages, each
  opened as the one before it fills — the reader watches the answer continue rather than
  stop — cut at the last line break in the final 800 characters of the window where there is
  one, so a paragraph is not split mid-sentence unless the paragraph itself is longer than a
  message. Only the first message quotes the question. A message still being written ends
  in a cursor, so a reader arriving mid-run does not take a sentence that stops halfway for
  the whole answer; the final write removes it.
- **A message is rendered from HTML, strictly.** An unknown tag, an unbalanced one, or a bare
  `<` refuses the whole message, and there is no partial rendering. The answer therefore
  streams as plain text and is rendered **once, at the end** (`markdown.ts` — bold, italic,
  strikethrough, code spans and fences, links to `http(s)` only, headings as bold, bullets as
  bullets; everything else escaped and left as written); if Telegram refuses the rendered
  version, the plain one is sent instead. Formatting can be lost that way; the answer
  cannot. Every write that fails at the close is posted on its own rather than lost — that
  failure was silent for a whole release on the Slack surface, and a reader had no way to
  tell a lost answer from a slow one.

The tail is Markdown like the answer, because it is rendered with it in one pass: a produced
file is a `📎 [name](url)` link, a warning a `⚠️` line. A picture is `sendPhoto` with the
prompt as its caption.

## Which updates are for the bot

One function, `classifyTelegramUpdate` (`src/application/telegram/engagement.ts`), and **it
runs in the route ahead of the dedup claim** — the same cost contract as Slack's: an update
nobody addressed to the bot costs a secret check and nothing else.

Telegram does part of the deciding itself. A bot in a group receives, by default
(BotFather's *privacy mode*), only the messages that name it — a command, a mention, a reply
to one of its messages — so most of what reaches here is for the bot already. Privacy mode
can be switched off, and then the bot receives everything the group says; the funnel is
what keeps it from answering all of it:

1. **not a new message** — an edit, a channel post, a service update — nothing; the webhook
   asks Telegram for `message` updates alone, so these arrive only from an older registration;
2. **a bot's message**, this bot's own included — nothing, because everything below can start
   a run and a run that answers itself never stops;
3. **a command this bot understands** — `/start` and `/help`, bare or addressed
   (`/help@painter_bot`); one addressed to another bot is nobody's business here, and a
   command this bot does not know is an ordinary question;
4. **a private chat** — every message in one is for the bot;
5. **a group message that mentions the bot or replies to one of its messages** — answered,
   with the mention taken out of the text;
6. otherwise nothing.

Nothing here costs a read. A group has no engagement row and no `!mute`: a follow-up there
is a reply, and Telegram already tells the bot what a message replies to. A message with no
text and no attachment is ignored; a photo with no caption is not — it is a question about
the picture.

## History

**The Bot API hands back no history.** A bot sees each update once; there is no call that
returns a chat's earlier messages, and `reply_to_message` carries one message, not a thread.
So the only way a follow-up can carry the question before it is for this platform to have
written both down. That is `ConversationTranscriptRepository`
(`src/domain/messaging/transcript.ts`, rows under `TRANSCRIPT#{project}#{conversation}`): a
bounded, expiring record of the turns exchanged in one conversation — the newest 50 are read
before the run, oldest first, and the question and the answer are appended after it, in
that order. It is not a chat: nobody reads it back in a console, it is not replayed with its
tool traffic, and losing it costs the next question its context, not its answer. A read that
fails is a warning on the reply ("answered without prior context"); a write that fails is
logged. Turns expire seven days after they are written, each on its own, so a live
conversation keeps its recent turns while its old ones fall away.

A **conversation** is the chat — `telegram:{chatId}` — or, in a forum supergroup, the topic:
`telegram:{chatId}:{threadId}`. A private chat is one conversation for as long as it exists;
a plain group is one conversation for everyone in it, which is what it looks like to its
members too. The same key is what an MCP server is told and what an outbound A2A transfer
continues under (see [agents-a2a.md](agents-a2a.md)).

**Who is asking** reaches the model only when the version opted in
(`parameters.callerContext`), and only as much as an update carries: the sender's name, made
prompt-safe by `callerFrom`; Telegram hands over no timezone and no email, so a Telegram run
files its artifacts by project alone. The opt-in gates what is *written down* too — a turn's
speaker name goes into the transcript only for a version that asked to know it — and when a
group conversation holds more than one human, every human turn is labelled with its speaker,
the newest included, so a three-way conversation does not reach the model as one person's
monologue. Images in earlier turns are not carried: the transcript keeps text alone.

## Attachments

A photo arrives in several sizes, smallest first, each its own file; the largest one under
the image cap is what the model is shown, and when even the smallest is over it, the
smallest is offered so the size check reports it rather than a silent drop. A document
arrives with its declared type, name and size, and becomes text like every other surface's
([chat.md](chat.md#attachments)). Both are fetched in two steps — `getFile` for the path,
then the file host, with the token in the URL by Telegram's design — bounded while the body
is read, and nothing logs a file URL.

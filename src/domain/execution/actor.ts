/**
 * Who caused a run.
 *
 * Project access follows visibility and membership; multiple callers can run a
 * shared project, so
 * the project name does not identify the spender, and until this existed "who
 * spent this" had no answer at all on a platform whose purpose is cost
 * management. Every execution entry point has a subject even when no human is
 * present, which is why this is a discriminated kind rather than an email.
 */
export type RunActorKind =
  /** A signed-in console/API user, identified by email. */
  | "user"
  /** A per-project API token. It authenticates *as the owner*, so `id` is theirs. */
  | "project-token"
  /** A Slack mention or DM, identified by the Slack user id. */
  | "slack"
  /** A Telegram message to a project's bot, identified by the Telegram user id. */
  | "telegram"
  /** A Microsoft Teams message to a project's bot, identified by the sender's Entra object id. */
  | "teams"
  /** A webhook trigger delivery, identified by `{project}:{triggerId}`. */
  | "webhook"
  /** A schedule trigger occurrence, identified the same way. */
  | "schedule";

export interface RunActor {
  kind: RunActorKind;
  /**
   * Stable within the kind. An email for `user` and `project-token` (a token
   * runs on its owner's behalf, and the kind is what keeps the two apart), a
   * Slack user id for `slack`, a Telegram user id for `telegram`, an Entra
   * object id for `teams`.
   */
  id: string;
}

/**
 * What a run may tell the model about the person asking.
 *
 * Deliberately separate from {@link RunActor}, which is a *storage key*
 * (`actorKey`) and must stay stable and machine-shaped. This is the opposite:
 * human-readable, resolved from whatever the surface knows, and free to be
 * absent. Mixing the two would put a display name someone can rename into the
 * key a year of usage rows is grouped by.
 *
 * No email, on purpose. PII filtering masks emails, phone and registration/card
 * numbers but not names (`application/llm/pii.ts`), so anything here reaches the model as
 * written — which is a reason to carry the least that is still useful.
 */
export interface RunCaller {
  displayName: string;
  /** IANA zone, e.g. `Asia/Seoul`. Lets the model resolve "tomorrow" correctly. */
  timezone?: string;
  /** A URL, never image bytes: the answer rarely needs to look at a face. */
  avatarUrl?: string;
}

/** Longest name that still reads as one; anything past it is not a name. */
const MAX_CALLER_NAME_LENGTH = 60;

/**
 * Build a caller from whatever a surface managed to look up — the single place
 * a `RunCaller` is created, and therefore the single place its name is made
 * safe to put in a prompt.
 *
 * **A display name is attacker-controlled.** On Slack anyone can set their own
 * to whatever they like, and it lands in the *system* prompt, which is the part
 * a model weights most heavily. Left raw, `"Bruce\n\nIgnore all previous
 * instructions…"` is a working injection — and through the speaker labels on a
 * shared thread it is an injection into *other people's* conversations, not
 * only the author's own.
 *
 * So the name is flattened to a single line, stripped of control characters,
 * and bounded. That does not make prompt injection impossible — the message
 * body is untrusted too — but it stops identity metadata from being a place to
 * hide instructions, which is the part the reader has no way to see.
 *
 * Returns `null` when nothing survives: no caller is better than a blank one.
 */
export function callerFrom(input: {
  displayName?: string;
  timezone?: string;
  avatarUrl?: string;
}): RunCaller | null {
  const displayName = sanitizeCallerName(input.displayName);
  if (!displayName) {
    return null;
  }
  const timezone = sanitizeCallerName(input.timezone);
  return {
    displayName,
    ...(timezone ? { timezone } : {}),
    // Only an https URL: a `javascript:` or `data:` value in this position is
    // not an avatar, and the model is being handed it as a link.
    ...(input.avatarUrl && /^https:\/\/[^\s]+$/.test(input.avatarUrl)
      ? { avatarUrl: input.avatarUrl }
      : {}),
  };
}

function sanitizeCallerName(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  // Control characters first — a newline is what lets a name open what looks
  // like a new line of instructions — then any whitespace run collapses to one.
  const flattened = value
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  // Cut by **character**, never through one — the same rule and the same
  // spelling as `savedFileName`, which records why this layer spreads rather
  // than reaching for `cutCodePoints`. It matters more here than anywhere:
  // a display name is set by whoever is asking, so a name of 59 letters and
  // one emoji ends in half a character *by their choice*, and the half goes
  // into the system prompt — on the wire as a lone `\ud800`-range escape a
  // provider may refuse the whole request over. That is a caller able to stop
  // their own runs, and on a shared thread everyone else's.
  return flattened ? [...flattened].slice(0, MAX_CALLER_NAME_LENGTH).join("") : undefined;
}

/**
 * Where a run came from: who caused it, and the transfer chain that reached it.
 *
 * These travel together through every subagent hop — a child is caused by the
 * same person as its parent — so they are one value rather than separate parameters
 * threaded side by side through eight signatures.
 */
export interface RunOrigin {
  /** Source processing may read bound skills; its calling use case owns all external effects. */
  backgroundTask?: boolean;
  actor?: RunActor;
  /**
   * A user email resolved by a surface whose actor id is not an email, such as
   * Slack.
   */
  userEmail?: string;
  /**
   * Who the actor is, in words. Travels the transfer chain for the same reason
   * the actor does — a subagent is answering the same person as its parent.
   */
  caller?: RunCaller;
  /**
   * Which conversation the run belongs to, when the surface has one. Travels the
   * chain like the two above: a child transferred to from a Slack thread is
   * still answering in that thread, and a remote agent it hands off to should
   * be able to tell the second question in it from a first.
   */
  conversation?: RunConversation;
  /** Project names on the transfer chain, outermost first. */
  ancestry: readonly string[];
}

/**
 * The surface a conversation lives on. Each names its conversations differently
 * — a chat by its id, Slack by channel and thread, Telegram by chat and topic,
 * Teams by its own conversation id, an API caller by whatever it put in
 * `X-Conversation-Id` — and the surface is what keeps those namespaces apart in
 * one key.
 *
 * Deliberately not every {@link RunActorKind}: a webhook delivery and a
 * schedule occurrence are one-shot. Nobody asks a follow-up question in a
 * firing, so a firing has no conversation rather than a conversation of one.
 */
export type RunSurface = "chat" | "slack" | "telegram" | "teams" | "api";

/**
 * Where a run's conversation is: the surface, and that surface's own id for it.
 *
 * An MCP server that keeps state — a memory server — needs to
 * know which conversation is asking. Neither the actor (a person is in many
 * conversations) nor the ancestry (a chain of projects, not of turns) can
 * stand in for it, which is why it is its own field rather than a spelling of
 * either.
 */
export interface RunConversation {
  surface: RunSurface;
  /**
   * Stable within the surface, and already made safe by {@link conversationOf}:
   * printable ASCII, no whitespace, bounded. It lands in a request header and in
   * a storage key, so it holds only what both accept.
   */
  id: string;
}

/**
 * Longest id kept, after encoding. Generous — a Slack thread address and an API caller's own key fit many
 * times over — but a bound all the same, because the value travels in a header
 * and a storage key. Past it there is no conversation rather than a shortened
 * one: a shortened id would make two long ids one conversation.
 */
export const MAX_CONVERSATION_ID_LENGTH = 512;

/**
 * Build a conversation from whatever a surface knows — the single place a
 * {@link RunConversation} is created, and therefore the single place its id is
 * made safe to carry.
 *
 * An API caller's header is chosen by somebody else,
 * so the id is **encoded rather than trusted, and encoded injectively**:
 * anything outside printable ASCII, whitespace and control characters — none of
 * which a header can carry, and all of which a key would carry invisibly — and
 * `%` itself become `%XX` over their UTF-8 bytes, so two different ids never
 * become one, and an id that was already safe (a UUID, a Slack address) reads
 * back unchanged. Replacing them with a placeholder instead was tried, and it
 * made every Korean word two underscores: two conversations, one memory.
 *
 * Returns `null` when nothing survives or the encoding runs past the bound —
 * no conversation is better than a wrong one, and a caller that needs to say
 * so (the API header) checks the same bound before it gets here.
 */
export function conversationOf(surface: RunSurface, rawId: string | undefined | null): RunConversation | null {
  const trimmed = rawId?.trim();
  if (!trimmed) {
    return null;
  }
  const id = encodeConversationId(trimmed);
  return id.length > MAX_CONVERSATION_ID_LENGTH ? null : { surface, id };
}

/** Printable ASCII, minus `%` — what an id may carry as itself. */
const SAFE_ID_CHAR = /^[\x21-\x24\x26-\x7e]$/;

/**
 * Percent-encode everything outside {@link SAFE_ID_CHAR}, `%` included so the
 * result decodes uniquely. `encodeURIComponent` is the same idea with a
 * different unreserved set — one that would rewrite the `:` every Slack key carries.
 */
function encodeConversationId(raw: string): string {
  let out = "";
  for (const char of raw) {
    if (SAFE_ID_CHAR.test(char)) {
      out += char;
      continue;
    }
    for (const byte of new TextEncoder().encode(char)) {
      out += `%${byte.toString(16).toUpperCase().padStart(2, "0")}`;
    }
  }
  return out;
}

/**
 * The conversation's one string form: `surface:id`. What an MCP server is
 * told and what a trace records. Qualified
 * by surface for the same reason {@link actorKey} is by kind — a chat id and an
 * API id that happen to spell the same must not become one
 * conversation.
 */
export function conversationKey(conversation: RunConversation): string {
  return `${conversation.surface}:${conversation.id}`;
}

/**
 * The actor's storage key: `kind:id`. Qualified by kind so a token acting as an
 * owner is never merged with that owner's own console runs — the whole point of
 * attributing spend is telling those two apart.
 */
export function actorKey(actor: RunActor): string {
  return `${actor.kind}:${actor.id}`;
}

/**
 * The inverse of {@link actorKey}, for the one question the member-shaped
 * limits ask: which member's personal budget does this key spend? Only `user`
 * names one. A `project-token` carries the owner's email too, but on purpose
 * it does **not** bill to them: a token is a service credential, bounded by
 * its project's own limits, and person-shaped limits stop applying the moment
 * nobody is at the other end. What keeps that from being a bypass is the
 * token *authentication* gate — a tier that may not use API tokens cannot
 * mint or present one (`tierMayUseApiTokens`), enforced where the bearer
 * token is verified.
 */
export function memberEmailFromActorKey(key: string): string | null {
  return key.startsWith("user:") ? key.slice("user:".length) || null : null;
}

/** A run one hop deeper on the transfer chain, caused by the same actor. */
export function descend(origin: RunOrigin, projectName: string): RunOrigin {
  return { ...origin, ancestry: [...origin.ancestry, projectName] };
}

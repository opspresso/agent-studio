import type { SlackChannelInfo, SlackMessage, SlackUserDetail } from "@/domain/slack/types";
import {
  MAX_CONCURRENT_SLACK_PROFILE_LOOKUPS,
  type SlackReaderPort,
  type SlackWorkspaceReader,
} from "@/domain/slack/reader";
import { mapWithLimit } from "@/shared/mapWithLimit";
import { slackMessageText } from "@/domain/slack/messageText";
// The names live with every other builtin's, which is the single owner of what
// a builtin may be called — a run's alias table is built from that list before
// this module is reached.
import {
  SLACK_CHANNELS_TOOL_NAME,
  SLACK_HISTORY_TOOL_NAME,
  SLACK_REACTIONS_TOOL_NAME,
  SLACK_THREAD_TOOL_NAME,
  SLACK_USER_TOOL_NAME,
  SLACK_USERS_TOOL_NAME,
} from "@/application/llm/agentAssembly";

/**
 * The Slack workspace, as six read-only tools a run may be offered.
 *
 * The bot's existing read scopes are exposed to a run only through these tools.
 * Without them an agent asked "what did #deploy say about the rollback" can
 * answer only from text somebody pasted into the prompt.
 *
 * Three decisions shape what is here:
 *
 * - **Read-only, and not by omission.** `chat:write` is granted — the reply
 *   transport needs it — and is deliberately not reachable from a tool. A run
 *   reads text it did not write and is steered by it, so a workspace where the
 *   same run can also post is one where a message in a channel can make the bot
 *   speak somewhere else.
 * - **Never an email.** `users:read.email` is granted too, and this is the same
 *   rule `callerFrom` already applies to the caller block: a name, a timezone,
 *   nothing that identifies a person outside Slack.
 * - **Ids are resolved to names.** A transcript of `<@U04B7QK9E>` is not
 *   something a model can reason about, and asking it to make a second tool call
 *   per participant would spend the turn on bookkeeping. Lookups go through the
 *   port's own per-workspace cache.
 */

/**
 * How many messages one read returns when the call does not say.
 *
 * Ours, and low: every message costs prompt budget, and a run that wants more
 * can ask for more. The ceiling is what a single turn can afford to spend on
 * one tool — a hundred messages of a busy channel is already several thousand
 * tokens before the answer starts.
 */
const DEFAULT_MESSAGES = 20;
const MAX_MESSAGES = 100;
/** Channels one listing returns. Past this a name search is the wrong tool. */
const MAX_CHANNELS = 200;
/**
 * Distinct people one read will look up by name.
 *
 * A busy channel's page can name dozens, each a round trip on a cold cache.
 * Past this the ids are left as they are — an unresolved id is worse than a
 * name and far better than a tool call that took ten seconds.
 */
const MAX_PROFILE_LOOKUPS = 25;
/**
 * Pages of `users.list` one name search walks, and how many matches it prints.
 *
 * Slack gives a bot no name search, so a match costs a full-directory walk. The
 * page bound keeps one tool call from becoming dozens of requests; the match
 * bound keeps a search for "kim" from spending the turn's whole budget on a
 * directory listing. Both say when they cut something.
 */
const MAX_USER_PAGES = 5;
const MAX_USER_MATCHES = 20;
/** Names printed per reaction before the rest are counted instead. */
const MAX_REACTION_NAMES = 12;

/**
 * A profile field, flattened to one line.
 *
 * Not a security measure — a title is no more attacker-controlled than the
 * messages already in a transcript, and those go through untouched. It is about
 * the *shape* of the answer: these are rendered as `label: value`, and a newline
 * inside a value invents a label that nobody wrote.
 */
function oneLine(value: string | undefined): string | undefined {
  const flattened = value?.replace(/\s+/g, " ").trim();
  return flattened || undefined;
}

/** A person, as the tools print them. Ordered by what a reader asks first. */
function personLines(person: SlackUserDetail): string[] {
  const status = [oneLine(person.statusEmoji), oneLine(person.statusText)]
    .filter(Boolean)
    .join(" ");
  return [
    `${person.id}: ${oneLine(person.displayName) ?? person.id}`,
    ...(person.realName ? [`name: ${oneLine(person.realName)}`] : []),
    ...(person.title ? [`title: ${oneLine(person.title)}`] : []),
    ...(person.timezone ? [`timezone: ${person.timezone}`] : []),
    ...(status ? [`status: ${status}`] : []),
    ...(person.avatarUrl ? [`avatar: ${person.avatarUrl}`] : []),
    // Worth saying out loud: an unanswered mention is often one of these two.
    ...(person.isBot ? ["this is an app, not a person"] : []),
    ...(person.deactivated ? ["this account is deactivated"] : []),
  ];
}

/**
 * Resolve a bounded set of ids to names, best effort. Shared by two readers.
 *
 * Bounded in flight as well as in count. Twenty-five `users.info` calls at once
 * is a burst against a per-minute limit, and on a cold cache — a channel full of
 * people the bot has not seen this hour — that is exactly what it was. Nothing
 * retries a rate limit, so the cost of hitting one is a transcript that names
 * ids instead of people.
 */
async function resolveNames(
  slack: SlackReaderPort,
  token: string,
  ids: string[],
): Promise<Map<string, string>> {
  const names = new Map<string, string>();
  const wanted = [...new Set(ids)].slice(0, MAX_PROFILE_LOOKUPS);
  await mapWithLimit(wanted, MAX_CONCURRENT_SLACK_PROFILE_LOOKUPS, async (id) => {
    const profile = await slack.userProfile(token, id).catch(() => null);
    if (profile) {
      names.set(id, profile.displayName);
    }
  });
  return names;
}

export type { SlackReaderPort, SlackWorkspaceReader };

function stringArg(args: Record<string, unknown>, name: string): string {
  const value = args[name];
  return typeof value === "string" ? value.trim() : "";
}

function countArg(args: Record<string, unknown>, name: string): number {
  const value = args[name];
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_MESSAGES;
  }
  return Math.min(Math.floor(parsed), MAX_MESSAGES);
}

/**
 * A Slack timestamp (`"1750000000.000100"`) as a readable instant.
 *
 * UTC and minute precision: the reader's zone is not knowable here, and a
 * transcript is read for order and rough time rather than for the second.
 */
function messageTime(ts: string): string {
  const seconds = Number(ts.split(".")[0]);
  if (!Number.isFinite(seconds)) {
    return ts;
  }
  return new Date(seconds * 1000).toISOString().slice(0, 16).replace("T", " ") + "Z";
}

interface ReadableMessage {
  message: SlackMessage;
  text: string;
}

/** Every user id a page of messages refers to — as an author or in its full prose. */
function referencedUsers(messages: ReadableMessage[]): string[] {
  const ids = new Set<string>();
  for (const { message, text } of messages) {
    if (message.user) {
      ids.add(message.user);
    }
    for (const match of text.matchAll(/<@([A-Z0-9]+)>/g)) {
      if (match[1]) {
        ids.add(match[1]);
      }
    }
  }
  return [...ids].slice(0, MAX_PROFILE_LOOKUPS);
}

/**
 * Render a page of messages as a transcript.
 *
 * Oldest first, which is the reverse of what Slack returns for a channel: a
 * conversation reads forwards, and handing a model a reversed one invites it to
 * report the conclusion as the question.
 */
async function transcript(
  slack: SlackReaderPort,
  token: string,
  messages: SlackMessage[],
): Promise<string> {
  if (messages.length === 0) {
    return "No messages.";
  }
  const readable = messages.map((message) => ({ message, text: slackMessageText(message) }));
  const names = await resolveNames(slack, token, referencedUsers(readable));
  const named = (userId: string): string => names.get(userId) ?? userId;
  const lines = readable.map(({ message, text: sourceText }) => {
    const author = message.user ? named(message.user) : message.bot_id ? "(app)" : "(unknown)";
    const text = sourceText
      .replace(/<@([A-Z0-9]+)>/g, (_whole, id: string) => `@${named(id)}`)
      .trim();
    const files = (message.files ?? [])
      .map((file) => file.name)
      .filter(Boolean)
      .join(", ");
    const body = [text, files ? `[attached: ${files}]` : ""].filter(Boolean).join(" ");
    return `[${messageTime(message.ts)}] ${author}: ${body || "(no text)"}`;
  });
  return lines.join("\n");
}

function channelLines(channels: SlackChannelInfo[]): string {
  return channels
    .map((channel) => {
      const notes = [
        channel.isPrivate ? "private" : "public",
        channel.isMember ? "bot is a member" : "bot is NOT a member",
      ].join(", ");
      const description = channel.topic || channel.purpose || "";
      return `#${channel.name} (${channel.id}; ${notes})${description ? ` — ${description}` : ""}`;
    })
    .join("\n");
}

/**
 * Bind the four tools to one workspace.
 *
 * The token is captured here rather than passed per call: which workspace a run
 * may read is a property of the run, and a tool argument naming it would let the
 * model choose.
 */
export function createSlackWorkspaceReader(
  slack: SlackReaderPort,
  token: string,
): SlackWorkspaceReader {
  return async (tool, args) => {
    switch (tool) {
      case SLACK_HISTORY_TOOL_NAME: {
        const channel = stringArg(args, "channel");
        if (!channel) {
          return `Error: ${SLACK_HISTORY_TOOL_NAME} requires a channel id.`;
        }
        // Slack returns a channel newest-first; reversed so the transcript reads
        // forwards like every other one here.
        const messages = await slack.channelHistory(token, {
          channel,
          limit: countArg(args, "limit"),
        });
        return await transcript(slack, token, [...messages].reverse());
      }
      case SLACK_THREAD_TOOL_NAME: {
        const channel = stringArg(args, "channel");
        const threadTs = stringArg(args, "thread_ts");
        if (!channel || !threadTs) {
          return `Error: ${SLACK_THREAD_TOOL_NAME} requires a channel id and a thread_ts.`;
        }
        // Already oldest-first from Slack, unlike a channel's history.
        const messages = await slack.threadReplies(token, {
          channel,
          ts: threadTs,
          limit: countArg(args, "limit"),
        });
        return await transcript(slack, token, messages);
      }
      case SLACK_USER_TOOL_NAME: {
        const userId = stringArg(args, "user");
        if (!userId) {
          return `Error: ${SLACK_USER_TOOL_NAME} requires a user id.`;
        }
        const person = await slack.userDetail(token, userId);
        if (!person) {
          return `No profile for ${userId}. The user may be deactivated, or the bot may not be allowed to read profiles.`;
        }
        return personLines(person).join("\n");
      }
      case SLACK_USERS_TOOL_NAME: {
        const query = stringArg(args, "query");
        if (!query) {
          return `Error: ${SLACK_USERS_TOOL_NAME} requires something to search for.`;
        }
        const found = await slack.findUsers(token, query, MAX_USER_PAGES);
        if (found.users.length === 0) {
          return found.truncated
            ? `No match for "${query}" in the first ${MAX_USER_PAGES * 200} people, and the workspace has more. Try the exact handle, or a user id.`
            : `Nobody in this workspace matches "${query}".`;
        }
        const shown = found.users.slice(0, MAX_USER_MATCHES);
        return [
          ...shown.map((person) => personLines(person).join(" · ")),
          // Said rather than swallowed: a search that quietly missed someone is
          // worse than one that admits it stopped looking.
          ...(found.users.length > shown.length
            ? [`(${found.users.length - shown.length} more match; narrow the search.)`]
            : []),
          ...(found.truncated
            ? ["(The workspace has more people than this search read.)"]
            : []),
        ].join("\n");
      }
      case SLACK_REACTIONS_TOOL_NAME: {
        const channel = stringArg(args, "channel");
        const ts = stringArg(args, "ts");
        if (!channel || !ts) {
          return `Error: ${SLACK_REACTIONS_TOOL_NAME} requires a channel id and a message ts.`;
        }
        const reactions = await slack.messageReactions(token, { channel, ts });
        if (reactions.length === 0) {
          return "Nobody has reacted to that message.";
        }
        // Names, not ids, for the same reason a transcript resolves them: a list
        // of `U04B7QK9E` answers "who acknowledged this" with nothing.
        const names = await resolveNames(
          slack,
          token,
          reactions.flatMap((reaction) => reaction.users),
        );
        return reactions
          .map((reaction) => {
            const who = reaction.users.map((id) => names.get(id) ?? id);
            const listed = who.slice(0, MAX_REACTION_NAMES).join(", ");
            const rest = who.length - Math.min(who.length, MAX_REACTION_NAMES);
            return `:${reaction.name}: ${reaction.count} — ${listed}${rest > 0 ? ` and ${rest} more` : ""}`;
          })
          .join("\n");
      }
      case SLACK_CHANNELS_TOOL_NAME: {
        const query = stringArg(args, "query").toLowerCase().replace(/^#/, "");
        const channels = await slack.listChannels(token, { limit: MAX_CHANNELS });
        const matched = query
          ? channels.filter((channel) => channel.name.toLowerCase().includes(query))
          : channels;
        if (matched.length === 0) {
          return query
            ? `No channel matching "${query}" is visible to this bot.`
            : "No channels are visible to this bot.";
        }
        return channelLines(matched);
      }
      default:
        // Unreachable through the engine, which only routes the four names
        // above; answered rather than thrown so a future miswiring degrades to
        // one bad tool result instead of a failed run.
        return `Error: ${tool} is not a Slack tool.`;
    }
  };
}

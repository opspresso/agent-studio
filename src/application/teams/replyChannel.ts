import {
  createEditInPlaceReply,
  type EditInPlaceTransport,
  type Sleep,
} from "@/application/messaging/editInPlaceReply";
import type { TeamsClientPort, TeamsCredentials } from "@/application/teams/types";
import type { ReplyChannel } from "@/domain/messaging/reply";
import { closeOpenFence } from "@/shared/markdownFence";

/**
 * How a Teams reply is delivered — the single owner of that decision.
 *
 * The Bot Framework has no streaming call either: a reply is an activity sent
 * into the conversation and then updated in place, and progress is a `typing`
 * activity Teams shows for a few seconds. So this is the shared edit-in-place
 * machinery told Teams' calls and caps. Two things are Teams' own. It renders
 * **Markdown natively** for bots (`textFormat: "markdown"`), so the answer is
 * sent as the model wrote it and nothing is rendered at the close — there is
 * no HTML to be refused. And a picture travels **inside the message**, as a
 * `data:` URI attachment Teams draws inline, rather than as an upload of its
 * own.
 */

/**
 * The cap on one activity's text. Teams recommends an 80KB body within its
 * approximate 100KB UTF-16 limit. 20,000 code units leave room for metadata,
 * and an answer that long reads better continued in a second message anyway.
 */
export const MAX_MESSAGE_CHARS = 20_000;
/** Teams allows roughly one message a second per conversation; edits share it. */
const EDIT_INTERVAL_MS = 2000;
/** A `typing` activity shows for a few seconds; refreshed inside that. */
const TYPING_REFRESH_MS = 3000;
const CURSOR = " ▌";
export const SOFT_CUT_WINDOW = 1500;
/**
 * Teams documents an inline bot picture at 1MB and 1024×1024; past this the
 * connector refuses the activity, so the refusal is made here, where it can be
 * said as a warning instead of a failed send.
 */
const MAX_INLINE_IMAGE_BYTES = 1024 * 1024;

/** Where a reply goes: the conversation, and the activity it answers. */
export interface TeamsReplyTarget {
  serviceUrl: string;
  conversationId: string;
  /** The activity being answered; the first message of the reply is a reply to it. */
  replyToId?: string;
}

export function createTeamsReplyChannel(
  teams: TeamsClientPort,
  credentials: TeamsCredentials,
  target: TeamsReplyTarget,
  opts: { sleep?: Sleep } = {},
): ReplyChannel {
  const reply = target.replyToId ? { replyToId: target.replyToId } : {};
  const transport: EditInPlaceTransport = {
    async open(text, { first }) {
      const sent = await teams.sendActivity(credentials, target.serviceUrl, target.conversationId, {
        type: "message",
        text,
        // Only the first message answers the question; the rest continue it.
        ...(first ? reply : {}),
      });
      return sent.id;
    },
    async edit(activityId, text) {
      await teams.updateActivity(credentials, target.serviceUrl, target.conversationId, activityId, {
        type: "message",
        text,
      });
    },
    async post(text) {
      await teams.sendActivity(credentials, target.serviceUrl, target.conversationId, {
        type: "message",
        text,
      });
    },
    async typing() {
      await teams.sendActivity(credentials, target.serviceUrl, target.conversationId, { type: "typing" });
    },
    // Teams reads the Markdown itself, so a fence the run left open would
    // swallow the file link and the warnings appended after it just as
    // Telegram's renderer would; sealed the same way.
    seal: closeOpenFence,
    limits: {
      maxChars: MAX_MESSAGE_CHARS,
      editIntervalMs: EDIT_INTERVAL_MS,
      typingRefreshMs: TYPING_REFRESH_MS,
      softCutWindow: SOFT_CUT_WINDOW,
      cursor: CURSOR,
    },
    scope: "teams",
    ...(opts.sleep ? { sleep: opts.sleep } : {}),
  };

  return {
    ...createEditInPlaceReply(transport),

    async say(text) {
      await teams.sendActivity(credentials, target.serviceUrl, target.conversationId, {
        type: "message",
        text,
        ...reply,
      });
    },

    async sendImage(image, index) {
      const bytes = Buffer.from(image.b64, "base64");
      if (bytes.byteLength > MAX_INLINE_IMAGE_BYTES) {
        throw new Error(`picture ${index + 1} is larger than Teams renders inline (${bytes.byteLength} bytes)`);
      }
      const ext = image.mimeType === "image/png" ? "png" : "jpg";
      await teams.sendActivity(credentials, target.serviceUrl, target.conversationId, {
        type: "message",
        ...(image.prompt ? { text: image.prompt.slice(0, 1024) } : {}),
        attachments: [
          {
            contentType: image.mimeType,
            contentUrl: `data:${image.mimeType};base64,${image.b64}`,
            name: `generated-${Date.now()}-${index + 1}.${ext}`,
          },
        ],
      });
    },

    // Markdown, like the answer; a name is kept out of the link's own syntax.
    fileLink: (file) => `📎 [${file.name.replace(/[[\]]/g, "")}](${file.url})`,
    warningLine: (warning) => `⚠️ ${warning}`,
  };
}

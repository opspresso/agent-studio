import type { SlackBlock, SlackMessageContent } from "./types";

/**
 * Everything a Slack message says, as one text — the single owner of how a
 * message's `text`, its attachments and its blocks are read together.
 *
 * A person's message is its `text`. An app's usually is not: an alerting app
 * puts the alert's title and body in an attachment, a CI app puts its result in
 * fields, a Block Kit message keeps its prose in sections and sets `text` to a
 * fallback or nothing at all. Reading `text` alone answers a keyword against the
 * title and hands the run a headline without the alert under it. Read here once
 * — for the keyword match, for the turn a run answers, and for the thread
 * history — so the three agree on what a message said.
 *
 * Order is Slack's rendering order: text, then each attachment (pretext, title,
 * text, fields), then each prose block. A part repeated verbatim is kept once,
 * which is what folds a `fallback` or a `text` that mirrors the blocks — Slack
 * itself does both. Nothing is escaped or unescaped: mrkdwn passes as it is,
 * exactly as `text` always has.
 */
export function slackMessageText(message: SlackMessageContent): string {
  const parts: string[] = [];
  const seen = new Set<string>();
  const add = (value: string | undefined): void => {
    const trimmed = value?.trim();
    if (trimmed && !seen.has(trimmed)) {
      seen.add(trimmed);
      parts.push(trimmed);
    }
  };
  add(message.text);
  for (const attachment of message.attachments ?? []) {
    add(attachment.pretext);
    add(attachment.title);
    add(attachment.text);
    for (const field of attachment.fields ?? []) {
      // A field is its value; the title only labels it. One without a value
      // says nothing.
      const title = field.title?.trim();
      const value = field.value?.trim();
      if (value) {
        add(title ? `${title}: ${value}` : value);
      }
    }
    // The fallback is Slack's own one-line rendering of the parts above; it
    // is read only when there was nothing else to read.
    if (!attachment.pretext?.trim() && !attachment.title?.trim() && !attachment.text?.trim()) {
      add(attachment.fallback);
    }
  }
  for (const block of message.blocks ?? []) {
    add(blockText(block));
  }
  return parts.join("\n");
}

function blockText(block: SlackBlock): string | undefined {
  switch (block.type) {
    case "header":
    case "section": {
      const lines = [block.text?.text, ...(block.fields ?? []).map((field) => field.text)];
      return lines.filter((line): line is string => Boolean(line?.trim())).join("\n");
    }
    case "context":
      return (block.elements ?? [])
        .filter((element) => element.type === "mrkdwn" || element.type === "plain_text")
        .map((element) => element.text)
        .filter((text): text is string => Boolean(text?.trim()))
        .join(" ");
    default:
      return undefined;
  }
}

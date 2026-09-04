/**
 * Neutralise Slack mrkdwn tokens that can notify people.
 *
 * Ordinary Markdown, links (`<https://…|…>`), channel references, and Slack's
 * non-notifying date token remain intact. Escaping only the complete notifying
 * token keeps an LLM or tool result from turning reply text into a second
 * broadcast channel.
 */
const NOTIFYING_MENTION =
  /<(@[A-Z0-9]+(?:\|[^>]*)?|!(?:here|channel|everyone)(?:\|[^>]*)?|!subteam\^[A-Z0-9]+(?:\|[^>]*)?)>/gi;

export function neutralizeSlackMentions(text: string): string {
  return text.replace(NOTIFYING_MENTION, "&lt;$1&gt;");
}

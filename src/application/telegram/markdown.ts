/**
 * The subset of Markdown a model writes, rendered as the HTML subset Telegram
 * accepts — and nothing that could make Telegram refuse the message.
 *
 * Telegram parses `parse_mode: "HTML"` strictly: an unknown tag, an unbalanced
 * one, or a bare `<` in the text is a 400 for the *whole* message, and there is
 * no partial rendering. So everything is escaped first, and only what this
 * file recognises is turned back into markup. What it does not recognise —
 * tables, nested lists, images — stays as the reader typed it, escaped, which
 * reads worse than a rendered version and better than a lost message. The
 * reply channel still sends the plain text if Telegram refuses the rendered
 * one, so a defect here costs formatting and never the answer.
 */

/** Telegram's HTML entity escape: exactly these three, and nothing else. */
export function escapeTelegramHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * Where a lifted code span sat while the other rules ran. NUL cannot occur in
 * a message Telegram delivered or a model wrote, so it marks a slot and
 * nothing else.
 */
const SLOT = String.fromCharCode(0);
const SLOT_PATTERN = new RegExp(`${SLOT}(\\d+)${SLOT}`, "g");

/**
 * Inline rules, applied to escaped text outside code. Code spans go first and
 * are lifted out so nothing below rewrites what is inside them.
 */
function renderInline(escaped: string): string {
  const codeSpans: string[] = [];
  let text = escaped.replace(/`([^`\n]+)`/g, (_match, code: string) => {
    codeSpans.push(`<code>${code}</code>`);
    return `${SLOT}${codeSpans.length - 1}${SLOT}`;
  });
  // A link, only to an address a reader can follow. Anything else stays text.
  text = text.replace(
    /\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g,
    (_match, label: string, url: string) => `<a href="${url.replace(/"/g, "&quot;")}">${label}</a>`,
  );
  text = text.replace(/\*\*([^*\n]+)\*\*/g, "<b>$1</b>");
  text = text.replace(/__([^_\n]+)__/g, "<b>$1</b>");
  text = text.replace(/~~([^~\n]+)~~/g, "<s>$1</s>");
  // Italics only where the marker is a marker: `snake_case` and `2*3` are not.
  text = text.replace(/(^|[\s(])\*([^*\s][^*\n]*?)\*(?=[\s.,;:!?)]|$)/g, "$1<i>$2</i>");
  text = text.replace(/(^|[\s(])_([^_\s][^_\n]*?)_(?=[\s.,;:!?)]|$)/g, "$1<i>$2</i>");
  return text.replace(SLOT_PATTERN, (_match, index: string) => codeSpans[Number(index)] ?? "");
}

/** Block rules, one line at a time: headings become bold, bullets become bullets. */
function renderLine(escaped: string): string {
  const heading = /^#{1,6}\s+(.+?)\s*#*$/.exec(escaped);
  if (heading) {
    return `<b>${renderInline(heading[1] ?? "")}</b>`;
  }
  const bullet = /^(\s*)[-*]\s+(.*)$/.exec(escaped);
  if (bullet) {
    return `${bullet[1] ?? ""}• ${renderInline(bullet[2] ?? "")}`;
  }
  return renderInline(escaped);
}

/**
 * Markdown to Telegram HTML.
 *
 * Fenced code blocks are lifted out whole and rendered as `<pre>`; the rest is
 * escaped and rendered line by line. A fence that never closes runs to the end
 * of the text — a reply cut mid-block is still a block, and closing it is
 * better than rendering half of it as prose.
 */
export function markdownToTelegramHtml(markdown: string): string {
  const out: string[] = [];
  const fence = /```([^\n`]*)\n([\s\S]*?)(?:```|$)/g;
  let last = 0;
  for (const match of markdown.matchAll(fence)) {
    const [whole, language = "", code = ""] = match;
    const start = match.index ?? 0;
    out.push(renderProse(markdown.slice(last, start)));
    const lang = language.trim();
    const body = escapeTelegramHtml(code.replace(/\n$/, ""));
    out.push(
      lang
        ? `<pre><code class="language-${escapeTelegramHtml(lang)}">${body}</code></pre>`
        : `<pre>${body}</pre>`,
    );
    last = start + whole.length;
  }
  out.push(renderProse(markdown.slice(last)));
  return out.join("");
}

function renderProse(markdown: string): string {
  if (!markdown) {
    return "";
  }
  return escapeTelegramHtml(markdown).split("\n").map(renderLine).join("\n");
}

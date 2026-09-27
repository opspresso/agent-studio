/**
 * Script-free Markdown, CSV, JSON, SVG and text artifact views. HTML uses
 * interactiveHtml.ts. Markdown shares the chat renderer; raw HTML stays text.
 * SVG uses an image data URL so it cannot execute script or fetch resources.
 * Use react-dom/server.edge: Next.js rejects the server entry in App Router
 * modules even when a route only uses it to produce static response markup.
 */

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server.edge";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { InlineView } from "@/domain/artifact/types";
import { cutUtf8Bytes, decodeUtf8Text } from "@/shared/utf8Text";
import { parseCsv } from "./csv";
import { escapeHtml } from "./htmlSafety";

/** Bound browser table layout; omitted rows are reported with a download instruction. */
const MAX_CSV_ROWS = 2000;

/** Bound synchronous Markdown rendering on the shared server event loop; report truncation. */
const MAX_MARKDOWN_BYTES = 256 * 1024;

/** Inline styles work under the view policy without network assets. */
const STYLE = `
:root {
  color-scheme: light dark;
  --bg: #ffffff;
  --ink: #1a1d21;
  --muted: #5c6570;
  --rule: #d8dee4;
  --tint: #f4f6f8;
  --link: #0b5d7a;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #16191d;
    --ink: #e6e8ea;
    --muted: #9aa4ae;
    --rule: #333a42;
    --tint: #1e232a;
    --link: #6fb7d6;
  }
}
body {
  margin: 0;
  padding: 2.5rem 1.25rem 6rem;
  background: var(--bg);
  color: var(--ink);
  font: 16px/1.7 system-ui, -apple-system, "Segoe UI", "Apple SD Gothic Neo",
    "Noto Sans KR", sans-serif;
}
/*
 * The measure follows what is on the page. Prose wants a line a reader's eye
 * can return from; a table and a drawing want the room they were made at, and
 * squeezing either into a prose column is what turned a seven-column CSV into
 * headers broken mid-word.
 */
main { max-width: 46rem; margin: 0 auto; overflow-wrap: anywhere; }
main.code { max-width: 72rem; }
main.wide { max-width: min(96rem, 100%); }
main > :first-child { margin-top: 0; }
h1, h2, h3, h4 { line-height: 1.3; margin: 2rem 0 0.75rem; }
h1 { font-size: 1.9rem; }
h2 { font-size: 1.45rem; padding-bottom: 0.3rem; border-bottom: 1px solid var(--rule); }
h3 { font-size: 1.15rem; }
a { color: var(--link); }
hr { border: 0; border-top: 1px solid var(--rule); margin: 2rem 0; }
blockquote {
  margin: 1.25rem 0;
  padding: 0.1rem 1rem;
  border-left: 3px solid var(--rule);
  color: var(--muted);
}
code {
  background: var(--tint);
  border-radius: 4px;
  padding: 0.1em 0.35em;
  font: 0.875em/1.6 ui-monospace, SFMono-Regular, Menlo, monospace;
}
pre {
  background: var(--tint);
  border-radius: 8px;
  padding: 1rem;
  /* Scrolls inside itself; the page never scrolls sideways. */
  overflow-x: auto;
}
pre code { background: none; padding: 0; }
/* A wide table is the usual reason a report would push the page sideways;
   display:block is what lets it scroll inside itself instead. */
table { display: block; overflow-x: auto; max-width: 100%; border-collapse: collapse; margin: 1.25rem 0; }
/* Breaking inside a word is for an unbreakable token in prose, never for a
   column name: the table scrolls sideways instead. */
th, td {
  border: 1px solid var(--rule);
  padding: 0.45rem 0.7rem;
  text-align: left;
  overflow-wrap: normal;
  word-break: normal;
}
th { background: var(--tint); }
img { max-width: 100%; height: auto; }
li { margin: 0.25rem 0; }
.contains-task-list { list-style: none; padding-left: 1.2rem; }
/* Text and JSON: the file as it is, wrapped so nothing is off the right edge. */
.raw {
  white-space: pre-wrap;
  word-break: break-word;
  overflow-x: auto;
  margin: 0;
}
/* A drawing gets the room a drawing needs, on the page's own ground. */
.drawing { text-align: center; }
.drawing img { max-height: 80vh; }
/* What the page could not show. Said, never left to be noticed. */
.note {
  margin: 0 0 1.5rem;
  padding: 0.6rem 0.9rem;
  border-left: 3px solid var(--rule);
  background: var(--tint);
  color: var(--muted);
  font-size: 0.875rem;
}
@media print { body { padding: 0; } }
`;

/** One `<td>`/`<th>`, with whatever the cell held escaped into it. */
function cell(tag: "td" | "th", value: string): string {
  return `<${tag}>${escapeHtml(value)}</${tag}>`;
}

/** Treat the first CSV row as headers and report rows beyond the view cap. */
function csvBody(text: string): { body: string; note?: string } {
  const rows = parseCsv(text);
  if (rows.length === 0) {
    return { body: '<p class="note">This file is empty.</p>' };
  }
  const [header, ...body] = rows as [string[], ...string[][]];
  const shown = body.slice(0, MAX_CSV_ROWS);
  const table = [
    "<table>",
    `<thead><tr>${header.map((value) => cell("th", value)).join("")}</tr></thead>`,
    "<tbody>",
    ...shown.map((row) => `<tr>${row.map((value) => cell("td", value)).join("")}</tr>`),
    "</tbody>",
    "</table>",
  ].join("");
  const dropped = body.length - shown.length;
  return dropped > 0
    ? {
        body: table,
        note: `Showing the first ${MAX_CSV_ROWS.toLocaleString("en-US")} of ${body.length.toLocaleString("en-US")} rows. Download the file for the rest.`,
      }
    : { body: table };
}

/** Re-indent JSON; invalid JSON stays readable with a warning. */
function jsonBody(text: string): { body: string; note?: string } {
  try {
    const reindented = JSON.stringify(JSON.parse(text), null, 2);
    return { body: `<pre class="raw">${escapeHtml(reindented)}</pre>` };
  } catch {
    return {
      body: `<pre class="raw">${escapeHtml(text)}</pre>`,
      note: "This file is not valid JSON, so it is shown as the text it is.",
    };
  }
}

/** Re-encode SVG as an image data URL instead of exposing an object address. */
function svgBody(text: string): string {
  const data = Buffer.from(text, "utf-8").toString("base64");
  return `<div class="drawing"><img src="data:image/svg+xml;base64,${data}" alt=""></div>`;
}

/** The measure each kind is read at. Prose is the default; the rest say so. */
const MEASURE: Partial<Record<InlineView, string>> = {
  csv: "wide",
  svg: "wide",
  json: "code",
};

/** Render validated UTF-8 text, or return null for unreadable bytes. */
export function viewPage(
  view: Exclude<InlineView, "html">,
  bytes: Uint8Array,
  title: string | undefined,
): string | null {
  const text = decodeUtf8Text(bytes);
  if (text === null) {
    return null;
  }
  let body: string;
  let note: string | undefined;
  if (view === "svg") {
    body = svgBody(text);
  } else if (view === "markdown") {
    const size = Buffer.byteLength(text, "utf8");
    const source = size > MAX_MARKDOWN_BYTES ? cutUtf8Bytes(text, MAX_MARKDOWN_BYTES) : text;
    if (source !== text) {
      note = `Showing the first ${Math.round(MAX_MARKDOWN_BYTES / 1024)} KB of ${Math.round(size / 1024)} KB. Download the file for the rest.`;
    }
    body = renderToStaticMarkup(
      createElement(ReactMarkdown, { remarkPlugins: [remarkGfm] }, source),
    );
  } else if (view === "csv") {
    ({ body, note } = csvBody(text));
  } else if (view === "json") {
    ({ body, note } = jsonBody(text));
  } else {
    body = `<pre class="raw">${escapeHtml(text)}</pre>`;
  }
  const heading = escapeHtml(title?.trim() || "Artifact");
  return [
    "<!doctype html>",
    // The document's language decides hyphenation and the font a browser picks
    // for CJK. A run writes in whatever the reader asked in, and nothing on the
    // row records which — so it is left unset rather than asserted wrongly.
    "<html>",
    "<head>",
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${heading}</title>`,
    `<style>${STYLE}</style>`,
    "</head>",
    `<body><main${MEASURE[view] ? ` class="${MEASURE[view]}"` : ""}>${
      note ? `<p class="note">${escapeHtml(note)}</p>` : ""
    }${body}</main></body>`,
    "</html>",
  ].join("\n");
}

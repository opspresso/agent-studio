/**
 * A stored artifact as a page a reader can open.
 *
 * `text/html` never comes through here — `interactiveHtml.ts` places it inside
 * a sandboxed iframe. Everything else is a file a browser would save, and this is
 * what makes View mean the same thing for all of them: the reader presses it
 * and gets something to look at, rather than learning that one kind of report
 * opens and the rest land in Downloads.
 *
 * **Each type is shown as what it is, not as text that happens to be in it.**
 * Markdown is rendered, CSV becomes a table, JSON is re-indented, SVG is drawn,
 * plain text is plain text. A single `<pre>` for all five would be less work
 * and would answer a different question than the reader asked.
 *
 * Markdown uses **the same renderer the chat thread uses** (`react-markdown` +
 * `remark-gfm`), deliberately: a run's report should not read differently
 * depending on which of the two surfaces it is being read on, and a second
 * Markdown dialect in this repository is a second set of edge cases in tables,
 * task lists and fenced code. It also decides the safety argument. It renders
 * raw HTML in the source as *text* rather than markup and strips dangerous URL
 * schemes, so the page carries no script by construction.
 *
 * Nothing built here has script, so these static views receive a sandbox
 * with no `allow-*` grant. HTML has a separate interactive wrapper. SVG
 * is drawn through `<img>` rather than inlined: an SVG loaded as an image cannot
 * run script or fetch anything, by specification, before any header has a say.
 *
 * **`react-dom/server.edge`, not `react-dom/server`, and not by preference.**
 * The App Router build refuses the latter outright ("You're importing a
 * component that imports react-dom/server") because in a page it is nearly
 * always a mistake. Here it is not a page: nothing hydrates, the output is a
 * string this route writes into a response, and the alternative is a browser
 * saving the file. `.edge` is the same renderer through the entry point that
 * guard does not name. If a future Next widens it, the replacement is the
 * pipeline `react-markdown` runs internally — `unified` + `remark-parse` +
 * `remark-gfm` + `remark-rehype` + `rehype-stringify` — which keeps the dialect
 * and costs four dependencies.
 */

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server.edge";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { InlineView } from "@/domain/artifact/types";
import { cutUtf8Bytes, decodeUtf8Text } from "@/shared/utf8Text";
import { parseCsv } from "./csv";
import { escapeHtml } from "./htmlSafety";

/**
 * How many rows of a table are drawn.
 *
 * A view, not an export — the file itself is one click away and holds
 * everything. The cap exists because a 2 MB CSV is tens of thousands of rows
 * and a browser asked to lay them all out stops responding, which reads as the
 * page being broken rather than as the file being large. What is left out is
 * said on the page; a table silently missing its tail is the failure this
 * avoids.
 */
const MAX_CSV_ROWS = 2000;

/**
 * How much Markdown is rendered.
 *
 * The renderer is **synchronous and superlinear**: measured on this repo's own
 * `react-markdown`, 256 KB takes ~0.4 s and 2 MB takes ~7 s with about a
 * gigabyte of heap. It runs in the route handler before the Response exists, so
 * that time is the whole Node instance stopped — every in-flight SSE run
 * included, which is the silent gap `FIRST_CHUNK_GRACE_MS` exists elsewhere to
 * prevent. `MAX_INLINE_VIEW_BYTES` is a memory cap and far too generous to be
 * this one; a table has its row cap and JSON its shape, and Markdown had
 * nothing. What is cut is said on the page.
 */
const MAX_MARKDOWN_BYTES = 256 * 1024;

/**
 * Enough of a stylesheet to read a report by, and no more.
 *
 * Self-contained because the page runs on an opaque origin under
 * `default-src 'none'`: there is no stylesheet it could fetch and no font it
 * could load. Both schemes are written out rather than one being derived,
 * since the reader's browser is the only thing that says which applies.
 */
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

/**
 * A CSV as the table it describes.
 *
 * The first row is the header, which is the default the `text/csv` media type
 * registers — and the shape of every file a run writes here, since a column of
 * numbers with nothing naming it is not a report.
 */
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

/**
 * JSON re-indented, or the text as it stands when it is not JSON.
 *
 * A run writes this by hand into a string argument, so a stored `.json` that
 * does not parse is a real outcome rather than a corruption — and it is still
 * the thing the reader was handed, so it is shown rather than refused. What is
 * *not* done is showing it as if it had parsed.
 */
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

/**
 * The drawing, through `<img>` and a `data:` URL.
 *
 * Not inlined into the page, and not because of the header: an SVG loaded as an
 * image runs no script and fetches nothing, by specification, so this is the one
 * way to show a picture a model wrote without the question arising. The bytes
 * are re-encoded rather than linked because the object's own address is exactly
 * what this route exists not to hand out.
 */
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

/**
 * The page, or `null` when the stored bytes are not what the type says.
 *
 * `Buffer.toString("utf-8")` would answer for anything — a PDF mislabelled
 * `text/markdown` becomes a screen of replacement characters and renders as if
 * it worked — so the decode decides, and a caller that gets `null` says the row
 * could not be read rather than showing the wreckage — SVG included, since an
 * SVG that is not text is not an SVG.
 */
export function viewPage(
  view: Exclude<InlineView, "html">,
  bytes: Uint8Array,
  title: string | undefined,
): string | null {
  // Every kind, SVG included: an SVG is text by definition, so bytes that are
  // not text are not one — and drawing them anyway produced an inert data URL
  // inside an `<img>`, which is a blank page with nothing saying why.
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

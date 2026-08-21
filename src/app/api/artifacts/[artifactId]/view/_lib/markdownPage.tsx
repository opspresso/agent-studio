/**
 * A stored Markdown artifact as a page a reader can open.
 *
 * `text/html` is served as it was written; Markdown cannot be, because a
 * browser handed `text/markdown` saves it. Rendering it here is what makes the
 * two the same offer — the reader presses View and gets a document either way,
 * rather than being told that one kind of report opens and the other downloads.
 *
 * **The same renderer the chat thread uses** (`react-markdown` + `remark-gfm`),
 * deliberately: a run's report should not read differently depending on which
 * of the two surfaces it is being read on, and a second Markdown dialect in
 * this repository is a second set of edge cases in tables, task lists and
 * fenced code. It also decides the safety argument. `react-markdown` renders
 * raw HTML in the source as *text* rather than markup and strips dangerous
 * URL schemes, so the page this produces carries no script by construction —
 * which is why the view can refuse `allow-scripts` for Markdown while granting
 * it to HTML.
 *
 * **`react-dom/server.edge`, not `react-dom/server`, and not by preference.**
 * The App Router build refuses the latter outright ("You're importing a
 * component that imports react-dom/server") because in a page it is nearly
 * always a mistake. Here it is not a page: nothing hydrates, the output is a
 * string this route writes into a response, and the artifact is `text/markdown`
 * that a browser would otherwise save. `.edge` is the same renderer through the
 * entry point that guard does not name. If a future Next widens it, the
 * replacement is the pipeline `react-markdown` runs internally —
 * `unified` + `remark-parse` + `remark-gfm` + `remark-rehype` +
 * `rehype-stringify` — which keeps the dialect and costs four dependencies.
 */

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server.edge";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { decodeUtf8Text } from "@/shared/utf8Text";

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
main { max-width: 46rem; margin: 0 auto; overflow-wrap: anywhere; }
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
th, td { border: 1px solid var(--rule); padding: 0.45rem 0.7rem; text-align: left; }
th { background: var(--tint); }
img { max-width: 100%; height: auto; }
li { margin: 0.25rem 0; }
.contains-task-list { list-style: none; padding-left: 1.2rem; }
@media print { body { padding: 0; } }
`;

const ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
};

function escapeHtml(text: string): string {
  return text.replace(/[&<>"]/g, (char) => ESCAPES[char]!);
}

/**
 * The page, or `null` when the stored bytes are not UTF-8 text.
 *
 * `Buffer.toString("utf-8")` would answer for anything — a PDF mislabelled
 * `text/markdown` becomes a screen of replacement characters and renders as if
 * it worked — so the decode decides, and a caller that gets `null` says the row
 * could not be read rather than showing the wreckage.
 */
export function markdownPage(bytes: Uint8Array, title: string | undefined): string | null {
  const text = decodeUtf8Text(bytes);
  if (text === null) {
    return null;
  }
  const body = renderToStaticMarkup(
    createElement(ReactMarkdown, { remarkPlugins: [remarkGfm] }, text),
  );
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
    `<body><main>${body}</main></body>`,
    "</html>",
  ].join("\n");
}

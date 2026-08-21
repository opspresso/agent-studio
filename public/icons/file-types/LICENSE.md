# File type icons

Every icon here except `hwpx.svg` comes from
[Material Icon Theme](https://github.com/PKief/vscode-material-icon-theme), licensed under
the [MIT License](https://github.com/PKief/vscode-material-icon-theme/blob/main/LICENSE).
Some are renamed to the file type this app names rather than the one the source set does:

| here | upstream |
|---|---|
| `pdf.svg` | `pdf.svg` |
| `docx.svg` | `word.svg` |
| `pptx.svg` | `powerpoint.svg` |
| `html.svg` | `html.svg` |
| `md.svg` | `markdown.svg` |
| `csv.svg` | `table.svg` |
| `txt.svg` | `document.svg` |
| `json.svg` | `json.svg` |
| `svg.svg` | `svg.svg` |

`hwpx.svg` is derived from the same MIT-licensed document icon shape and carries an HWPX-specific
`H` mark because the source set has no HWPX icon.

Taken as published, so the silhouettes are not uniform — `pdf`/`docx`/`pptx`/`csv`/`hwpx` are the
folded-corner document, while `html`, `md`, `json` and `svg` are that format's own mark. That is
how the source set draws them, and a reader picks a tile out of a grid faster by the mark it
already knows than by a shape shared with four neighbours.

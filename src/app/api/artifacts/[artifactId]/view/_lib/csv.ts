/**
 * Delimiter-separated rows, per RFC 4180.
 *
 * Hand-written rather than a dependency because the grammar is three rules and
 * the failure a naive `split(",")` produces is silent: a quoted field holding a
 * comma — which is most of why anyone quotes one — splits into two columns, and
 * the table renders as if that were the data. A field may be quoted, `""`
 * inside a quoted field is one literal quote, and a newline inside one is part
 * of the value rather than the end of the row.
 *
 * Nothing is coerced. A cell is the text it was, because this parses a file for
 * a reader to look at, not for anything to compute with.
 */

/** Rows in order; every row is its own length, since a ragged file is still a file. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  // Set by the first character of a field, so an unquoted field keeps a quote
  // that appears in the middle of it (`a"b`) as the character it is.
  let atFieldStart = true;

  const endField = () => {
    row.push(field);
    field = "";
    atFieldStart = true;
  };
  const endRow = () => {
    endField();
    rows.push(row);
    row = [];
  };

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i]!;
    if (quoted) {
      if (char !== '"') {
        field += char;
        continue;
      }
      // A doubled quote is one quote; a single one ends the quoted run.
      if (text[i + 1] === '"') {
        field += '"';
        i += 1;
        continue;
      }
      quoted = false;
      continue;
    }
    if (char === '"' && atFieldStart) {
      quoted = true;
      atFieldStart = false;
      continue;
    }
    atFieldStart = false;
    if (char === ",") {
      endField();
      continue;
    }
    if (char === "\n") {
      endRow();
      continue;
    }
    if (char === "\r") {
      // CRLF is one break; a lone CR is treated as one too, which costs nothing
      // and reads an old Mac-line-ending export the way its author meant.
      if (text[i + 1] === "\n") {
        i += 1;
      }
      endRow();
      continue;
    }
    field += char;
  }

  // A file ending in a newline has already closed its last row; one that does
  // not still has a row in hand. An empty trailing field is not a row.
  if (field !== "" || row.length > 0) {
    endRow();
  }
  return rows;
}

/** CSV rows with quoted fields, doubled quotes and embedded newlines; values remain strings. */

/** Rows in order; every row is its own length, since a ragged file is still a file. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  // Set by the first character of a field, so an unquoted field keeps a quote
  // that appears in the middle of it (`a"b`) as the character it is.
  let atFieldStart = true;
  /** Track row input separately so quoted empty fields survive and blank lines are skipped. */
  let started = false;

  const endField = () => {
    row.push(field);
    field = "";
    atFieldStart = true;
    started = true;
  };
  const endRow = () => {
    endField();
    rows.push(row);
    row = [];
    started = false;
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
      started = true;
      continue;
    }
    if (char === ",") {
      endField();
      continue;
    }
    if (char === "\n" || char === "\r") {
      // CRLF is one break; a lone CR is treated as one too, which costs nothing
      // and reads an old Mac-line-ending export the way its author meant.
      if (char === "\r" && text[i + 1] === "\n") {
        i += 1;
      }
      // Blank lines are skipped; a quoted empty field is a row.
      if (started) {
        endRow();
      }
      continue;
    }
    atFieldStart = false;
    field += char;
    // Newline delimiters do not start a row.
    started = true;
  }

  // Keep a final row without a line break, including a quoted empty field.
  if (started) {
    endRow();
  }
  return rows;
}

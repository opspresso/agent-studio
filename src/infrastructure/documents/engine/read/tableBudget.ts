import { DocumentError } from "../errors";
import { MAX_SPREADSHEET_CELLS, MAX_SPREADSHEET_COLUMNS, MAX_SPREADSHEET_ROWS, MAX_TABLE_CELL_SPAN } from "../limits";

/** Reject encoded geometry before it can expand a small Office part into a large grid. */
export function tableCellSpan(value: string | undefined): number {
  const count = value === undefined ? 1 : Number(value);
  if (!Number.isSafeInteger(count) || count < 1 || count > MAX_TABLE_CELL_SPAN) {
    throw new DocumentError(`Table cell span must be within 1–${MAX_TABLE_CELL_SPAN}`);
  }
  return count;
}

export function assertTableGeometry(rows: number, columns: number): void {
  if (!Number.isSafeInteger(rows) || rows < 0 || rows > MAX_SPREADSHEET_ROWS ||
      !Number.isSafeInteger(columns) || columns < 0 || columns > MAX_SPREADSHEET_COLUMNS ||
      rows * columns > MAX_SPREADSHEET_CELLS) {
    throw new DocumentError("Table geometry exceeds the document grid budget");
  }
}

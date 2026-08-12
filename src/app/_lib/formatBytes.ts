/**
 * A stored object's size, for a person.
 *
 * Shared the moment it had a second reader rather than after: the gallery asks
 * "why is my bucket big" and a chat asks "is this worth downloading", and the
 * two answers have to be the same number in the same units — a transcript
 * saying `1.5 MB` beside a gallery saying `1,605,516 bytes` reads as two files.
 */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

import { gzipSync } from "node:zlib";

/**
 * A tar writer just large enough to exercise the reader: ustar headers, the
 * GNU `././@LongLink` entry and the pax `path` record for long names, a
 * directory, a symlink. Every entry is built from the same header routine so
 * a test that wants a corrupt archive can flip one byte of a valid one.
 */

export interface TarFixtureEntry {
  path: string;
  content?: string;
  type?: "file" | "dir" | "symlink" | "hardlink";
  /** How a name longer than 100 bytes is carried; default is the GNU entry. */
  longName?: "gnu" | "pax";
  /**
   * Extended-header records written as their own block ahead of this entry —
   * `["size=12"]` becomes one pax record. `scope` picks the block type: `x`
   * applies to the next entry, `g` to the rest of the archive.
   */
  paxRecords?: { scope: "x" | "g"; records: string[] };
}

const BLOCK = 512;

function octal(value: number, width: number): Buffer {
  return Buffer.from(value.toString(8).padStart(width - 1, "0") + "\0", "ascii");
}

export function tarHeader(name: string, size: number, type: string): Buffer {
  const header = Buffer.alloc(BLOCK);
  header.write(name, 0, 100, "utf8");
  octal(0o644, 8).copy(header, 100);
  octal(0, 8).copy(header, 108);
  octal(0, 8).copy(header, 116);
  octal(size, 12).copy(header, 124);
  octal(0, 12).copy(header, 136);
  header.write("        ", 148, "ascii");
  header.write(type, 156, "ascii");
  header.write("ustar\0", 257, "ascii");
  header.write("00", 263, "ascii");
  let sum = 0;
  for (const byte of header) {
    sum += byte;
  }
  header.write(sum.toString(8).padStart(6, "0") + "\0 ", 148, "ascii");
  return header;
}

function padded(data: Buffer): Buffer {
  const rest = data.byteLength % BLOCK;
  return rest === 0 ? data : Buffer.concat([data, Buffer.alloc(BLOCK - rest)]);
}

function paxRecord(record: string): Buffer {
  const text = ` ${record}\n`;
  const bytes = Buffer.byteLength(text, "utf8");
  let length = bytes + 1;
  for (;;) {
    const counted = bytes + String(length).length;
    if (counted === length) return Buffer.from(`${length}${text}`, "utf8");
    length = counted;
  }
}

export function writeTar(entries: TarFixtureEntry[]): Buffer {
  const parts: Buffer[] = [];
  for (const entry of entries) {
    const type = entry.type ?? "file";
    const data = Buffer.from(entry.content ?? "", "utf8");
    if (entry.paxRecords) {
      const body = Buffer.concat(entry.paxRecords.records.map(paxRecord));
      parts.push(
        tarHeader("PaxHeader/x", body.byteLength, entry.paxRecords.scope),
        padded(body),
      );
    }
    let name = entry.path;
    if (Buffer.byteLength(name, "utf8") > 100) {
      if (entry.longName === "pax") {
        const pax = paxRecord(`path=${name}`);
        parts.push(tarHeader("PaxHeader/x", pax.byteLength, "x"), padded(pax));
      } else {
        const long = Buffer.from(`${name}\0`, "utf8");
        parts.push(tarHeader("././@LongLink", long.byteLength, "L"), padded(long));
      }
      name = name.slice(0, 100);
    }
    const flag = { file: "0", dir: "5", symlink: "2", hardlink: "1" }[type];
    const size = type === "file" ? data.byteLength : 0;
    parts.push(tarHeader(name, size, flag));
    if (size > 0) {
      parts.push(padded(data));
    }
  }
  parts.push(Buffer.alloc(BLOCK * 2));
  return Buffer.concat(parts);
}

export function writeTarGz(entries: TarFixtureEntry[]): Buffer {
  return gzipSync(writeTar(entries));
}

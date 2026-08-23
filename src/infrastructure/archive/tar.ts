/**
 * A tar reader over a buffer, for the plugins archive an admin uploads where
 * GitHub is unreachable. Dependency-free on purpose: the format is 512-byte
 * headers and the two extensions every `git archive` and GNU `tar` output uses
 * — a GNU `././@LongLink` entry and a pax `path` record for names over 100
 * bytes. A library would add a streaming API and a dozen flags for a feature
 * that reads one small tarball into memory and is done.
 *
 * What it yields is regular files, plus a symlink's *name* — no target, no
 * bytes — so the tree walker can report it the way it reports one git lists
 * (`selectSkillAttachments` refuses the symlink mode) rather than having it
 * vanish. Directories are consumed and dropped (a file's path implies its
 * directories); hard links, devices and anything else are stepped over.
 *
 * A path that could leave the tree — absolute, `..`, a backslash — refuses
 * the whole archive rather than skipping the entry: an archive that carries
 * one is hostile or broken, and neither deserves a partial sync.
 */

import { gunzipSync } from "node:zlib";
import { normalizeSkillFilePath } from "@/domain/skill/files";

/** Ceiling on the archive once inflated; the reader stops inflating at it. */
export const MAX_ARCHIVE_BYTES = 64 * 1024 * 1024;
/** Ceiling on header count — files, directories and extension records alike. */
export const MAX_ARCHIVE_ENTRIES = 20_000;

export interface TarFile {
  /** Clean `a/b/c` form, never absolute, never through `..`. */
  path: string;
  /** Empty for a symlink: the target is not carried, only the fact of one. */
  bytes: Buffer;
  symlink: boolean;
}

export interface TarLimits {
  maxBytes: number;
  maxEntries: number;
}

/** An archive that cannot be used, with the reason in words an uploader can act on. */
export class TarArchiveError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TarArchiveError";
  }
}

const BLOCK = 512;

/** Byte offsets of the header fields this reader needs. */
const Field = { Name: 0, Size: 124, Checksum: 148, Type: 156, Magic: 257, Prefix: 345 } as const;

/** Read the archive — gzip-compressed or plain — into its regular files. */
export function readTarArchive(
  input: Uint8Array,
  limits: TarLimits = { maxBytes: MAX_ARCHIVE_BYTES, maxEntries: MAX_ARCHIVE_ENTRIES },
): TarFile[] {
  const bytes = inflate(input, limits.maxBytes);
  if (bytes.byteLength > limits.maxBytes) {
    throw new TarArchiveError(`archive exceeds ${limits.maxBytes} bytes uncompressed`);
  }
  if (bytes.byteLength < BLOCK) {
    throw new TarArchiveError("not a tar archive: shorter than one header block");
  }

  const files: TarFile[] = [];
  let offset = 0;
  let entries = 0;
  // Overrides the next header's own fields: a GNU long name, or a pax record.
  let longName: string | undefined;
  let pax: { path?: string; size?: number } = {};

  while (offset + BLOCK <= bytes.byteLength) {
    const header = bytes.subarray(offset, offset + BLOCK);
    if (isZeroBlock(header)) {
      break; // End-of-archive marker; the second zero block is not required.
    }
    if (!checksumMatches(header)) {
      throw new TarArchiveError(
        offset === 0
          ? "not a tar archive (expected a .tar.gz or .tar of the plugins repository)"
          : `corrupt tar header at byte ${offset}`,
      );
    }
    entries += 1;
    if (entries > limits.maxEntries) {
      throw new TarArchiveError(`archive holds more than ${limits.maxEntries} entries`);
    }

    const type = String.fromCharCode(header[Field.Type] ?? 0);
    const size = pax.size ?? parseNumeric(header.subarray(Field.Size, Field.Size + 12), offset);
    const dataStart = offset + BLOCK;
    const dataEnd = dataStart + size;
    if (dataEnd > bytes.byteLength) {
      throw new TarArchiveError(`truncated archive: entry at byte ${offset} runs past the end`);
    }
    const data = bytes.subarray(dataStart, dataEnd);
    offset = dataStart + Math.ceil(size / BLOCK) * BLOCK;

    switch (type) {
      case "L": // GNU `././@LongLink`: the real name is this entry's data.
        longName = cString(data);
        continue;
      case "x": // pax extended header: records for the next entry.
        pax = parsePaxRecords(data, offset);
        continue;
      case "K": // GNU long link target — links are skipped anyway.
      case "g": // pax global header.
        continue;
      default:
        break;
    }

    const rawName = pax.path ?? longName ?? headerName(header);
    longName = undefined;
    pax = {};

    if (type === "5" || rawName.endsWith("/")) {
      continue; // A directory; its files carry the path.
    }
    if (type === "2") {
      files.push({ path: safePath(rawName), bytes: Buffer.alloc(0), symlink: true });
      continue;
    }
    if (type !== "0" && type !== "\0" && type !== "7") {
      continue; // Hard link, device, FIFO — nothing a repository holds.
    }
    files.push({ path: safePath(rawName), bytes: Buffer.from(data), symlink: false });
  }

  return files;
}

/**
 * Drop the one directory every path sits under, when there is one — what
 * `git archive --prefix=<name>/` and `tar czf` of a checkout both produce.
 * A repository whose files all happen to live in one top-level directory
 * loses that directory too; the plugin roots are found wherever they are, so
 * the sync still works, only with shorter root paths.
 */
export function stripLeadingDirectory(files: TarFile[]): {
  files: TarFile[];
  prefix: string | null;
} {
  const first = files[0];
  if (!first) {
    return { files, prefix: null };
  }
  const slash = first.path.indexOf("/");
  if (slash < 0) {
    return { files, prefix: null };
  }
  const prefix = first.path.slice(0, slash + 1);
  if (!files.every((file) => file.path.startsWith(prefix))) {
    return { files, prefix: null };
  }
  return {
    files: files.map((file) => ({ ...file, path: file.path.slice(prefix.length) })),
    prefix: prefix.slice(0, -1),
  };
}

function inflate(input: Uint8Array, maxBytes: number): Buffer {
  if (input[0] !== 0x1f || input[1] !== 0x8b) {
    return Buffer.from(input.buffer, input.byteOffset, input.byteLength);
  }
  try {
    // zlib stops at the cap rather than inflating first and measuring after,
    // which is what makes a 64MB ceiling mean something for a gzip bomb.
    return gunzipSync(input, { maxOutputLength: maxBytes });
  } catch (error) {
    if (error instanceof RangeError) {
      throw new TarArchiveError(`archive exceeds ${maxBytes} bytes uncompressed`);
    }
    throw new TarArchiveError("not a valid gzip stream");
  }
}

function isZeroBlock(block: Uint8Array): boolean {
  return block.every((byte) => byte === 0);
}

/**
 * The header's own checksum is the sum of its bytes with the checksum field
 * read as spaces. Unsigned by the standard; a signed sum is accepted too,
 * since some old writers produced one.
 */
function checksumMatches(header: Uint8Array): boolean {
  const stored = parseOctal(header.subarray(Field.Checksum, Field.Checksum + 8));
  if (stored === null) {
    return false;
  }
  let unsigned = 0;
  let signed = 0;
  for (let i = 0; i < BLOCK; i += 1) {
    const byte = i >= Field.Checksum && i < Field.Checksum + 8 ? 0x20 : (header[i] ?? 0);
    unsigned += byte;
    signed += byte < 128 ? byte : byte - 256;
  }
  return stored === unsigned || stored === signed;
}

function cString(field: Uint8Array): string {
  const end = field.indexOf(0);
  return Buffer.from(end < 0 ? field : field.subarray(0, end)).toString("utf8");
}

/** The name field, joined to the ustar prefix field when the magic says there is one. */
function headerName(header: Uint8Array): string {
  const name = cString(header.subarray(Field.Name, Field.Name + 100));
  const magic = Buffer.from(header.subarray(Field.Magic, Field.Magic + 5)).toString("latin1");
  if (magic !== "ustar") {
    return name;
  }
  const prefix = cString(header.subarray(Field.Prefix, Field.Prefix + 155));
  return prefix === "" ? name : `${prefix}/${name}`;
}

function parseOctal(field: Uint8Array): number | null {
  const text = cString(field).trim();
  if (text === "") {
    return 0;
  }
  if (!/^[0-7]+$/.test(text)) {
    return null;
  }
  return Number.parseInt(text, 8);
}

/**
 * A numeric field is octal text, or — GNU's extension for values over 8GB —
 * base-256 with the top bit of the first byte set. The second form is read
 * so a header using it fails on the size cap, not on a parse error that
 * hides what the archive is.
 */
function parseNumeric(field: Uint8Array, offset: number): number {
  if (((field[0] ?? 0) & 0x80) !== 0) {
    let value = 0;
    for (let i = 0; i < field.length; i += 1) {
      const byte = i === 0 ? (field[0] ?? 0) & 0x7f : (field[i] ?? 0);
      value = value * 256 + byte;
    }
    return value;
  }
  const value = parseOctal(field);
  if (value === null) {
    throw new TarArchiveError(`corrupt tar header at byte ${offset}: bad size field`);
  }
  return value;
}

/** pax records are `<decimal length> <key>=<value>\n`, the length counting the whole record. */
function parsePaxRecords(data: Uint8Array, offset: number): { path?: string; size?: number } {
  const text = Buffer.from(data).toString("utf8");
  const records: { path?: string; size?: number } = {};
  let at = 0;
  while (at < text.length) {
    const space = text.indexOf(" ", at);
    const length = space > at ? Number.parseInt(text.slice(at, space), 10) : Number.NaN;
    if (!Number.isInteger(length) || length <= 0 || at + length > text.length) {
      throw new TarArchiveError(`corrupt pax header before byte ${offset}`);
    }
    const record = text.slice(space + 1, at + length - 1);
    const equals = record.indexOf("=");
    if (equals > 0) {
      const key = record.slice(0, equals);
      const value = record.slice(equals + 1);
      if (key === "path") {
        records.path = value;
      } else if (key === "size") {
        const size = Number.parseInt(value, 10);
        if (!Number.isInteger(size) || size < 0) {
          throw new TarArchiveError(`corrupt pax header before byte ${offset}: bad size`);
        }
        records.size = size;
      }
    }
    at += length;
  }
  return records;
}

/**
 * The path an entry may take, or the refusal. The rule is the one the skill
 * attachment resolver already owns — relative, no `..`, no backslash, no empty
 * segment — since what this reader feeds is the same tree walker; a leading
 * `./` (what `tar czf .` writes) is dropped first because that walker counts
 * a `.` segment as empty.
 */
function safePath(rawName: string): string {
  const name = rawName.replace(/^(\.\/)+/, "");
  const normalized = normalizeSkillFilePath(name);
  if (!normalized.ok) {
    throw new TarArchiveError(`refusing archive entry "${rawName}": path is ${normalized.reason}`);
  }
  return normalized.path;
}

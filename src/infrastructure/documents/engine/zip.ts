/**
 * The zip container, which DOCX and HWPX both are.
 *
 * A zip is the one input shape here where a small upload can ask for an
 * arbitrarily large allocation: the compression ratio belongs to whoever built
 * the archive. So nothing is inflated until the central directory has been read
 * and counted — `listEntries` walks it with a filter that inflates nothing, and
 * `readEntries` only runs once those numbers are inside the budget.
 *
 * Entry names are never used as paths. Reading is by exact name
 * (`word/document.xml`), and writing composes the names itself, so there is no
 * point at which one reaches a filesystem. The traversal check below is not
 * defending a directory; it is refusing an archive that was built to be
 * mishandled, which is a thing worth knowing about a document.
 */

import { unzipSync, zipSync, type Zippable } from "fflate";
import {
  MAX_COMPRESSION_RATIO,
  MAX_EXPANDED_BYTES,
  MAX_ZIP_ENTRIES,
  MAX_ZIP_ENTRY_BYTES,
} from "./limits";
import { DocumentError } from "./errors";

export class ZipError extends DocumentError {}

export interface ZipEntry {
  name: string;
  /** What the central directory says the compressed stream occupies. */
  compressedSize: number;
  /** What the central directory says this inflates to. */
  originalSize: number;
}

/** `PK\x03\x04` — a local file header, which every non-empty zip starts with. */
export function looksLikeZip(bytes: Uint8Array): boolean {
  return (
    bytes.length >= 4 &&
    bytes[0] === 0x50 &&
    bytes[1] === 0x4b &&
    bytes[2] === 0x03 &&
    bytes[3] === 0x04
  );
}

function traversal(name: string): boolean {
  return name.startsWith("/") || name.split("/").includes("..");
}

/**
 * Every entry the central directory declares, without inflating any of them.
 *
 * fflate calls the filter once per entry and skips the ones it refuses, so
 * refusing all of them turns `unzipSync` into a directory walk.
 */
export function listEntries(bytes: Uint8Array): ZipEntry[] {
  const entries: ZipEntry[] = [];
  try {
    unzipSync(bytes, {
      filter(file) {
        entries.push({
          name: file.name,
          compressedSize: file.size,
          originalSize: file.originalSize,
        });
        return false;
      },
    });
  } catch (error) {
    throw new ZipError(`the archive could not be read — ${describe(error)}`);
  }
  return entries;
}

/**
 * Refuse an archive whose declared contents are outside the budget.
 *
 * Declared, not measured: measuring means inflating, and inflating is the thing
 * being defended against. A liar's declaration is caught by the second pass —
 * fflate stops at the size it was told — so the worst an understated header buys
 * is one entry's worth of work.
 */
export function checkBudget(entries: ZipEntry[]): void {
  if (entries.length === 0) {
    throw new ZipError("the archive is empty");
  }
  if (entries.length > MAX_ZIP_ENTRIES) {
    throw new ZipError(
      `the archive has ${entries.length.toLocaleString("en-US")} entries, over the ` +
        `${MAX_ZIP_ENTRIES.toLocaleString("en-US")} limit`,
    );
  }
  const oversized = entries.find((entry) => entry.originalSize > MAX_ZIP_ENTRY_BYTES);
  if (oversized) {
    throw new ZipError(
      `the archive entry "${oversized.name}" expands to ` +
        `${oversized.originalSize.toLocaleString("en-US")} bytes, over the ` +
        `${MAX_ZIP_ENTRY_BYTES.toLocaleString("en-US")} per-entry limit`,
    );
  }
  const extreme = entries.find(
    (entry) =>
      entry.originalSize > 0 &&
      entry.originalSize / Math.max(1, entry.compressedSize) > MAX_COMPRESSION_RATIO,
  );
  if (extreme) {
    throw new ZipError(
      `the archive entry "${extreme.name}" expands at more than the ` +
        `${MAX_COMPRESSION_RATIO}:1 compression-ratio limit`,
    );
  }
  const total = entries.reduce((sum, entry) => sum + entry.originalSize, 0);
  if (total > MAX_EXPANDED_BYTES) {
    throw new ZipError(
      `the archive expands to ${total.toLocaleString("en-US")} bytes, over the ` +
        `${MAX_EXPANDED_BYTES.toLocaleString("en-US")} limit`,
    );
  }
  const escaping = entries.find((entry) => traversal(entry.name));
  if (escaping) {
    throw new ZipError(
      `the archive contains an entry named "${escaping.name}", which is not a name a document uses`,
    );
  }
}

/**
 * Inflate the named entries, and only those.
 *
 * A name that is not in the archive is simply absent from the result: which
 * parts a format requires is the format reader's question, and it can say what
 * is missing in its own words.
 */
export function readEntries(bytes: Uint8Array, names: readonly string[]): Map<string, Uint8Array> {
  const wanted = new Set(names);
  try {
    const files = unzipSync(bytes, { filter: (file) => wanted.has(file.name) });
    return new Map(Object.entries(files));
  } catch (error) {
    throw new ZipError(`the archive could not be read — ${describe(error)}`);
  }
}

/** List, check, then inflate — the order every caller wants and none should re-derive. */
export function openZip(bytes: Uint8Array): {
  entries: ZipEntry[];
  read: (names: readonly string[]) => Map<string, Uint8Array>;
} {
  const entries = listEntries(bytes);
  checkBudget(entries);
  return { entries, read: (names) => readEntries(bytes, names) };
}

/**
 * Build an archive.
 *
 * Insertion order is preserved, which HWPX depends on: its `mimetype` entry has
 * to come first and be stored rather than deflated, the same rule ODF packaging
 * uses, and a reader that checks for it checks at offset 30.
 */
export function buildZip(parts: Zippable): Uint8Array {
  return zipSync(parts, { level: 6 });
}

/** An entry to be stored rather than deflated — `mimetype`, and nothing else so far. */
export function stored(data: Uint8Array): [Uint8Array, { level: 0 }] {
  return [data, { level: 0 }];
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

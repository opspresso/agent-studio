/** Document parser and renderer work budgets. Transport limits belong to the caller. */

/**
 * Extracted text handed back to the caller.
 *
 * Agent Studio truncates a tool result at 100,000 characters and appends a
 * generic notice (`infrastructure/mcp/toolManager.ts`). Cutting first, below
 * that, keeps the notice *this* server writes — which can name pages and
 * totals — instead of one that only says a limit was hit.
 */
export { MAX_DOCUMENT_TOOL_CHARS as MAX_TEXT_CHARS } from "@/domain/document/processor";

/**
 * Markdown accepted by `render_document`.
 *
 * Well inside the body cap, so this is about the renderers rather than about
 * transport: each one walks the block list building a whole document in memory,
 * and half a million characters is already a document nobody will read.
 */
export const MAX_MARKDOWN_CHARS = 500_000;

/**
 * What a compressed document may expand to, and how many parts it may have.
 *
 * DOCX and HWPX are zips and an HWP section is raw deflate, which means a small
 * upload can ask for an unbounded allocation — the compression ratio is the
 * archive author's to choose. The zip path checks what the central directory
 * *declares* before inflating anything, so a bomb costs a header read rather
 * than the memory it wanted; the HWP path has no such declaration and caps the
 * inflater's output instead.
 */
export const MAX_ZIP_ENTRIES = 2_000;
export const MAX_EXPANDED_BYTES = 100 * 1024 * 1024;
export const MAX_ZIP_ENTRY_BYTES = 25 * 1024 * 1024;
export const MAX_COMPRESSION_RATIO = 1_000;

/** Parser work budgets below the archive byte ceiling. */
export const MAX_XML_EVENTS = 1_000_000;
export const MAX_XML_DEPTH = 256;
export const MAX_SPREADSHEET_ROWS = 100_000;
export const MAX_SPREADSHEET_CELLS = 1_000_000;
export const MAX_INSPECTED_CELLS = 10_000;

/** Excel worksheet coordinates, independent of how many populated cells are parsed. */
export const MAX_SPREADSHEET_COLUMNS = 16_384;
export const MAX_SPREADSHEET_ROW_INDEX = 1_048_576;

/** ODF merged-cell geometry bound; repeated content uses the spreadsheet budgets above. */
export const MAX_ODF_CELL_SPAN = 256;

/**
 * Blocks one `inspect_document` call may describe, and how much of each block's
 * own text a line shows.
 *
 * One budget from two sides, like every other pair here. A line is its keys
 * plus a preview — around 160 characters at this preview length — so 500 lines
 * lands near 80,000, inside `MAX_TEXT_CHARS` and inside the caller's own
 * 100,000-character cut with the provenance header on top of it. Raising
 * either without the other produces a window that is always cut before it is
 * filled.
 */
export const MAX_INSPECTED_BLOCKS = 500;
export const MAX_BLOCK_PREVIEW_CHARS = 120;

/**
 * Image assets accepted alongside `render_document`'s Markdown.
 *
 * Both bound the same thing from different sides: the count keeps the media
 * folder honest, and the byte total keeps the rendered deck under
 * `MAX_RENDERED_BYTES` — an image is stored in the zip roughly as it arrived,
 * so a deck's size is mostly its pictures.
 */
export { MAX_DOCUMENT_ASSETS as MAX_ASSET_COUNT } from "@/domain/document/processor";
export { MAX_DOCUMENT_ASSET_BYTES as MAX_ASSET_TOTAL_BYTES } from "@/domain/document/processor";

/**
 * How large a rendered document may be in one response.
 *
 * Below the caller's own transport ceiling with room for base64's 4/3 inflation.
 * Refusing here with a sentence beats letting the envelope be cut: a truncated
 * JSON-RPC response arrives as a parse failure, which tells nobody that the
 * document was simply too big.
 */
export const MAX_RENDERED_BYTES = 10_000_000;

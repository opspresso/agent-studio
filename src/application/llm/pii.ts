import { randomInt } from "node:crypto";

const EMAIL_PATTERN = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i;
const PHONE_PATTERN =
  /(?<![\w])(?:\+\d{1,3}[\s.-]?)?(?:\(?\d{2,4}\)?[\s.-]?)\d{3,4}[\s.-]?\d{4}(?![\w])/;
// Korean resident/foreigner registration number: YYMMDD-GABCDEF. The date half is
// validated in the pattern and the 7th digit is 1-8 (covers natives and foreigners).
// No mod-11 checksum on purpose — numbers issued since 2020-10 randomise the check
// digit, so a checksum would miss exactly the newest ones. Hyphenated form only:
// a bare 13-digit run is any order id.
const RRN_PATTERN = /(?<!\d)\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])-[1-8]\d{6}(?!\d)/;
// Payment card: 13-19 digits with a consistent separator (none, space, dot or
// hyphen). The trailing guard stops at digits only, so a card with a suffix
// bolted on (`4111-1111-1111-1111-01`) still masks the card and leaves the
// suffix; a card fused into a longer digit run stays an order id, like the bare
// 13-digit RRN above. A match still has to pass Luhn in maskSegment; one that
// fails is re-scanned with CARD_REJECTED_PATTERN below rather than skipped.
const CARD_PATTERN = /(?<!\d)\d{4}(?<cardsep>[ .-]?)\d{4}\k<cardsep>\d{4}\k<cardsep>\d{1,7}(?!\d)/;
// Alternation is first-match-wins, so the order is the precedence. Email stays
// first: a local part can contain what looks like an RRN or a card, and the whole
// address must mask as one token. RRN and card come before phone, or the phone
// pattern partially masks a separated card (`4111-1111-1111` of
// `4111-1111-1111-1111`) and leaves the tail in the clear.
const PII_PATTERN = new RegExp(
  `${EMAIL_PATTERN.source}|(?<rrn>${RRN_PATTERN.source})|(?<card>${CARD_PATTERN.source})|${PHONE_PATTERN.source}`,
  "gi",
);
// What a Luhn-rejected card span is re-scanned with. Returning the whole span
// untouched could expose a phone-shaped prefix such as `4111 1111 1111`; of the
// other branches only phone can match digits and separators.
const CARD_REJECTED_PATTERN = new RegExp(PHONE_PATTERN.source, "gi");

function passesLuhn(digits: string): boolean {
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i -= 1) {
    let digit = digits.charCodeAt(i) - 48;
    if (double) {
      digit *= 2;
      if (digit > 9) {
        digit -= 9;
      }
    }
    sum += digit;
    double = !double;
  }
  return sum % 10 === 0;
}

function randomLetter(source: string): string {
  const base = source === source.toUpperCase() ? 65 : 97;
  return String.fromCharCode(base + randomInt(26));
}

/**
 * What a replacement is wrapped in — the writer below and the three readers
 * further down are the only things that know this shape, and they have to agree
 * on it.
 *
 * The wrapping is what makes every scan **marker-driven**: a reader looks for
 * `[[PII:` and then for `]]`, and asks the table about the one span it found.
 * Asking the table for *every* entry instead is the same answer at a cost that
 * grows with the mapping: a run that masked four thousand addresses spent five
 * seconds of blocked event loop restoring one turn's stream, because each of
 * the thousands of small chunks re-scanned the whole table twice. Neither
 * marker can occur inside a replacement — no pattern this file matches admits a
 * bracket — so the span a reader finds is unambiguous.
 */
const TOKEN_OPEN = "[[PII:";
const TOKEN_CLOSE = "]]";

/**
 * The next span of `value` at or after `from` that this table minted, or
 * nothing. A marker-shaped span the table does not know is **not** a token: it
 * is text this filter never wrote, and the scan resumes inside it so a real
 * token starting there is still found. That distinction is what keeps a literal
 * `[[PII:a@b.co]]` in a model's output masked rather than waved through.
 */
function nextToken(
  value: string,
  from: number,
  minted: ReadonlyMap<string, string>,
): { start: number; end: number; text: string } | undefined {
  for (let scan = from; ; ) {
    const open = value.indexOf(TOKEN_OPEN, scan);
    if (open < 0) {
      return undefined;
    }
    const close = value.indexOf(TOKEN_CLOSE, open + TOKEN_OPEN.length);
    if (close < 0) {
      // No close anywhere after this open, so no later open has one either.
      return undefined;
    }
    const end = close + TOKEN_CLOSE.length;
    const text = value.slice(open, end);
    if (minted.has(text)) {
      return { start: open, end, text };
    }
    scan = open + TOKEN_OPEN.length;
  }
}

function formatPreservingReplacement(value: string): string {
  const replacement = [...value]
    .map((char) => {
      if (/[A-Z]/i.test(char)) {
        return randomLetter(char);
      }
      if (/\d/.test(char)) {
        return String(randomInt(10));
      }
      return char;
    })
    .join("");
  return `${TOKEN_OPEN}${replacement}${TOKEN_CLOSE}`;
}

export class PiiFilter {
  private readonly replacementByOriginal = new Map<string, string>();
  private readonly originalByReplacement = new Map<string, string>();
  /** The longest token minted so far; how far a stream restorer may hold. */
  private longestToken = 0;

  /** Only persisted inside authenticated, encrypted runtime checkpoints. */
  snapshot(): Array<[string, string]> {
    return [...this.replacementByOriginal.entries()];
  }

  static restoreSnapshot(entries: Array<[string, string]>): PiiFilter {
    const filter = new PiiFilter();
    for (const [original, replacement] of entries) {
      if (typeof original !== "string" || typeof replacement !== "string" || !replacement.startsWith(TOKEN_OPEN) || !replacement.endsWith(TOKEN_CLOSE)) throw new Error("Invalid PII checkpoint");
      if (filter.originalByReplacement.has(replacement)) throw new Error("Duplicate PII checkpoint token");
      filter.replacementByOriginal.set(original, replacement);
      filter.originalByReplacement.set(replacement, original);
      filter.longestToken = Math.max(filter.longestToken, replacement.length);
    }
    return filter;
  }

  /**
   * Text already carrying this filter's own tokens is masked again — a child
   * shares its parent's filter, so a transferred answer arrives holding them
   * and the parent masks it once more on the way into its own context. A token
   * therefore has to survive the pass untouched; what sits between two of them
   * is ordinary text and is scanned like any other.
   */
  mask(value: string): string {
    let masked = "";
    let segmentStart = 0;
    for (;;) {
      const token = nextToken(value, segmentStart, this.originalByReplacement);
      if (!token) {
        break;
      }
      masked += this.maskSegment(value.slice(segmentStart, token.start)) + token.text;
      segmentStart = token.end;
    }
    return masked + this.maskSegment(value.slice(segmentStart));
  }

  private maskSegment(value: string): string {
    return value.replace(PII_PATTERN, (original, ...args) => {
      const groups = args.at(-1) as Record<string, string | undefined>;
      // A digit run that merely looks like a card (an order id, a tracking
      // number) fails Luhn and is not masked as a card — but the span is
      // re-scanned, not returned as-is, so the phone branch keeps the partial
      // mask it applied before the card branch existed.
      if (groups.card !== undefined && !passesLuhn(original.replace(/\D/g, ""))) {
        return original.replace(CARD_REJECTED_PATTERN, (fallback) =>
          this.replacementFor(fallback),
        );
      }
      return this.replacementFor(original);
    });
  }

  private replacementFor(original: string): string {
    const existing = this.replacementByOriginal.get(original);
    if (existing) {
      return existing;
    }

    let replacement = formatPreservingReplacement(original);
    while (
      replacement === original ||
      this.originalByReplacement.has(replacement) ||
      this.replacementByOriginal.has(replacement)
    ) {
      replacement = formatPreservingReplacement(original);
    }
    this.replacementByOriginal.set(original, replacement);
    this.originalByReplacement.set(replacement, original);
    this.longestToken = Math.max(this.longestToken, replacement.length);
    return replacement;
  }

  restore(value: string): string {
    let restored = "";
    let at = 0;
    for (;;) {
      const token = nextToken(value, at, this.originalByReplacement);
      if (!token) {
        return at === 0 ? value : restored + value.slice(at);
      }
      restored += value.slice(at, token.start) + this.originalByReplacement.get(token.text);
      at = token.end;
    }
  }

  createStreamRestorer(): PiiStreamRestorer {
    // Read live rather than copied: the mapping keeps growing while a turn
    // streams, and a restorer holding a snapshot of its longest token would
    // release a partial one that was about to complete.
    return new PiiStreamRestorer(this.originalByReplacement, () => this.longestToken);
  }
}

export class PiiStreamRestorer {
  private pending = "";

  constructor(
    private readonly originalByReplacement: ReadonlyMap<string, string>,
    private readonly longestToken: () => number,
  ) {}

  /**
   * The restored text this chunk completes, holding back only what the next one
   * could still finish: a token whose close has not arrived, or a prefix of the
   * opening marker at the very end.
   */
  push(chunk: string): string {
    this.pending += chunk;
    let output = "";
    let emitted = 0;
    // Where the next chunk's scan resumes. Everything before it is settled.
    let settled = this.pending.length;
    for (let scan = 0; scan < this.pending.length; ) {
      const open = this.pending.indexOf(TOKEN_OPEN, scan);
      if (open < 0) {
        break;
      }
      const close = this.pending.indexOf(TOKEN_CLOSE, open + TOKEN_OPEN.length);
      if (close < 0) {
        // Its close may be in the next chunk — unless what has accumulated is
        // already longer than any token minted, in which case it is text.
        if (this.pending.length - open <= this.longestToken()) {
          settled = open;
          break;
        }
        scan = open + TOKEN_OPEN.length;
        continue;
      }
      const end = close + TOKEN_CLOSE.length;
      const original = this.originalByReplacement.get(this.pending.slice(open, end));
      if (original === undefined) {
        scan = open + TOKEN_OPEN.length;
        continue;
      }
      output += this.pending.slice(emitted, open) + original;
      emitted = end;
      scan = end;
    }
    if (settled === this.pending.length) {
      settled -= partialOpenLength(this.pending);
    }
    output += this.pending.slice(emitted, settled);
    this.pending = this.pending.slice(settled);
    return output;
  }

  flush(): string {
    const output = this.pending;
    this.pending = "";
    return output;
  }
}

/**
 * How much of `text`'s tail is a prefix of the opening marker — the only thing
 * left worth holding once no token is pending. At most five characters, so a
 * stream that never carries a token is never buffered.
 */
function partialOpenLength(text: string): number {
  const longest = Math.min(TOKEN_OPEN.length - 1, text.length);
  for (let length = longest; length > 0; length -= 1) {
    if (TOKEN_OPEN.startsWith(text.slice(text.length - length))) {
      return length;
    }
  }
  return 0;
}

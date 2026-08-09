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
// Payment card: 13-19 digits with a consistent separator (none, space or hyphen).
// A match still has to pass Luhn in maskSegment, or it is left alone.
const CARD_PATTERN = /(?<!\d)\d{4}(?<cardsep>[ -]?)\d{4}\k<cardsep>\d{4}\k<cardsep>\d{1,7}(?![\d-])/;
// Alternation is first-match-wins, so the order is the precedence. Email stays
// first: a local part can contain what looks like an RRN or a card, and the whole
// address must mask as one token. RRN and card come before phone, or the phone
// pattern partially masks a separated card (`4111-1111-1111` of
// `4111-1111-1111-1111`) and leaves the tail in the clear.
const PII_PATTERN = new RegExp(
  `${EMAIL_PATTERN.source}|(?<rrn>${RRN_PATTERN.source})|(?<card>${CARD_PATTERN.source})|${PHONE_PATTERN.source}`,
  "gi",
);

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
  return `[[PII:${replacement}]]`;
}

export class PiiFilter {
  private readonly replacementByOriginal = new Map<string, string>();
  private readonly originalByReplacement = new Map<string, string>();

  mask(value: string): string {
    let masked = "";
    let cursor = 0;

    while (cursor < value.length) {
      let earliestIndex = -1;
      let earliestReplacement = "";
      for (const replacement of this.originalByReplacement.keys()) {
        const index = value.indexOf(replacement, cursor);
        if (index >= 0 && (earliestIndex < 0 || index < earliestIndex)) {
          earliestIndex = index;
          earliestReplacement = replacement;
        }
      }

      const segmentEnd = earliestIndex >= 0 ? earliestIndex : value.length;
      masked += this.maskSegment(value.slice(cursor, segmentEnd));
      if (earliestIndex < 0) {
        break;
      }
      masked += earliestReplacement;
      cursor = earliestIndex + earliestReplacement.length;
    }

    return masked;
  }

  private maskSegment(value: string): string {
    return value.replace(PII_PATTERN, (original, ...args) => {
      const groups = args.at(-1) as Record<string, string | undefined>;
      // A digit run that merely looks like a card (an order id, a tracking number)
      // fails Luhn and stays untouched.
      if (groups.card !== undefined && !passesLuhn(original.replace(/\D/g, ""))) {
        return original;
      }
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
      return replacement;
    });
  }

  restore(value: string): string {
    let restored = value;
    for (const [replacement, original] of this.originalByReplacement) {
      restored = restored.replaceAll(replacement, original);
    }
    return restored;
  }

  createStreamRestorer(): PiiStreamRestorer {
    return new PiiStreamRestorer(this.originalByReplacement);
  }
}

export class PiiStreamRestorer {
  private pending = "";

  constructor(private readonly originalByReplacement: ReadonlyMap<string, string>) {}

  push(chunk: string): string {
    this.pending += chunk;
    let output = "";

    while (this.pending) {
      let earliestIndex = -1;
      let earliestReplacement = "";
      for (const replacement of this.originalByReplacement.keys()) {
        const index = this.pending.indexOf(replacement);
        if (index >= 0 && (earliestIndex < 0 || index < earliestIndex)) {
          earliestIndex = index;
          earliestReplacement = replacement;
        }
      }

      if (earliestIndex >= 0) {
        output += this.pending.slice(0, earliestIndex);
        output += this.originalByReplacement.get(earliestReplacement) ?? earliestReplacement;
        this.pending = this.pending.slice(earliestIndex + earliestReplacement.length);
        continue;
      }

      let suffixLength = 0;
      for (const replacement of this.originalByReplacement.keys()) {
        const maxLength = Math.min(this.pending.length, replacement.length - 1);
        for (let length = maxLength; length > suffixLength; length -= 1) {
          if (replacement.startsWith(this.pending.slice(-length))) {
            suffixLength = length;
            break;
          }
        }
      }

      output += this.pending.slice(0, this.pending.length - suffixLength);
      this.pending = this.pending.slice(this.pending.length - suffixLength);
      break;
    }

    return output;
  }

  flush(): string {
    const output = this.pending;
    this.pending = "";
    return output;
  }
}

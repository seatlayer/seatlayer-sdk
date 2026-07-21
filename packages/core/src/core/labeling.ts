/**
 * Pure row/seat labeling helpers used by the designer's "relabel" tools
 * (e.g. bulk-renumber rows A, B, C… or 1, 2, 3…). No dependencies.
 */

export interface RelabelOptions {
  scheme: 'letters' | 'numbers';
  /** 1-based start: letters 1=A; numbers 1=1. */
  startAt: number;
  /** Letters only: skip I and O (common theatre convention). */
  skipAmbiguous?: boolean;
  /** Apply labels in reverse order over the given array. */
  reverse?: boolean;
}

const FULL_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const SAFE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ'; // no I, no O

const LOWER_ALPHABET = 'abcdefghijklmnopqrstuvwxyz';

/**
 * Bijective base-N conversion: 0 -> first letter, N -> second letter's
 * first repeat cycle (e.g. base26: 25 -> 'Z', 26 -> 'AA').
 */
export function toBijectiveBase(index: number, alphabet: string): string {
  const base = alphabet.length;
  let n = index + 1; // bijective numeration is 1-based
  let out = '';
  while (n > 0) {
    n -= 1;
    const rem = n % base;
    out = alphabet[rem] + out;
    n = Math.floor(n / base);
  }
  return out;
}

export function indexLabel(i: number, opts: RelabelOptions): string {
  const start = opts.startAt - 1; // convert 1-based startAt to 0-based offset
  const idx = i + start;
  if (opts.scheme === 'numbers') {
    return String(idx + 1);
  }
  const alphabet = opts.skipAmbiguous ? SAFE_ALPHABET : FULL_ALPHABET;
  return toBijectiveBase(idx, alphabet);
}

/**
 * Alphabetic label for a 1-based value (1 -> 'A', 26 -> 'Z', 27 -> 'AA').
 * Uppercase by default; `lower` gives the a,b,c… variant. Values ≤ 0 clamp to 'A'.
 */
export function toLetters(value: number, lower = false): string {
  const alphabet = lower ? LOWER_ALPHABET : FULL_ALPHABET;
  return toBijectiveBase(Math.max(0, Math.floor(value) - 1), alphabet);
}

const ROMAN_TABLE: Array<[number, string]> = [
  [1000, 'M'], [900, 'CM'], [500, 'D'], [400, 'CD'], [100, 'C'], [90, 'XC'],
  [50, 'L'], [40, 'XL'], [10, 'X'], [9, 'IX'], [5, 'V'], [4, 'IV'], [1, 'I'],
];

/** Uppercase Roman numeral for a positive integer (1 -> 'I', 4 -> 'IV', 9 -> 'IX').
 *  Non-positive / non-finite inputs fall back to their decimal string. */
export function toRoman(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return String(value);
  let remaining = Math.floor(value);
  let out = '';
  for (const [n, sym] of ROMAN_TABLE) {
    while (remaining >= n) {
      out += sym;
      remaining -= n;
    }
  }
  return out;
}

export function relabelRows<T extends { label: string }>(rows: T[], opts: RelabelOptions): T[] {
  const n = rows.length;
  return rows.map((row, i) => {
    const assignIndex = opts.reverse ? n - 1 - i : i;
    return { ...row, label: indexLabel(assignIndex, opts) };
  });
}

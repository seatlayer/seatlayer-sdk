/**
 * Seat numbering — and the one distinction the whole feature turns on.
 *
 * Every seat carries TWO names and they are not interchangeable:
 *
 * - **Inventory label** (`label`) is the seat's booking identity. It is derived
 *   from the PHYSICAL row that stores the seat and must never move because rows
 *   were grouped, renumbered for display, or re-segmented. A ticket, a hold and
 *   a report all key off this.
 * - **Display label** (`displayLabel`) is what a human reads. For a segmented
 *   row it follows the LOGICAL row: components number continuously
 *   (`A-1…A-13`), not per physical component (`A-1…A-7`, then `A-1…A-6`).
 *
 * Getting this split wrong is not cosmetic and it already happened: the data was
 * correct — buyers saw `A-1…A-13` — but the Designer canvas built its labels
 * from the physical row and showed `1-7` / `1-6`. Two surfaces disagreed about
 * the same seats, which is the fastest way to lose trust in correct data.
 *
 * The split survived only because each surface reconstructed the logical
 * numbering row by hand. `logicalNumberingRow` is that construction, named once,
 * so canvas, buyer expansion and MCP cannot drift apart again.
 */
import { toLetters, toRoman } from './labeling';
import type { RowObject, SeatOverride } from './types';
import type { SegmentedRowPlacement } from './segmentedRowModel';

/**
 * Number outward from the middle: rank seats by distance from centre (inner-left
 * wins ties), so the centre seat gets rank 0 (the lowest number). Shared by the
 * `center` direction across every scheme.
 */
function centerRank(n: number): number[] {
  const rank = new Array<number>(n);
  Array.from({ length: n }, (_, i) => i)
    .sort((a, b) => Math.abs(2 * a - (n - 1)) - Math.abs(2 * b - (n - 1)) || a - b)
    .forEach((idx, k) => (rank[idx] = k));
  return rank;
}

/**
 * The seat NUMBER part of a row seat's label (the row prefix is prepended by the
 * caller). Applies the row's numbering scheme, direction, step, start and label
 * prefix. Labels only — never geometry. See `RowObject.seatNumbering.scheme`.
 */
export function seatLabelPart(row: RowObject, i: number): string {
  const rawStart = row.seatLabelStart ?? 1;
  const dir = row.seatNumbering?.direction ?? 'ltr';
  const step = row.seatNumbering?.step ?? 1;
  const scheme = row.seatNumbering?.scheme ?? 'decimal';
  const prefix = row.seatNumbering?.prefix ?? '';
  const endAt = row.seatNumbering?.endAt;
  const n = row.seatCount;

  // Both up/down variants replace direction and number by physical left→right
  // order. `updown` is odd-up-even-back (1,3,5,…,6,4,2); the distinct reverse
  // variant is odd-back-even-up (…5,3,1,2,4,6). `start` shifts either sequence.
  // They own their sequence, so both ignore `endAt`.
  if (scheme === 'updown' || scheme === 'updown-descending') {
    const half = Math.ceil(n / 2);
    const core = scheme === 'updown'
      ? (i < half ? rawStart + 2 * i : rawStart - 1 + 2 * (n - i))
      : (i < half ? rawStart + 2 * (half - 1 - i) : rawStart + 1 + 2 * (i - half));
    return `${prefix}${core}`;
  }

  // End-at preset ("useEndAt"): derive `start` so the LAST-numbered seat
  // (position rank n-1) lands on `endAt`, honouring the scheme's effective step
  // (odd/even = 2). `endAt` wins over the stored `seatLabelStart`.
  const effStep = scheme === 'odd' || scheme === 'even' ? 2 : step;
  const start = endAt != null && Number.isFinite(endAt) ? endAt - (n - 1) * effStep : rawStart;

  // Position rank p ∈ [0, n-1]: the 0-based ordinal along the numbering
  // direction. Every remaining scheme is a formatting of `start + p*step`.
  const p = dir === 'center' ? centerRank(n)[i] : dir === 'rtl' ? n - 1 - i : i;

  let core: string;
  switch (scheme) {
    case 'odd': {
      const firstOdd = start % 2 === 1 ? start : start + 1;
      core = String(firstOdd + p * 2);
      break;
    }
    case 'even': {
      const firstEven = start % 2 === 0 ? start : start + 1;
      core = String(firstEven + p * 2);
      break;
    }
    case 'roman':
      core = toRoman(start + p * step);
      break;
    case 'letters-upper':
      core = toLetters(start + p * step, false);
      break;
    case 'letters-lower':
      core = toLetters(start + p * step, true);
      break;
    case 'decimal':
    default:
      core = String(start + p * step);
      break;
  }
  return `${prefix}${core}`;
}

/**
 * The synthetic row that DISPLAY numbering is computed against.
 *
 * A segmented component must number as though it were the whole logical row:
 * the logical row's total seat count and label, so that scheme, direction,
 * `endAt` and `center` ranking all resolve across the full span rather than
 * restarting inside each component. Combined with the component's
 * `displayOffset`, this is what makes `A-1…A-13` continuous.
 *
 * Every surface that renders a display label must go through this rather than
 * assembling the same object inline — three copies of it are exactly how canvas
 * and buyer drifted apart.
 */
export function logicalNumberingRow(placement: SegmentedRowPlacement): RowObject {
  return {
    ...placement.canonical,
    seatCount: placement.totalSeats,
    label: placement.displayLabel,
    displayLabel: placement.displayLabel,
  };
}

/**
 * The seat's BOOKING IDENTITY. Always physical: the storing row's label and the
 * physical index within it. A seat-level override wins because it was authored
 * deliberately.
 */
export function seatInventoryLabel(
  row: RowObject,
  physicalIndex: number,
  override?: SeatOverride,
): string {
  return override?.label ?? `${row.label}-${seatLabelPart(row, physicalIndex)}`;
}

/**
 * The seat's HUMAN-FACING label.
 *
 * With no `placement` this is the physical label under the row's own display
 * prefix. With a `placement` the seat numbers against the logical row at its
 * component's offset — the identical construction buyer expansion uses, so the
 * author and the buyer can never see different seat numbers.
 *
 * A seat-level `displayLabel` override remains the highest-precedence copy.
 */
export function seatDisplayLabel(
  row: RowObject,
  physicalIndex: number,
  placement?: SegmentedRowPlacement,
  override?: SeatOverride,
): string {
  if (override?.displayLabel) return override.displayLabel;
  if (!placement) {
    const prefix = row.displayLabel ?? row.label;
    return `${prefix}-${seatLabelPart(row, physicalIndex)}`;
  }
  const numberingRow = logicalNumberingRow(placement);
  const ordinal = placement.displayOffset + physicalIndex;
  return `${placement.displayLabel}-${seatLabelPart(numberingRow, ordinal)}`;
}

/**
 * Best-available seat selection — a PURE, fully unit-testable ranking function.
 *
 * This is the CLIENT-side twin of the server's atomic best-available route
 * (workers/api/src/bestAvailable.ts). The server owns the authoritative pick +
 * hold for the default "Find best seats" flow; this pure copy lets the buyer
 * widget run a premium-biased pre-pass locally (it already holds the full seat
 * geometry + commercial flags + live availability) and then hold the resulting
 * block through the normal hold endpoint. The baseline behaviour is kept
 * identical to the server so the two never disagree on what "best" means.
 *
 * "Best" means, in priority order:
 *   0. (opt-in) a run made entirely of `commercial.premium` seats — only when
 *      `preferPremium` is set; absent = this term is inert (byte-identical).
 *   1. A single contiguous run of `qty` adjacent-available seats in ONE row
 *      (a booked/held/missing/wrong-category seat breaks contiguity).
 *   2. …that does NOT strand a single isolated free seat ("orphan") beside the
 *      run — leaving a pair or more is fine, leaving a lone singleton is not.
 *   3. …whose centroid is closest to the focal point (the stage).
 *   4. Deterministic tie-break by rowId then seat index (so it's testable).
 *
 * When no single-row run of `qty` exists, it falls back to the `qty` available
 * seats closest to the focal point overall (which may span rows).
 */
import type { ExpandedSeat, Point } from './types';

export type BestAvailableReason = 'not_enough_together' | 'sold_out';

export interface BestAvailableResult {
  labels: string[];
  reason?: BestAvailableReason;
}

export interface BestAvailableOpts {
  qty: number;
  categoryKey?: string;
  /** Restrict the pick to one authored navigation zone. */
  zoneId?: string;
  focal: Point;
  /**
   * Additive premium bias. When true, candidate scoring STRONGLY prefers seats
   * carrying `commercial.premium` (a fully-premium run beats any run holding a
   * non-premium seat, ahead of orphan/distance). Undefined/false leaves scoring
   * byte-identical to the baseline algorithm — the premium term never runs.
   */
  preferPremium?: boolean;
}

/** Seat index within its row, parsed from the `${rowId}:${index}` id. */
function seatIndex(seat: ExpandedSeat, fallback: number): number {
  if (Number.isInteger(seat.logicalSeatIndex)) return seat.logicalSeatIndex!;
  const i = seat.id.lastIndexOf(':');
  if (i < 0) return fallback;
  const n = Number(seat.id.slice(i + 1));
  return Number.isFinite(n) ? n : fallback;
}

function dist2(a: Point, b: Point): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return dx * dx + dy * dy;
}

/** Centroid of a set of seats. */
function centroid(seats: ExpandedSeat[]): Point {
  let x = 0;
  let y = 0;
  for (const s of seats) {
    x += s.x;
    y += s.y;
  }
  return { x: x / seats.length, y: y / seats.length };
}

function candidateFocal(seats: ExpandedSeat[], fallback: Point): Point {
  return seats.find((seat) => seat.focalPoint)?.focalPoint ?? fallback;
}

function isPremium(seat: ExpandedSeat): boolean {
  return seat.commercial?.premium === true;
}

interface Slot {
  seat: ExpandedSeat;
  index: number;
  /** Eligible = available AND (no category filter OR category matches). */
  elig: boolean;
}

interface Candidate {
  labels: string[];
  seats: ExpandedSeat[];
  rowId: string;
  startIndex: number;
  /** 1 when taking this run strands a lone free seat; 0 otherwise. */
  orphan: number;
  /** Count of non-premium seats in the run — only scored when preferPremium. */
  nonPremium: number;
  d2: number;
}

/**
 * Pick the `qty` best available seats. Returns `{ labels }` on success, or
 * `{ labels: [], reason }` when the request can't be satisfied at all.
 */
export function pickBestAvailable(
  seats: ExpandedSeat[],
  available: Set<string>,
  opts: BestAvailableOpts,
): BestAvailableResult {
  const qty = Math.floor(opts.qty);
  if (!Number.isFinite(qty) || qty <= 0) return { labels: [], reason: 'sold_out' };
  const { categoryKey, zoneId, focal, preferPremium } = opts;

  // Group ALL seats by row (we need the non-eligible ones too, to detect gaps
  // and orphans), preserving original order for a stable fallback tie-break.
  const rows = new Map<string, Slot[]>();
  const eligibleAll: ExpandedSeat[] = [];
  seats.forEach((seat, i) => {
    const elig = available.has(seat.label)
      && (!categoryKey || seat.categoryKey === categoryKey)
      && (!zoneId || seat.zoneId === zoneId);
    const rowId = seat.logicalRowId ?? seat.rowId;
    let arr = rows.get(rowId);
    if (!arr) {
      arr = [];
      rows.set(rowId, arr);
    }
    arr.push({ seat, index: seatIndex(seat, i), elig });
    if (elig) eligibleAll.push(seat);
  });

  if (eligibleAll.length === 0) return { labels: [], reason: 'sold_out' };

  // --- 1) single-row contiguous runs of `qty` adjacent-available seats ---
  let best: Candidate | null = null;
  const better = (c: Candidate): boolean => {
    if (!best) return true;
    // Premium bias (opt-in) outranks everything else so the buyer lands the
    // best PREMIUM block; inert when preferPremium is off (nonPremium === 0).
    if (preferPremium && c.nonPremium !== best.nonPremium) return c.nonPremium < best.nonPremium;
    if (c.orphan !== best.orphan) return c.orphan < best.orphan;
    if (c.d2 !== best.d2) return c.d2 < best.d2;
    const r = c.rowId.localeCompare(best.rowId);
    if (r !== 0) return r < 0;
    return c.startIndex < best.startIndex;
  };

  for (const [rowId, slotsUnsorted] of rows) {
    const slots = [...slotsUnsorted].sort((a, b) => a.index - b.index);
    // Walk maximal eligible segments. A non-eligible slot (taken / wrong
    // category / missing) breaks contiguity.
    let i = 0;
    while (i < slots.length) {
      if (!slots[i].elig) {
        i++;
        continue;
      }
      let j = i;
      while (
        j < slots.length
        && slots[j].elig
        && (j === i || slots[j].index === slots[j - 1].index + 1)
      ) j++;
      const segLen = j - i; // eligible run [i, j)
      // Every window of `qty` within this segment is a candidate.
      for (let p = 0; p + qty <= segLen; p++) {
        const leftRem = p; // eligible seats stranded to the left of the window
        const rightRem = segLen - (p + qty); // …and to the right
        const orphan = leftRem === 1 || rightRem === 1 ? 1 : 0;
        const runSeats = slots.slice(i + p, i + p + qty).map((s) => s.seat);
        const c: Candidate = {
          labels: runSeats.map((s) => s.label),
          seats: runSeats,
          rowId,
          startIndex: slots[i + p].index,
          orphan,
          nonPremium: preferPremium ? runSeats.reduce((n, s) => n + (isPremium(s) ? 0 : 1), 0) : 0,
          d2: dist2(centroid(runSeats), candidateFocal(runSeats, focal)),
        };
        if (better(c)) best = c;
      }
      i = j;
    }
  }

  if (best) return { labels: best.labels };

  // --- 2) fallback: the `qty` closest-to-focal seats overall (may span rows) ---
  if (eligibleAll.length < qty) return { labels: [], reason: 'not_enough_together' };

  const ranked = eligibleAll
    .map((seat, i) => ({ seat, i, d2: dist2(seat, seat.focalPoint ?? focal) }))
    .sort((a, b) => {
      // Premium-first when biased (inert otherwise — both sides score 0).
      if (preferPremium) {
        const pa = isPremium(a.seat) ? 0 : 1;
        const pb = isPremium(b.seat) ? 0 : 1;
        if (pa !== pb) return pa - pb;
      }
      if (a.d2 !== b.d2) return a.d2 - b.d2;
      const r = (a.seat.logicalRowId ?? a.seat.rowId).localeCompare(b.seat.logicalRowId ?? b.seat.rowId);
      if (r !== 0) return r;
      return seatIndex(a.seat, a.i) - seatIndex(b.seat, b.i);
    });

  return { labels: ranked.slice(0, qty).map((r) => r.seat.label) };
}

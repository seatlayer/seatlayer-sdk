/**
 * Orphan-seat detection for MANUAL selection — the client-side sibling of the
 * server's best-available orphan avoidance (workers/api/src/bestAvailable):
 * a "stranded single" is a free seat whose both same-row neighbors are
 * unavailable (non-free or currently selected). The picker uses this to show
 * a non-blocking hint; nothing is ever prevented.
 */
import type { ExpandedSeat, SeatStatus } from './types';

/** Numeric seat index from the stable id (`${rowId}:${index}`). */
function seatIndex(id: string): number {
  const n = Number(id.slice(id.lastIndexOf(':') + 1));
  return Number.isFinite(n) ? n : -1;
}

/**
 * Free seats stranded by the current selection: both same-row neighbors exist
 * and are unavailable, and at least one neighbor is part of `selectedIds` —
 * so pre-existing single gaps (caused by earlier buyers) never nag.
 * Booth units are ignored (no row adjacency).
 */
export function strandedSingles(
  seats: Iterable<ExpandedSeat>,
  statusOf: (seatId: string) => SeatStatus,
  selectedIds: ReadonlySet<string>,
): ExpandedSeat[] {
  // Group by row, ordered by index, skipping booths.
  const rows = new Map<string, ExpandedSeat[]>();
  for (const s of seats) {
    if (s.kind === 'booth') continue;
    const list = rows.get(s.rowId);
    if (list) list.push(s);
    else rows.set(s.rowId, [s]);
  }

  const unavailable = (s: ExpandedSeat): boolean =>
    selectedIds.has(s.id) || statusOf(s.id) !== 'free';

  const out: ExpandedSeat[] = [];
  for (const list of rows.values()) {
    if (list.length < 3) continue;
    list.sort((a, b) => seatIndex(a.id) - seatIndex(b.id));
    for (let i = 1; i < list.length - 1; i++) {
      const seat = list[i];
      if (unavailable(seat)) continue; // not free (or selected) → not stranded
      const left = list[i - 1];
      const right = list[i + 1];
      // Neighbors must be physically adjacent (index gap of 1) — a labelled
      // aisle gap in the numbering doesn't strand anyone.
      if (seatIndex(seat.id) - seatIndex(left.id) !== 1 || seatIndex(right.id) - seatIndex(seat.id) !== 1) continue;
      if (!unavailable(left) || !unavailable(right)) continue;
      if (!selectedIds.has(left.id) && !selectedIds.has(right.id)) continue;
      out.push(seat);
    }
  }
  return out;
}

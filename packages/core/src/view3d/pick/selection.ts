/**
 * Pure selection-state diffing. Selection is a colour layer over availability:
 * a selected seat shows the 'selected' colour and, on deselect, restores the
 * base availability state it had when it was selected (remembered in `prev`).
 * Kept DOM/GPU-free so the transitions are unit-testable.
 */

import { SEAT_STATES, seatStateIndex, type SeatState3D } from '../palette';

export interface SelectionUpdate {
  seatId: string;
  state: SeatState3D;
}

/**
 * Reconcile an availability update against the current selection. A selected
 * seat that changes availability must STAY 'selected' on screen while its
 * remembered base state is updated (so a later deselect restores the CURRENT
 * availability, not the pre-change one). Mutates `selection` in place and
 * returns the updates that should actually be written to iState (the
 * non-selected ones — selected seats keep their 'selected' colour).
 */
export function mergeAvailabilityIntoSelection(
  selection: Map<string, number>,
  updates: SelectionUpdate[],
): SelectionUpdate[] {
  const passthrough: SelectionUpdate[] = [];
  for (const u of updates) {
    if (selection.has(u.seatId)) selection.set(u.seatId, seatStateIndex(u.state));
    else passthrough.push(u);
  }
  return passthrough;
}

export interface SelectionDiff {
  updates: SelectionUpdate[];
  /** New seatId → remembered base-state index map. */
  next: Map<string, number>;
}

/**
 * Diff the current selection (`prev`: seatId → base-state index) against the
 * desired seat ids. `baseStateIndex` reads the seat's CURRENT state index (used
 * only for newly-selected seats, which are not yet recoloured).
 */
export function diffSelection(
  prev: Map<string, number>,
  desiredIds: string[],
  baseStateIndex: (seatId: string) => number | undefined,
): SelectionDiff {
  const desired = new Set<string>();
  for (const id of desiredIds) {
    if (prev.has(id) || baseStateIndex(id) !== undefined) desired.add(id);
  }
  const next = new Map(prev);
  const updates: SelectionUpdate[] = [];

  // Deselect: restore base availability for ids leaving the selection.
  for (const [id, base] of prev) {
    if (!desired.has(id)) {
      updates.push({ seatId: id, state: SEAT_STATES[base] ?? 'available' });
      next.delete(id);
    }
  }
  // Select: remember base state, then recolour as selected.
  for (const id of desired) {
    if (next.has(id)) continue; // already selected → unchanged
    const base = baseStateIndex(id);
    if (base === undefined) continue;
    next.set(id, base);
    updates.push({ seatId: id, state: 'selected' });
  }
  return { updates, next };
}

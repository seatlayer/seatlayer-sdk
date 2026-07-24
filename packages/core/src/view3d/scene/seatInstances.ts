/**
 * Pure builder for the instanced seat cloud. Produces the per-instance arrays a
 * single OGL InstancedMesh consumes (one draw call for every seat), plus the
 * seatId → instanceIndex map that `setAvailability` uses to patch only the seats
 * that actually changed via a sub-range `bufferSubData` upload.
 */

import type { ExpandedSeat } from '../../core/types';
import { SEATED_EYE_HEIGHT_M } from '../../core/units';
import { M } from './geometry';
import { seatStateIndex, type SeatState3D } from '../palette';

/** Lift so a dot sits clearly ON the tier deck (which is drawn ~0.28 m below the
 * resolved surface), never occluded by its own cap. */
const SEAT_SURFACE_LIFT_M = 0.18;

export interface SeatInstanceData {
  count: number;
  /** vec3 per instance: world (x, y, z) in metres. */
  iPosition: Float32Array;
  /** float per instance: index into the seat-state colour LUT. */
  iState: Float32Array;
  /** seatId → instance index (drives targeted availability updates). */
  idToIndex: Map<string, number>;
}

/**
 * Resolve a seat's surface height in world metres. Prefer the section-resolved
 * eye height (already floor-base + rake-rise aware) minus the seated-eye offset
 * so the dot lands on the seating surface; fall back to ground for flat charts.
 */
function seatSurfaceY(seat: ExpandedSeat): number {
  const eye = seat.eyeHeightM;
  if (Number.isFinite(eye)) {
    return Math.max(0, (eye as number) - SEATED_EYE_HEIGHT_M) + SEAT_SURFACE_LIFT_M;
  }
  return SEAT_SURFACE_LIFT_M;
}

export function buildSeatInstances(
  seats: ExpandedSeat[],
  initial?: (seat: ExpandedSeat) => SeatState3D,
): SeatInstanceData {
  const count = seats.length;
  const iPosition = new Float32Array(count * 3);
  const iState = new Float32Array(count);
  const idToIndex = new Map<string, number>();
  for (let i = 0; i < count; i++) {
    const seat = seats[i];
    iPosition[i * 3] = seat.x * M;
    iPosition[i * 3 + 1] = seatSurfaceY(seat);
    iPosition[i * 3 + 2] = seat.y * M;
    iState[i] = seatStateIndex(initial ? initial(seat) : 'available');
    idToIndex.set(seat.id, i);
  }
  return { count, iPosition, iState, idToIndex };
}

/** Contiguous run of instance indices to upload in a single bufferSubData call. */
export interface DirtyRun {
  start: number;
  /** number of instances (floats, since iState is 1 float/instance). */
  length: number;
}

/**
 * Apply state updates to the CPU `iState` array and return the coalesced
 * contiguous runs that changed — the caller uploads exactly those ranges and
 * never the whole buffer.
 */
export function applySeatStates(
  data: SeatInstanceData,
  updates: Array<{ seatId: string; state: SeatState3D }>,
): DirtyRun[] {
  const changed: number[] = [];
  for (const u of updates) {
    const idx = data.idToIndex.get(u.seatId);
    if (idx === undefined) continue;
    const v = seatStateIndex(u.state);
    if (data.iState[idx] !== v) {
      data.iState[idx] = v;
      changed.push(idx);
    }
  }
  if (!changed.length) return [];
  changed.sort((a, b) => a - b);
  const runs: DirtyRun[] = [];
  let start = changed[0];
  let prev = changed[0];
  for (let i = 1; i < changed.length; i++) {
    const idx = changed[i];
    if (idx === prev) continue;
    if (idx === prev + 1) { prev = idx; continue; }
    runs.push({ start, length: prev - start + 1 });
    start = idx;
    prev = idx;
  }
  runs.push({ start, length: prev - start + 1 });
  return runs;
}

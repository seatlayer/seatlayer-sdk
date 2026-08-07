/**
 * Pure builder for the instanced seat cloud. Produces the per-instance arrays a
 * single OGL InstancedMesh consumes (one draw call for every seat), plus the
 * seatId → instanceIndex map that `setAvailability` uses to patch only the seats
 * that actually changed via a sub-range `bufferSubData` upload.
 */

import { accessibilityRingColor, type ExpandedSeat } from '../../core/types';
import { hexToRgb } from '../palette';
import { SEATED_EYE_HEIGHT_M } from '../../core/units';
import { M } from './geometry';
import { chairHalfWidth } from './seatChair';
import { seatStateIndex, SEAT_STATES, type SeatState3D } from '../palette';
import type { VenueSurfaces } from './surface';

/**
 * World radius of a seat dot in metres — the single source for the shader
 * uniform AND for how far a section deck is padded so its seats sit on it.
 * (The shader may grow this with distance to hold `uMinPixels`; this is the
 * near-field base.)
 */
export const SEAT_DOT_RADIUS_M = 0.22;

/**
 * Whether a seat has somebody in it, and who.
 *
 * Occupancy is not invented — it is the inventory. A seat that is SOLD has been
 * bought by a person, and a HELD one is being bought right now, so those are the
 * seats that get an occupant. Available and dimmed seats stay empty, and a
 * SELECTED seat stays empty too: that is the buyer's own seat, and drawing a
 * stranger in it while they choose it would be worse than an empty hall.
 *
 * This means the crowd tells the truth about the event. A nearly-sold show looks
 * full from the seat you are considering, and a quiet one looks quiet — which is
 * information a buyer actually wants, arrived at without inventing anything.
 *
 * Returns a negative value for an empty seat; otherwise a stable per-seat hash
 * in [0,1) that varies the occupant's build and tone. Stable so a person does
 * not change shape as the near-field set is re-gathered around a moving camera.
 */
export function seatOccupantSeed(stateIndex: number, seatIndex: number): number {
  const state = SEAT_STATES[stateIndex];
  if (state !== 'sold' && state !== 'held') return -1;
  // Cheap integer hash — deterministic, no Math.random, and well distributed
  // across neighbouring indices so adjacent seats do not come out matching.
  let h = (seatIndex + 1) * 2654435761;
  h ^= h >>> 15;
  h = Math.imul(h, 2246822519);
  h ^= h >>> 13;
  return ((h >>> 0) % 100000) / 100000;
}

/**
 * Fraction of a seat's nearest-neighbour spacing that its dot may occupy.
 *
 * Below 0.5 two adjacent dots cannot touch even when both sit at their ceiling,
 * so a gap always survives between rows. 0.42 leaves that gap visible rather
 * than hairline.
 */
export const SEAT_PITCH_FRACTION = 0.42;

export interface SeatInstanceData {
  count: number;
  /** vec3 per instance: world (x, y, z) in metres. */
  iPosition: Float32Array;
  /** float per instance: index into the seat-state colour LUT. */
  iState: Float32Array;
  /**
   * vec3 per instance: the seat's CATEGORY colour, used while it is available.
   *
   * 2D fills a free seat with its category colour and only overrides it once the
   * seat is held/sold/selected. 3D used one flat green for every available seat,
   * which threw away the price-tier read on switching views and made a full
   * house look like a status map instead of a venue.
   */
  iCategory: Float32Array;
  /**
   * float per instance: the largest world radius this dot may take, metres.
   *
   * The shader enforces `uMinPixels` by GROWING a dot's world radius with depth,
   * which is what merges rows into a solid mass at range — measured mean seat
   * spacing is 0.53–0.58 m against a 0.44 m dot diameter, so there is very little
   * slack to spend before neighbours touch. A global cap cannot fix it: spacing
   * is a property of the chart, and varies between sections of the same venue
   * (measured min 0.21 m on the amphitheatre against a 0.58 m mean).
   *
   * So the ceiling travels per seat, derived from that seat's own nearest
   * neighbour. A dot grows to hold its minimum pixel size and then STOPS,
   * whatever the distance. Past that point holding legibility is the LOD ladder's
   * job (fade toward the tier tint), not the dot's.
   */
  iMaxRadius: Float32Array;
  /**
   * vec3 per instance: accommodation ring colour, or (0,0,0) for none.
   *
   * 2D draws a coloured ring around every seat with an accessibility type, and
   * 3D drew nothing at all — so a wheelchair space, a companion seat or a
   * lift-armrest seat was indistinguishable from any other the moment a buyer
   * switched to the 3D view. A ring mirrors the 2D treatment exactly, needs no
   * texture, and costs one instanced attribute rather than a draw call.
   */
  iRing: Float32Array;
  /** float per instance: owning floor index, for per-floor isolation. */
  iFloor: Float32Array;
  /**
   * float per instance: facing yaw in radians, for the near-field chair mesh.
   *
   * A billboard dot has no front, so nothing here ever needed a direction. A
   * chair does, and getting it wrong is worse than drawing nothing — a row of
   * seats with their backs to the stage reads as a mistake immediately.
   *
   * Left at zero by this builder and filled by `sceneModel`, which is the layer
   * that knows what each seat FACES (its floor's focal point). Direct callers
   * and tests that build instances without a scene get zeros, which is a
   * well-defined "facing +Z" rather than an undefined attribute.
   */
  iYaw: Float32Array;
  /**
   * float per instance: half-width of this seat's near-field CHAIR, world metres.
   *
   * Deliberately not `iMaxRadius`. That value is the dot's ceiling — conservative
   * by design so round dots stay visually apart, and clamped to
   * SEAT_DOT_RADIUS_M on top of that. Sizing a chair from it gave 0.34 m chairs
   * under 0.95 m backs: an aspect ratio near 3:1, which reads as a headstone.
   * Real seats very nearly touch. See `chairHalfWidth`.
   */
  iChairWidth: Float32Array;
  /** 1 = physical chair; 0 = sellable empty wheelchair bay. */
  iPhysicalSeat: Float32Array;
  /** seatId → instance index (drives targeted availability updates). */
  idToIndex: Map<string, number>;
}

/**
 * Nearest-neighbour distance in chart units for every seat, via a uniform grid.
 *
 * Linear in seat count for realistic charts (the grid cell is sized to the mean
 * spacing, so each lookup touches a bounded neighbourhood) — the naive pairwise
 * version is 14k² on the Uber Arena and would show up in build time.
 */
function nearestNeighbourSpacing(seats: ExpandedSeat[]): Float64Array {
  const n = seats.length;
  const out = new Float64Array(n);
  if (n < 2) { out.fill(Infinity); return out; }
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const s of seats) {
    if (s.x < minX) minX = s.x;
    if (s.y < minY) minY = s.y;
    if (s.x > maxX) maxX = s.x;
    if (s.y > maxY) maxY = s.y;
  }
  const w = Math.max(maxX - minX, 1e-6), h = Math.max(maxY - minY, 1e-6);
  // Aim at ~1 seat per cell: cell = sqrt(area / count).
  const cell = Math.max(Math.sqrt((w * h) / n), 1e-6);
  const cols = Math.max(1, Math.ceil(w / cell) + 1);
  const rows = Math.max(1, Math.ceil(h / cell) + 1);
  const buckets = new Map<number, number[]>();
  const cellOf = (x: number, y: number): number => {
    const cx = Math.min(cols - 1, Math.max(0, Math.floor((x - minX) / cell)));
    const cy = Math.min(rows - 1, Math.max(0, Math.floor((y - minY) / cell)));
    return cy * cols + cx;
  };
  for (let i = 0; i < n; i++) {
    const k = cellOf(seats[i].x, seats[i].y);
    const b = buckets.get(k);
    if (b) b.push(i); else buckets.set(k, [i]);
  }
  for (let i = 0; i < n; i++) {
    const s = seats[i];
    const cx = Math.min(cols - 1, Math.max(0, Math.floor((s.x - minX) / cell)));
    const cy = Math.min(rows - 1, Math.max(0, Math.floor((s.y - minY) / cell)));
    let best = Infinity;
    // Widen the ring until a hit is found — a sparse region (a lone box seat)
    // would otherwise report Infinity and lose its ceiling entirely.
    for (let r = 1; r <= 4; r++) {
      for (let gy = cy - r; gy <= cy + r; gy++) {
        if (gy < 0 || gy >= rows) continue;
        for (let gx = cx - r; gx <= cx + r; gx++) {
          if (gx < 0 || gx >= cols) continue;
          // Only the newly-added ring after the first pass.
          if (r > 1 && Math.abs(gy - cy) < r && Math.abs(gx - cx) < r) continue;
          const b = buckets.get(gy * cols + gx);
          if (!b) continue;
          for (const j of b) {
            if (j === i) continue;
            const d = Math.hypot(seats[j].x - s.x, seats[j].y - s.y);
            if (d < best) best = d;
          }
        }
      }
      if (Number.isFinite(best) && best <= r * cell) break;
    }
    out[i] = best;
  }
  return out;
}

/**
 * Resolve a seat's surface height in world metres — the fallback path used only
 * when no venue surface was supplied (direct callers, tests). Prefer the
 * section-resolved eye height minus the seated-eye offset.
 *
 * There is deliberately NO lift constant here any more. A dot is placed exactly
 * ON the deck, and the seat shader offsets the billboard by its own radius along
 * screen-up so the dot RESTS on that point at every distance. A fixed lift could
 * not do that: the shader enforces `uMinPixels`, so a dot's world radius grows
 * with depth and any constant clearance is eventually smaller than the dot.
 */
function seatSurfaceY(seat: ExpandedSeat): number {
  const eye = seat.eyeHeightM;
  if (Number.isFinite(eye)) return Math.max(0, (eye as number) - SEATED_EYE_HEIGHT_M);
  return 0;
}

export function buildSeatInstances(
  seats: ExpandedSeat[],
  initial?: (seat: ExpandedSeat) => SeatState3D,
  surfaces?: VenueSurfaces,
  seatFloor?: Float32Array,
  /** categoryKey -> display colour, for the AVAILABLE tint. Omitted by direct
   *  callers and tests, which then get the flat state green as before. */
  categoryColor?: Map<string, string>,
): SeatInstanceData {
  const count = seats.length;
  const iPosition = new Float32Array(count * 3);
  const iState = new Float32Array(count);
  const iCategory = new Float32Array(count * 3);
  const iMaxRadius = new Float32Array(count);
  const iChairWidth = new Float32Array(count);
  const iPhysicalSeat = new Float32Array(count);
  const iRing = new Float32Array(count * 3);
  const idToIndex = new Map<string, number>();
  const spacing = nearestNeighbourSpacing(seats);
  for (let i = 0; i < count; i++) {
    const seat = seats[i];
    // The seat's OWN row pitch when its section resolved into rows; the raw
    // nearest-neighbour distance only as a fallback for unstructured seats.
    // See `VenueSurfaces.seatPitchU` for why the raw measure is wrong.
    const resolved = surfaces?.seatPitchU(i);
    const pitchM = (resolved ?? spacing[i]) * M;
    // The ceiling is allowed BELOW the base radius. A chart authored tighter
    // than the 0.22 m default dot (measured 0.21 m minimum spacing on the
    // amphitheatre) overlaps at every distance today, including close up, and
    // shrinking those dots is the only thing that separates them. A small floor
    // keeps a pathologically dense chart's seats visible rather than vanishing.
    // A seat with no resolvable neighbour keeps the base radius, not an
    // unbounded one.
    iMaxRadius[i] = Number.isFinite(pitchM)
      ? Math.max(0.06, Math.min(SEAT_DOT_RADIUS_M, pitchM * SEAT_PITCH_FRACTION))
      : SEAT_DOT_RADIUS_M;
    // The chair reads the SAME pitch but through its own rule — see iChairWidth.
    iChairWidth[i] = chairHalfWidth(Number.isFinite(pitchM) ? pitchM : undefined);
    iPhysicalSeat[i] = seat.wheelchairSpaceType === 'no-seat' ? 0 : 1;
    iPosition[i * 3] = seat.x * M;
    // The venue surface wins when present: it is the same function the tier cap
    // is built from, which is what guarantees a seat can never sit inside it.
    iPosition[i * 3 + 1] = surfaces ? surfaces.seatDeckY(i) : seatSurfaceY(seat);
    iPosition[i * 3 + 2] = seat.y * M;
    iState[i] = seatStateIndex(initial ? initial(seat) : 'available');
    // The seat's CATEGORY colour, which is what 2D paints a free seat with
    // (`SeatmapRenderer.paintSeat` -> `seatBaseColor(categoryKey)`). 3D painted
    // every available seat one flat green instead, so a venue lost its price
    // tiers the moment a buyer switched view — and at seat level a hall of
    // identical green read as a diagram rather than a room. Falls back to the
    // same #6e7bff 2D uses when a category has no colour.
    const cat = hexToRgb(categoryColor?.get(seat.categoryKey) ?? '#6e7bff') ?? [0.43, 0.48, 1.0];
    iCategory[i * 3] = cat[0];
    iCategory[i * 3 + 1] = cat[1];
    iCategory[i * 3 + 2] = cat[2];
    // Same source of truth as 2D: the ring colour is derived from the seat's
    // accessibility types, so the two views cannot disagree about which seat is
    // an accessible one.
    if (seat.accessibility?.length) {
      const rgb = hexToRgb(accessibilityRingColor(seat.accessibility));
      if (rgb) { iRing[i * 3] = rgb[0]; iRing[i * 3 + 1] = rgb[1]; iRing[i * 3 + 2] = rgb[2]; }
    }
    idToIndex.set(seat.id, i);
  }
  return {
    count, iPosition, iState, iCategory, iMaxRadius, iRing, idToIndex, iChairWidth, iPhysicalSeat,
    iFloor: seatFloor ?? new Float32Array(count),
    iYaw: new Float32Array(count),
  };
}

/** Contiguous run of instance indices to upload in a single bufferSubData call. */
export interface DirtyRun {
  start: number;
  /** number of instances (floats, since iState is 1 float/instance). */
  length: number;
}

/**
 * Instances worth re-uploading just to avoid another GL call.
 *
 * Runs are merged across gaps up to this size. A `bufferSubData` has fixed
 * driver overhead regardless of how few bytes it carries, so uploading a handful
 * of unchanged instances inside one call is far cheaper than issuing a second.
 *
 * The case this exists for is a live socket delta on a big venue, where the
 * changed seats are SCATTERED rather than contiguous. Measured on a 50,400-seat
 * chart before merging: 1,000 scattered seats produced 983 separate uploads and
 * 5,000 produced 4,438 — thousands of GL calls in a single frame to move a few
 * kilobytes. A block going on sale already coalesced well; random churn did not.
 */
const RUN_MERGE_GAP = 64;

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
    // Bridge small gaps: the unchanged instances in between are rewritten from
    // `iState`, which already holds their current value, so this is a no-op for
    // them and saves a GL call. See RUN_MERGE_GAP.
    if (idx <= prev + RUN_MERGE_GAP) { prev = idx; continue; }
    runs.push({ start, length: prev - start + 1 });
    start = idx;
    prev = idx;
  }
  runs.push({ start, length: prev - start + 1 });
  return runs;
}

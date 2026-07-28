/**
 * Venue labels — anchors, level-of-detail, and world→screen projection.
 *
 * ## Why labels are DOM, not geometry
 *
 * The renderer is deliberately texture-free at three draw calls. Drawing text on
 * the GPU means a signed-distance font atlas: a texture, another shader, a build
 * asset, and a resolution ceiling — a lot of machinery for the few dozen labels a
 * venue actually needs. Projecting anchors and positioning DOM elements costs
 * nothing when a chart has no labels, and buys properties the GPU path cannot:
 *
 *  - **Real text.** A screen reader can read the venue's structure. That is the
 *    accessibility gap in 3D, not just a rendering convenience.
 *  - Crisp at any device pixel ratio and any zoom, with no atlas to outgrow.
 *  - `ChartTheme.fontFamily`, i18n and RTL come from the browser.
 *
 * This module is the pure half — what to label, where its anchor sits, and when
 * it should show. The overlay that positions elements lives in `index.ts`.
 *
 * ## Why the rungs mirror 2D
 *
 * 2D melts through zones → sections → seats. Labels follow the same idea for the
 * same reason: at a distance a buyer needs to know which part of the venue they
 * are looking at, and up close they need to know which block and which door. A
 * label set that does not thin out with distance turns a 51-section arena into
 * unreadable confetti.
 */

import type { Point } from '../core/types';

export type LabelKind = 'zone' | 'section' | 'ga' | 'annotation' | 'booth' | 'row' | 'seat';

export interface SceneLabel {
  id: string;
  kind: LabelKind;
  text: string;
  /** World-metre anchor the label is pinned to. */
  anchor: [number, number, number];
  /** Authored colour (`#rrggbb`), when the object carries one. */
  color?: string;
  /** Authored rotation in degrees, for annotations that specify one. */
  rotation?: number;
}

/**
 * Distance thresholds as multiples of the venue radius, matching the seat LOD's
 * scale so labels and seats thin out together rather than fighting.
 *
 * Zone labels are the far rung and switch OFF close in, where they would sit on
 * top of the section labels that have become more useful. Section labels are the
 * middle rung. Annotations and booth labels are wayfinding — only legible, and
 * only wanted, once the buyer is actually in that part of the venue.
 */
const ZONE_MIN_DISTANCE = 1.15;
const SECTION_MAX_DISTANCE = 2.2;
const NEAR_MAX_DISTANCE = 0.85;
/**
 * Row and seat identity are the last two rungs, mirroring 2D's melt: a buyer
 * this close has stopped choosing a part of the venue and started choosing a
 * place to sit. Seats come in last of all — a seat number is unreadable and
 * useless until you are close enough that one row fills much of the screen.
 */
const ROW_MAX_DISTANCE = 0.5;
const SEAT_MAX_DISTANCE = 0.26;

/** Which label kinds should show at this camera distance. */
export function visibleLabelKinds(distance: number, venueRadius: number): Set<LabelKind> {
  const r = Math.max(1e-6, venueRadius);
  const d = distance / r;
  const out = new Set<LabelKind>();
  if (d >= ZONE_MIN_DISTANCE) out.add('zone');
  // A GA area is named at the same rung as a section because that is what it is
  // — a sellable part of the venue the buyer picks before picking a place in it.
  if (d <= SECTION_MAX_DISTANCE) { out.add('section'); out.add('ga'); }
  if (d <= NEAR_MAX_DISTANCE) { out.add('annotation'); out.add('booth'); }
  if (d <= ROW_MAX_DISTANCE) out.add('row');
  if (d <= SEAT_MAX_DISTANCE) out.add('seat');
  return out;
}

export interface Projected {
  /** CSS pixels from the container's left/top. */
  x: number;
  y: number;
  /** Normalised depth; smaller is nearer. */
  depth: number;
  /** False when the anchor is behind the camera or outside the frustum. */
  visible: boolean;
}

/**
 * Project a world point through a column-major 4x4 view-projection matrix.
 *
 * Behind-camera points are reported invisible rather than mirrored to the far
 * side of the screen, which is what a naive divide by a negative w produces —
 * a label for the section behind you appearing over the stage in front of you.
 */
export function projectToScreen(
  viewProjection: ArrayLike<number>,
  p: readonly [number, number, number],
  width: number,
  height: number,
): Projected {
  const m = viewProjection;
  const x = p[0], y = p[1], z = p[2];
  const cx = m[0] * x + m[4] * y + m[8] * z + m[12];
  const cy = m[1] * x + m[5] * y + m[9] * z + m[13];
  const cz = m[2] * x + m[6] * y + m[10] * z + m[14];
  const cw = m[3] * x + m[7] * y + m[11] * z + m[15];
  if (!(cw > 1e-6)) return { x: 0, y: 0, depth: Infinity, visible: false };
  const ndcX = cx / cw, ndcY = cy / cw, ndcZ = cz / cw;
  const inside = ndcX >= -1.05 && ndcX <= 1.05 && ndcY >= -1.05 && ndcY <= 1.05 && ndcZ <= 1;
  return {
    x: (ndcX * 0.5 + 0.5) * width,
    y: (1 - (ndcY * 0.5 + 0.5)) * height,
    depth: ndcZ,
    visible: inside,
  };
}

/**
 * Drop labels that would overlap, nearest kept.
 *
 * Without this a dense venue paints its section names on top of each other and
 * every one of them becomes unreadable — worse than showing fewer. Nearest-wins
 * because the label a buyer is closest to is the one they are asking about.
 *
 * The test is RECTANGULAR, not radial. A label is a line of text: wide and
 * short. A single radius big enough to stop two names colliding side by side is
 * far bigger than the vertical gap they actually need, so a radial test threw
 * away labels that were stacked but perfectly readable — on the amphitheatre it
 * dropped "Terrace" purely for sitting between the other two concentric zones.
 */
export function cullOverlapping<T extends { screen: Projected }>(
  items: T[],
  separationX: number,
  separationY: number = separationX,
): T[] {
  const kept: T[] = [];
  const ordered = [...items].sort((a, b) => a.screen.depth - b.screen.depth);
  for (const item of ordered) {
    let clash = false;
    for (const k of kept) {
      const dx = Math.abs(item.screen.x - k.screen.x);
      const dy = Math.abs(item.screen.y - k.screen.y);
      // Only a genuine box overlap counts: near on BOTH axes.
      if (dx < separationX && dy < separationY) { clash = true; break; }
    }
    if (!clash) kept.push(item);
  }
  return kept;
}

/**
 * How many of the dense per-place labels may be painted at once.
 *
 * The overlap cull above is necessary and NOT sufficient, and the gap between
 * those two is a real defect: it only removes labels that collide, so the closer
 * the camera gets the FEWER collisions there are and the MORE labels survive.
 * Flown to a seat in a 3,605-seat amphitheatre, every row and seat name in the
 * frustum passed the test and the frame became a wall of tiled text with the
 * seating unreadable behind it — the labels stopped describing the venue and
 * became the thing obscuring it.
 *
 * A budget is the missing rung. A buyer arriving at their seat wants the handful
 * of names around them, not an index of the building; past a dozen or so the set
 * has no informational value left, only cost.
 */
export const DENSE_LABEL_BUDGET: Record<'row' | 'seat', number> = { row: 8, seat: 14 };

/**
 * Order dense labels by how much the buyer is likely to care: near the camera
 * and near the middle of the frame first.
 *
 * Both terms are needed. Distance alone keeps labels for seats behind the
 * camera's shoulder that happen to be metres away; screen-centre alone keeps a
 * label for a seat on the far side of the venue purely for being dead ahead. The
 * product ranks "what I am looking at, close to me" top, which is the seat a
 * buyer just flew to.
 */
export function focusScore(
  screen: Projected,
  worldDistance: number,
  width: number,
  height: number,
): number {
  const half = Math.max(1, Math.min(width, height) * 0.5);
  const off = Math.min(2, Math.hypot(screen.x - width / 2, screen.y - height / 2) / half);
  return worldDistance * (1 + 1.5 * off);
}

/**
 * Pick the dense labels to paint: rank by focus, drop overlaps in that order,
 * then take at most `budget`.
 *
 * Order matters. Culling overlaps FIRST and then truncating would let an
 * arbitrary far-corner label win a slot over the seat the buyer is sitting in,
 * because the overlap pass keeps whatever it happens to reach first.
 */
export function pickDenseLabels<T extends { screen: Projected; focus: number }>(
  items: T[],
  separationX: number,
  separationY: number,
  budget: number,
): T[] {
  const ordered = [...items].sort((a, b) => a.focus - b.focus);
  const kept: T[] = [];
  for (const item of ordered) {
    if (kept.length >= budget) break;
    let clash = false;
    for (const k of kept) {
      if (Math.abs(item.screen.x - k.screen.x) < separationX
        && Math.abs(item.screen.y - k.screen.y) < separationY) { clash = true; break; }
    }
    if (!clash) kept.push(item);
  }
  return kept;
}

/** Mean of a point set, or null when empty. */
export function centroidOf(points: readonly Point[]): Point | null {
  if (!points.length) return null;
  let x = 0, y = 0;
  for (const p of points) { x += p.x; y += p.y; }
  return { x: x / points.length, y: y / points.length };
}

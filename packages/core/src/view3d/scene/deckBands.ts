/**
 * The raked deck, built from a section's ROWS instead of from its outline.
 *
 * ## Why the deck is not a tessellated surface any more
 *
 * The previous deck was one cap over the section outline, tessellated against a
 * height field and refined until it tracked it. That works only while the field
 * is smooth and convex. Once height is defined so that every row is LEVEL — the
 * fix for rows visibly tilting, see `core/rake.ts` — the field stops being
 * either:
 *
 *  - A section commonly holds several blocks at different heights (the
 *    amphitheatre gallery is one section holding six wedges). Any field that is
 *    level on each row must JUMP between blocks. Measured, that jump drove the
 *    cap's worst error to 11 m against a 0.15 m bound.
 *  - Smoothing the jump away puts the tilt straight back. The two requirements
 *    are contradictory, so no amount of refinement resolves it.
 *
 * The jump is not an artefact — it is a step between two blocks, which is a
 * WALL. Walls are geometry. So the deck is emitted as geometry that already has
 * the right shape rather than as a surface something has to approximate:
 *
 *  - one **ribbon** per row, horizontal, at that row's level;
 *  - a **riser** dropping from each ribbon's front edge to the level below;
 *  - a flat **landing** under everything, for the parts of the outline that hold
 *    no rows (aisles, margins, the gaps between blocks).
 *
 * Every deck vertex therefore lies on a row, where the height is exactly defined.
 * A seat's clearance above its own ribbon is exact by construction instead of
 * measured against a tessellation error, and because every ribbon is horizontal
 * the whole deck shades with a single up normal.
 */

import type { Point } from '../../core/types';
import type { RGB } from '../palette';
import polygonClipping from 'polygon-clipping';
import { CHART_UNITS_PER_METRE } from '../../core/units';
import { SEAT_DOT_RADIUS_M } from './seatInstances';
import earcut from 'earcut';
import { MeshBuilder, M } from './geometry';

/** A row ready to draw: its seats as a polyline, and the level it sits at. */
export interface BandRow {
  readonly pts: readonly Point[];
  /** World-metre height of this row's ribbon. */
  readonly y: number;
  /**
   * The row's depth ordinate, chart units — its MEAN distance from the focal.
   *
   * Carried through rather than recomputed here. Deriving it from the row's first
   * seat was tried and buried 20 seats: in a section holding several blocks, one
   * row's first seat and the next row's first seat can be in different blocks
   * entirely, so the implied row gap was wrong by a large factor and a ribbon
   * reached forward far enough to cover the row in front of it.
   */
  readonly depth: number;
  /**
   * Which block (stand) this row belongs to.
   *
   * Neighbour and riser resolution must stay inside a block. Across blocks the
   * nearest row is often the one across an aisle, at a different level, so a
   * ribbon would size itself against a stand it is not part of and a riser would
   * step down onto the wrong deck.
   */
  readonly blockId: number;
}

/**
 * How far a ribbon reaches FORWARD, as a fraction of the gap to the row in front.
 *
 * Deliberately past the halfway line. A ribbon is built by offsetting its own
 * row's polyline, and the ribbon in front is built by offsetting a different
 * polyline with a different vertex count, so their edges do not land on exactly
 * the same curve. Meeting them at 0.5 each would leave hairline gaps showing the
 * landing through the deck. Overlapping instead is free: the ribbon behind is
 * HIGHER, so it simply covers the seam, and the riser closes the vertical face.
 */
const FRONT_REACH = 0.58;

/**
 * Smallest step worth drawing a riser for, world metres.
 *
 * A 1e-4 threshold was tried and emitted 142 needle triangles with aspect ratios
 * to 17,776: risers 5 m long and 0.3 mm tall, where two rows resolved to almost
 * the same level. Such a step is invisible, and the ribbons already overlap
 * enough to close the seam without it. 1 cm is below anything a viewer can see
 * and far above the degenerate range.
 */
const MIN_RISER_M = 0.01;

/**
 * Smallest half-width a ribbon may have, chart units.
 *
 * A seat's dot has a real world radius, so a ribbon narrower than that leaves the
 * dot's rim hanging over the aisle beside it — the same defect the deck padding
 * (`outsetRing`) exists to prevent on the cap path, and it is the same 1.5x
 * margin here. Two orchestra seats were still failing on ribbon width alone
 * before this floor; row pitch happened to be barely over a dot diameter there.
 */
const MIN_REACH_U = SEAT_DOT_RADIUS_M * 1.5 * CHART_UNITS_PER_METRE;

/** How far a ribbon reaches BACK, as a fraction of the gap to the row behind. */
const BACK_REACH = 0.5;

/**
 * How far a ribbon extends past its end seats, as a fraction of the SEAT spacing
 * along the row — not of the row gap.
 *
 * The row gap was tried and buried 23 seats. A section can hold several blocks
 * side by side (the amphitheatre gallery holds six), and the aisle between two
 * blocks is often narrower than a row gap, so a ribbon extended by a row gap
 * reached over its neighbour's seats — which sit at a DIFFERENT level, so the
 * overhanging ribbon painted over them. Seat spacing is the right measure: it is
 * exactly enough to carry the end seat's own dot and cannot cross an aisle.
 */
const END_REACH = 0.6;

/**
 * Outward normals along a polyline, pointing in the direction of increasing
 * depth (away from `focal`).
 *
 * Taken from the row's own local direction rather than from the height field's
 * gradient: the field is a step function now, so its gradient is zero almost
 * everywhere and undefined on the steps.
 */
function rowNormals(pts: readonly Point[], focal: Point): Array<readonly [number, number]> {
  const n = pts.length;
  const raw: Array<readonly [number, number]> = [];
  for (let i = 0; i < n; i++) {
    // Central difference gives a smooth normal along a curved row; the ends fall
    // back to their single adjacent segment.
    const a = pts[Math.max(0, i - 1)];
    const b = pts[Math.min(n - 1, i + 1)];
    let dx = b.x - a.x, dy = b.y - a.y;
    const len = Math.hypot(dx, dy);
    if (len < 1e-9) { raw.push([0, 0]); continue; }
    dx /= len; dy /= len;
    raw.push([-dy, dx]);
  }

  // Orient the WHOLE ROW at once, from the sum of the per-vertex tests, rather
  // than flipping each vertex on its own.
  //
  // Per-vertex orientation was tried and left a hole in the deck. The test is
  // "does this normal point away from the focal", and its value passes through
  // zero when a row runs radially — straight at the stage rather than across it.
  // The amphitheatre orchestra has such rows, and there the sign flipped between
  // two adjacent vertices, so the quad between them was built with its two ends
  // offset in OPPOSITE directions: a bow-tie that covers neither side properly.
  // One seat's dot rim ended up over the void.
  //
  // A row is a single object with one front and one back, so the decision belongs
  // to the row. Summing is also the stable form of the same test: it is dominated
  // by the vertices where the answer is unambiguous.
  let vote = 0;
  for (let i = 0; i < n; i++) {
    vote += (pts[i].x - focal.x) * raw[i][0] + (pts[i].y - focal.y) * raw[i][1];
  }
  const flip = vote < 0;
  return flip ? raw.map(([x, y]) => [-x, -y] as const) : raw;
}

/** Extend a polyline past both ends along its end tangents by `by` chart units. */
function extendEnds(pts: readonly Point[], by: number): Point[] {
  if (pts.length < 2 || by <= 0) return [...pts];
  const out = [...pts];
  const dir = (p: Point, q: Point): Point => {
    const dx = q.x - p.x, dy = q.y - p.y;
    const len = Math.hypot(dx, dy) || 1;
    return { x: dx / len, y: dy / len };
  };
  const head = dir(out[1], out[0]);
  const tail = dir(out[out.length - 2], out[out.length - 1]);
  out.unshift({ x: out[0].x + head.x * by, y: out[0].y + head.y * by });
  out.push({
    x: out[out.length - 1].x + tail.x * by,
    y: out[out.length - 1].y + tail.y * by,
  });
  return out;
}

/** Perpendicular distance from a point to a row's polyline, chart units. */
function distToPolyline(pts: readonly Point[], x: number, y: number): number {
  if (pts.length === 1) return Math.hypot(x - pts[0].x, y - pts[0].y);
  let best = Infinity;
  for (let i = 0; i + 1 < pts.length; i++) {
    const a = pts[i], b = pts[i + 1];
    const vx = b.x - a.x, vy = b.y - a.y;
    const len2 = vx * vx + vy * vy;
    let t = len2 > 1e-12 ? ((x - a.x) * vx + (y - a.y) * vy) / len2 : 0;
    if (t < 0) t = 0; else if (t > 1) t = 1;
    const d = Math.hypot(x - (a.x + t * vx), y - (a.y + t * vy));
    if (d < best) best = d;
  }
  return best;
}

/** A row's SPATIAL neighbours: how wide its ribbon is, and what it steps down to. */
interface Neighbourhood {
  /** Perpendicular distance to the nearest other row, chart units. */
  pitch: number;
  /** World-metre level of the nearest row in FRONT, or null if this row is first. */
  belowY: number | null;
}

/**
 * Resolve each row's neighbours by POSITION, not by order in the array.
 *
 * `rows` arrives sorted by depth across the whole section, and a section
 * routinely holds several blocks. Two consecutive entries in that ordering are
 * usually the same row index in two DIFFERENT blocks, at almost the same depth —
 * so treating them as neighbours gave a row pitch of nearly zero. Measured, that
 * produced ribbons a couple of centimetres wide (so seat rims hung off the deck
 * in 394 of 400 samples) and risers 5 m long by 0.3 mm tall.
 *
 * The spatially nearest row is the real neighbour whatever block it is in, and
 * the nearest row that is closer to the focal is the one this ribbon steps down
 * onto.
 */
function neighbourhoods(rows: readonly BandRow[]): Neighbourhood[] {
  // Probe from points ON the row, at a quarter, a half and three quarters along
  // it. The centroid was tried and broke the arena: its rows are strong arcs, and
  // an arc's centroid lies well inside the curve rather than on it, so distances
  // measured from there are not the row pitch at all (arena rims went 0 -> 272
  // off deck). A point on the polyline measures the true perpendicular gap, and
  // three of them keep one odd row end from setting the whole ribbon's width.
  const probesOf = (pts: readonly Point[]): Point[] => {
    const n = pts.length;
    if (n <= 2) return [...pts];
    return [pts[Math.floor(n * 0.25)], pts[Math.floor(n * 0.5)], pts[Math.floor(n * 0.75)]];
  };

  const out: Neighbourhood[] = [];
  for (let i = 0; i < rows.length; i++) {
    const probes = probesOf(rows[i].pts);
    const pitches: number[] = [];
    let bestFrontD = Infinity, belowY: number | null = null;
    for (const c of probes) {
      let nearest = Infinity;
      for (let j = 0; j < rows.length; j++) {
        // Neighbours are rows at a DIFFERENT LEVEL, not rows in the same block.
        //
        // "Same block" was tried and broke the concert hall: block detection
        // legitimately fragments one stand into several (sec-terr-0's 12 rows
        // resolved into 4), and a fragment's front neighbour then sits in another
        // block and was skipped — so the pitch came from a distant row, the
        // ribbon reached far forward, and it buried the seats of the row in front
        // by 0.20 m.
        //
        // Level is the property that actually distinguishes the two cases: a
        // lateral neighbour across an aisle shares this row's level (it is the
        // same row, split), while the row in front or behind does not.
        if (j === i || Math.abs(rows[j].y - rows[i].y) < 1e-3) continue;
        const d = distToPolyline(rows[j].pts, c.x, c.y);
        if (d < nearest) nearest = d;
        // "In front" = nearer the focal, i.e. a smaller depth ordinate.
        if (rows[j].depth < rows[i].depth && d < bestFrontD) {
          bestFrontD = d;
          belowY = rows[j].y;
        }
      }
      if (Number.isFinite(nearest) && nearest > 0) pitches.push(nearest);
    }
    pitches.sort((a, b) => a - b);
    // Median: robust to one probe landing beside an aisle or a short row.
    const pitch = pitches.length ? pitches[Math.floor(pitches.length / 2)] : 1;
    out.push({ pitch, belowY });
  }
  return out;
}

export interface BandColors {
  /** Ribbon (tread) top colour, AO already applied. */
  tread: RGB;
  /** Riser face colour, AO already applied. */
  riser: RGB;
}


/** One row's ribbon: the polyline it is built on, its normals, and its reaches. */
interface Ribbon {
  pts: Point[];
  nrm: Array<readonly [number, number]>;
  front: number;
  back: number;
}

/**
 * Resolve one row's ribbon geometry.
 *
 * Shared by the mesh emitter and the footprint builder so the drawn ribbons and
 * the block outline extruded beneath them are derived from ONE computation. They
 * disagreeing is the same class of bug as the cap and the seats disagreeing.
 */
function ribbonOf(rows: readonly BandRow[], i: number, nbrs: Neighbourhood[], focal: Point): Ribbon | null {
  const row = rows[i];
  // A "row" of one seat is a free-standing seat, not a row — it still needs a
  // deck under it, so give it a short segment across the view direction and let
  // the normal ribbon path carry it. Skipping these left their dots hanging
  // over the landing.
  const rowPts = row.pts.length >= 2
    ? [...row.pts]
    : row.pts.length === 1
      ? ((): Point[] => {
        const p = row.pts[0];
        let dx = p.x - focal.x, dy = p.y - focal.y;
        const len = Math.hypot(dx, dy) || 1;
        dx /= len; dy /= len;
        // Across the line of sight, half a pitch each way.
        const h = Math.max(nbrs[i].pitch, 1e-3) * 0.5;
        return [{ x: p.x + dy * h, y: p.y - dx * h }, { x: p.x - dy * h, y: p.y + dx * h }];
      })()
      : [];
  if (rowPts.length < 2) return null;

  let seatSpan = 0, spanN = 0;
  for (let k = 1; k < rowPts.length; k++) {
    const d = Math.hypot(rowPts[k].x - rowPts[k - 1].x, rowPts[k].y - rowPts[k - 1].y);
    if (d > 1e-6) { seatSpan += d; spanN++; }
  }
  const spacing = spanN > 0 ? seatSpan / spanN : 0;
  const pts = extendEnds(rowPts, Math.max(spacing * END_REACH, MIN_REACH_U));
  return {
    pts,
    nrm: rowNormals(pts, focal),
    front: Math.max(nbrs[i].pitch * FRONT_REACH, MIN_REACH_U),
    back: Math.max(nbrs[i].pitch * BACK_REACH, MIN_REACH_U),
  };
}

/** A block: the footprint its ribbons cover, and the level its base sits at. */
export interface DeckFootprint {
  /** Outer ring, chart units. */
  outline: Point[];
  /** Any interior rings (an enclosed gap between rows). */
  holes: Point[][];
  /** World-metre height of this block's lowest ribbon — the top of its base. */
  topY: number;
}

/**
 * The footprint of each BLOCK in a section, as the union of its ribbons.
 *
 * This replaces extruding the section's whole authored outline under the deck.
 * That outline is drawn generously — it reaches past the last row and across the
 * gaps between blocks — so a single flat plate at the front row's level stuck out
 * around the seating as a large slab, and every block's end read as a square cut
 * through that slab rather than as the edge of a stand.
 *
 * Unioning the ribbons instead yields one polygon per block automatically (the
 * amphitheatre's three sections resolve to 4, 5 and 6 blocks — exactly their
 * wedge counts), each hugging its own seating, and each carrying its own base
 * level rather than sharing the section's. Costs 7–13 ms per section at build
 * time, which is paid once.
 */
export function deckFootprints(rows: readonly BandRow[], focal: Point): DeckFootprint[] {
  if (rows.length < 2) return [];
  const nbrs = neighbourhoods(rows);
  const rings: Array<[number, number][][]> = [];
  const ribbons: Array<Ribbon | null> = [];
  for (let i = 0; i < rows.length; i++) {
    const r = ribbonOf(rows, i, nbrs, focal);
    ribbons.push(r);
    if (!r) continue;
    const f: [number, number][] = [];
    const b: [number, number][] = [];
    const rf = r.front + FOOTPRINT_MARGIN_U;
    const rb = r.back + FOOTPRINT_MARGIN_U;
    for (let k = 0; k < r.pts.length; k++) {
      const p = r.pts[k], n = r.nrm[k];
      f.push([p.x - n[0] * rf, p.y - n[1] * rf]);
      b.push([p.x + n[0] * rb, p.y + n[1] * rb]);
    }
    const ring = [...f, ...b.reverse()];
    if (ring.length < 3) continue;
    ring.push(ring[0]); // polygon-clipping wants closed rings
    rings.push([ring]);
  }
  if (!rings.length) return [];

  let merged: ReturnType<typeof polygonClipping.union>;
  try {
    merged = polygonClipping.union(rings[0], ...rings.slice(1));
  } catch {
    return []; // never let a degenerate row set break the whole scene
  }

  const out: DeckFootprint[] = [];
  for (const poly of merged) {
    if (!poly.length || poly[0].length < 4) continue;
    const toPts = (ring: readonly [number, number][]): Point[] => {
      const pts = ring.map(([x, y]) => ({ x, y }));
      // union() repeats the first point to close the ring; drop the duplicate.
      const first = pts[0], last = pts[pts.length - 1];
      if (pts.length > 1 && Math.abs(first.x - last.x) < 1e-9 && Math.abs(first.y - last.y) < 1e-9) pts.pop();
      return pts;
    };
    const outline = toPts(poly[0]);
    if (outline.length < 3) continue;
    // This block's base is its own lowest row, not the section's — otherwise a
    // block set high in the bowl would be drawn standing on the front block's floor.
    let topY = Infinity;
    for (let i = 0; i < rows.length; i++) {
      const r = ribbons[i];
      if (!r) continue;
      const mid = r.pts[Math.floor(r.pts.length / 2)];
      if (pointInRing(outline, mid.x, mid.y) && rows[i].y < topY) topY = rows[i].y;
    }
    if (!Number.isFinite(topY)) continue;
    out.push({
      outline: simplifyRing(outline, FOOTPRINT_TOLERANCE_U),
      holes: poly.slice(1).map(toPts).map((h) => simplifyRing(h, FOOTPRINT_TOLERANCE_U))
        .filter((h) => h.length >= 3),
      topY,
    });
  }
  return out;
}

/**
 * Douglas-Peucker simplification tolerance for a block outline, chart units
 * (~7 mm in world metres).
 *
 * Unioning ~100 overlapping ribbons leaves long runs of near-collinear vertices
 * along a block's boundary, and earcut fans those into needles — measured aspect
 * ratios of 18,893 and 4,576,013, the same defect that flat-shades as dark
 * hairlines. The block outline carries no detail at this scale (the SEATS are
 * carried by the ribbons above it, not by this base), so simplifying is free.
 */
const FOOTPRINT_TOLERANCE_U = 0.3;

/**
 * Extra width given to a ribbon before it is unioned into a block footprint,
 * chart units (~3 cm world).
 *
 * Unioning ribbons at their exact width makes neighbouring ribbons meet
 * TANGENTIALLY, and a boolean union of tangential shapes emits zero-width slits
 * along the seam — metres long, well under a millimetre wide. Overlapping them
 * decisively removes the seam instead of leaving one to clean up afterwards. The
 * footprint is only the base beneath the ribbons, so a 3 cm margin is invisible.
 */
const FOOTPRINT_MARGIN_U = 1.5;

/** Douglas-Peucker on an open point run. */
function simplifyRun(pts: Point[], tol: number): Point[] {
  if (pts.length < 3) return pts;
  const a = pts[0], b = pts[pts.length - 1];
  const dx = b.x - a.x, dy = b.y - a.y;
  const len = Math.hypot(dx, dy);
  let worst = -1, worstI = -1;
  for (let i = 1; i < pts.length - 1; i++) {
    const p = pts[i];
    const d = len > 1e-12
      ? Math.abs((p.x - a.x) * dy - (p.y - a.y) * dx) / len
      : Math.hypot(p.x - a.x, p.y - a.y);
    if (d > worst) { worst = d; worstI = i; }
  }
  if (worst <= tol || worstI < 0) return [a, b];
  const left = simplifyRun(pts.slice(0, worstI + 1), tol);
  const right = simplifyRun(pts.slice(worstI), tol);
  return [...left.slice(0, -1), ...right];
}

/** Simplify a closed ring, keeping it closed. */
function simplifyRing(ring: Point[], tol: number): Point[] {
  if (ring.length < 4) return ring;
  // Split at the two extreme points so the closing edge is simplified too.
  const out = simplifyRun([...ring, ring[0]], tol);
  out.pop();
  return out.length >= 3 ? out : ring;
}

/** Even-odd point-in-ring test. */
function pointInRing(ring: readonly Point[], x: number, y: number): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i], b = ring[j];
    if ((a.y > y) !== (b.y > y) && x < ((b.x - a.x) * (y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

/**
 * Cheap containment test for the clip region, so the boolean is only run for the
 * quads that actually straddle a boundary.
 */
class ClipTest {
  private rings: Point[][];
  private minX = Infinity; private minY = Infinity;
  private maxX = -Infinity; private maxY = -Infinity;

  constructor(rings: Point[][]) {
    this.rings = rings;
    for (const r of rings) {
      for (const p of r) {
        if (p.x < this.minX) this.minX = p.x;
        if (p.y < this.minY) this.minY = p.y;
        if (p.x > this.maxX) this.maxX = p.x;
        if (p.y > this.maxY) this.maxY = p.y;
      }
    }
  }

  /** True when every point lies strictly inside ONE ring of the clip region. */
  containsAll(pts: readonly Point[]): boolean {
    for (const p of pts) {
      if (p.x < this.minX || p.x > this.maxX || p.y < this.minY || p.y > this.maxY) return false;
    }
    // A quad spanning two disjoint rings must go through the boolean, so the
    // test demands a SINGLE ring contain all of it.
    for (const ring of this.rings) {
      let all = true;
      for (const p of pts) {
        if (!pointInRing(ring, p.x, p.y)) { all = false; break; }
      }
      if (all) return true;
    }
    return false;
  }
}

/**
 * Emit a horizontal quad clipped to `clipRing`, triangulated.
 *
 * Treads are horizontal, so every piece shades with the same up normal whatever
 * shape the clip leaves behind — which is what makes clipping cheap here.
 */
function emitClippedQuad(
  builder: MeshBuilder,
  clipRing: [number, number][][],
  clipTest: ClipTest,
  quad: Point[],
  y: number,
  color: RGB,
): void {
  // FAST PATH: a quad wholly inside the clip contributes nothing to clip, and
  // the overwhelming majority are — only ribbons at a section's edge straddle it.
  // Running a polygon boolean per ribbon SEGMENT regardless cost ~100,000
  // intersections on a 99k-seat venue and dominated scene build (8.5 s of 11 s).
  if (clipTest.containsAll(quad)) {
    const UPF = [0, 1, 0] as const;
    const a = quad[0], b = quad[1], c = quad[2], d = quad[3];
    builder.tri([a.x * M, y, a.y * M], [b.x * M, y, b.y * M], [c.x * M, y, c.y * M], UPF, color);
    builder.tri([a.x * M, y, a.y * M], [c.x * M, y, c.y * M], [d.x * M, y, d.y * M], UPF, color);
    return;
  }
  const ring: [number, number][] = quad.map((p) => [p.x, p.y]);
  ring.push(ring[0]);
  let pieces: ReturnType<typeof polygonClipping.intersection>;
  try {
    pieces = polygonClipping.intersection([ring], clipRing);
  } catch {
    return; // a degenerate quad simply contributes nothing
  }
  const UP = [0, 1, 0] as const;
  for (const poly of pieces) {
    if (!poly.length || poly[0].length < 4) continue;
    const outer = poly[0];
    const flat: number[] = [];
    const pts: Array<[number, number]> = [];
    for (let i = 0; i < outer.length - 1; i++) { // drop the repeated closing point
      flat.push(outer[i][0], outer[i][1]);
      pts.push([outer[i][0], outer[i][1]]);
    }
    if (pts.length < 3) continue;
    const tris = earcut(flat, undefined, 2);
    for (let i = 0; i < tris.length; i += 3) {
      const a = pts[tris[i]], b = pts[tris[i + 1]], c = pts[tris[i + 2]];
      builder.tri(
        [a[0] * M, y, a[1] * M],
        [b[0] * M, y, b[1] * M],
        [c[0] * M, y, c[1] * M],
        UP, color,
      );
    }
  }
}

/**
 * Emit one section's ribbons and risers.
 *
 * `rows` must be ordered front first (nearest the focal), which is the contract
 * `SectionRake.rows` provides.
 */
export function emitDeckBands(
  builder: MeshBuilder,
  rows: readonly BandRow[],
  focal: Point,
  landingY: number,
  colors: BandColors,
  clip?: readonly Point[],
): void {
  if (rows.length < 2) return;
  const nbrs = neighbourhoods(rows);
  const UP = [0, 1, 0] as const;
  const clipRing: [number, number][][] | null = clip && clip.length >= 3
    ? [[...clip.map((p) => [p.x, p.y] as [number, number]), [clip[0].x, clip[0].y]]]
    : null;
  const clipTest = clip && clip.length >= 3 ? new ClipTest([[...clip]]) : null;

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const rib = ribbonOf(rows, i, nbrs, focal);
    if (!rib) continue;
    const { pts, nrm, front, back } = rib;

    // The level below this ribbon: the spatially nearest row in front of it, or
    // the landing when nothing is in front (this row is its block's first).
    const belowY = nbrs[i].belowY ?? landingY;

    for (let k = 0; k + 1 < pts.length; k++) {
      const p = pts[k], q = pts[k + 1];
      const np = nrm[k], nq = nrm[k + 1];
      // Skip degenerate input: a duplicated seat position, or a vertex whose
      // normal collapsed. Emitting these produced needle triangles with aspect
      // ratios to 17,776 — meaningless geometry that flat-shades as dark streaks,
      // the exact defect the ring cleanup removed from the cap path.
      if (Math.hypot(q.x - p.x, q.y - p.y) < 1e-6) continue;
      if ((np[0] === 0 && np[1] === 0) || (nq[0] === 0 && nq[1] === 0)) continue;

      const pF: [number, number, number] = [(p.x - np[0] * front) * M, row.y, (p.y - np[1] * front) * M];
      const qF: [number, number, number] = [(q.x - nq[0] * front) * M, row.y, (q.y - nq[1] * front) * M];
      const pB: [number, number, number] = [(p.x + np[0] * back) * M, row.y, (p.y + np[1] * back) * M];
      const qB: [number, number, number] = [(q.x + nq[0] * back) * M, row.y, (q.y + nq[1] * back) * M];

      // Tread: horizontal, so one shared up normal is exact.
      if (clipRing && clipTest) {
        // A ribbon reaches past its own row on all four sides, and near a section
        // boundary that reach crosses into the NEXT section. Where the neighbour
        // sits lower, the overhang covers its seats: 27 concert-hall seats were
        // buried by 0.20 m under the terrace beside them, which is 0.60 m higher.
        // Clipping to the section's own padded outline keeps a deck inside the
        // section that drew it.
        emitClippedQuad(builder, clipRing, clipTest!, [
          { x: p.x - np[0] * front, y: p.y - np[1] * front },
          { x: q.x - nq[0] * front, y: q.y - nq[1] * front },
          { x: q.x + nq[0] * back, y: q.y + nq[1] * back },
          { x: p.x + np[0] * back, y: p.y + np[1] * back },
        ], row.y, colors.tread);
      } else {
        builder.tri(pF, qF, qB, UP, colors.tread);
        builder.tri(pF, qB, pB, UP, colors.tread);
      }

      // Riser: the vertical face under the ribbon's front edge. Skipped when it
      // would be inverted or degenerate (a level or descending step).
      if (row.y > belowY + MIN_RISER_M) {
        const pFd: [number, number, number] = [pF[0], belowY, pF[2]];
        const qFd: [number, number, number] = [qF[0], belowY, qF[2]];
        // Faces the focal — the direction the audience looks from.
        const rn: readonly [number, number, number] = [-np[0], 0, -np[1]];
        builder.tri(pF, qF, qFd, rn, colors.riser);
        builder.tri(pF, qFd, pFd, rn, colors.riser);
      }
    }
  }
}

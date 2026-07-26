/**
 * A section's RAKE FIELD — the scalar "depth" that its seating rises along.
 *
 * ## The defect this exists to fix
 *
 * Both the eye-height model (`layout.ts`) and the 3D seating surface
 * (`view3d/scene/surface.ts`) used to raise a seat by its radial distance from
 * ONE venue focal point. That is only correct when a section's rows are
 * concentric arcs about that focal.
 *
 * Measured on the amphitheatre gallery, whose rows are straight blocks: a single
 * row's seats span a radial-distance range of 105 chart units on the
 * centre-facing blocks and 240 on the side blocks. Since height is a function of
 * that distance, one row's seats landed at DIFFERENT heights — a within-row deck
 * spread of 2.30 m on the side blocks against 1.05 m on the centre-facing ones.
 * On screen the rows visibly tilt, and the tilt differs block to block, which is
 * exactly the left/right asymmetry the owner reported.
 *
 * ## Why a per-section AXIS is not enough
 *
 * The first attempt fitted one straight rake axis per section by PCA over its row
 * centroids, and scored it against the radial model. It did not fix the
 * amphitheatre, because `sec-gall` is a SINGLE section containing six wedge
 * blocks at six different orientations. No single axis — straight or radial —
 * fits them all, so the fit correctly fell back to radial and the tilt survived.
 * Sections containing several blocks are normal, not exotic.
 *
 * ## The model that does work
 *
 * Depth is defined by the section's OWN ROWS. Each row gets one depth value (the
 * mean distance of its seats from the focal), and the field at an arbitrary point
 * is an inverse-distance blend of the nearest rows' depths.
 *
 * The properties that matter:
 *
 *  - **Exact on a row.** A point on a row has zero distance to it, so it takes
 *    that row's depth exactly and every seat in the row lands at ONE height.
 *    The tilt cannot come back, whatever the row's orientation.
 *  - **Orientation-free.** Straight blocks, arcs, fans, in-the-round and blocks
 *    at six different angles in one section all work, because nothing is fitted
 *    to a direction.
 *  - **Continuous.** It is a field over the plane, not a per-seat lookup. The 3D
 *    cap is tessellated at points BETWEEN seats and needs a value and a gradient
 *    there; a per-row lookup would leave the deck undefined between rows and put
 *    the seats back off the surface they stand on.
 *
 * That last point is why quantising per row inside `assignEyeHeights` was tried
 * and removed: the renderer cannot follow a step function it has no definition
 * for, and the two models diverging is the trap that made every offset constant
 * chart-specific.
 */

import type { Point } from './types';

/** A resolved row: its seats as an ordered polyline, plus its depth ordinate. */
export interface RakeRowFit {
  /** The row's seats, ordered along the row. */
  readonly pts: readonly Point[];
  /** Mean distance of the row's seats from the focal — what rise is a function of. */
  readonly depth: number;
}

export interface SectionRake {
  readonly kind: 'radial' | 'rows';
  /** Depth ordinate at a chart-unit point; rise is a function of this. */
  depthAt(x: number, y: number): number;
  /** Unit gradient direction of `depthAt` — turns a rake angle into a normal. */
  gradientAt(x: number, y: number): readonly [number, number];
  /** Number of rows the field was built from (0 for the radial fallback). */
  readonly rowCount: number;
  /**
   * The section's rows, ORDERED BY DEPTH (front first).
   *
   * The deck is built directly from these — one level ribbon per row — rather
   * than by tessellating `depthAt`. See `deckBands.ts` for why: a section holding
   * several blocks at different heights has a genuine cliff between them, and no
   * continuous field can be both level on every row and trackable by refinement.
   */
  readonly rows: readonly RakeRowFit[];
  /** Index into `rows` of the row nearest a point, or -1 when there are none. */
  nearestRow(x: number, y: number): number;
}

/** One row's member points, in any order. */
export interface RakeRow {
  points: Point[];
}

/** How many nearest rows contribute to a blended sample. */
const BLEND_ROWS = 3;

/**
 * A row further than this multiple of the nearest row's distance contributes
 * nothing. Just above 2 so the two rows bracketing a point midway between them
 * both count (their distances differ by at most the row pitch), while a row on
 * the far side of an aisle or beyond the last row does not.
 */
const BLEND_DISTANCE_RATIO = 2.2;

/** Step used for the finite-difference gradient, chart units. */
const GRAD_STEP = 0.5;

function radialRake(focal: Point): SectionRake {
  return {
    kind: 'radial',
    rowCount: 0,
    rows: [],
    nearestRow: () => -1,
    depthAt: (x, y) => Math.hypot(x - focal.x, y - focal.y),
    gradientAt: (x, y) => {
      const dx = x - focal.x, dy = y - focal.y;
      const d = Math.hypot(dx, dy);
      // At the focal the gradient is undefined; the surface is flat there anyway.
      return d < 1e-9 ? [0, 0] : [dx / d, dy / d];
    },
  };
}

interface RowFit {
  /**
   * The row as an ordered POLYLINE through its own seats — not a straight chord.
   *
   * A chord was tried first and broke the arena: its upper-bowl rows are strong
   * arcs, so a seat at the end of a row sits far from the chord between the row's
   * extremes. The blend below then treated that seat as "between rows" and gave
   * it a neighbouring row's depth, which put the within-row spread UP from 0.07 m
   * to 2.83 m. Distance must be measured to the row's real shape, so that every
   * one of its seats reads as being exactly on it.
   */
  pts: Point[];
  /** Row centroid, and the radius of a circle about it containing the row. */
  cx: number;
  cy: number;
  radius: number;
  /** The row's depth ordinate — mean distance of its seats from the focal. */
  depth: number;
}

/**
 * Reduce a row to a segment plus a depth.
 *
 * The direction comes from the row's own extent (the two furthest-apart seats),
 * not from a fitted line: it is exact for a straight row, good enough for a
 * gently curved one, and cannot be thrown off by an outlier the way a
 * least-squares fit through few points can.
 */
function fitRow(points: Point[], focal: Point): RowFit | null {
  if (!points.length) return null;
  let cx = 0, cy = 0, depth = 0;
  for (const p of points) {
    cx += p.x; cy += p.y;
    depth += Math.hypot(p.x - focal.x, p.y - focal.y);
  }
  const n = points.length;
  cx /= n; cy /= n; depth /= n;

  // Order the seats along the row so consecutive pairs are real segments. The
  // chord direction is only used for this ORDERING, never for distance, so a
  // curved row orders correctly even though its chord is a poor fit to it.
  let ax = points[0], far = -1;
  for (const p of points) {
    const d = Math.hypot(p.x - cx, p.y - cy);
    if (d > far) { far = d; ax = p; }
  }
  let dx = ax.x - cx, dy = ax.y - cy;
  const len = Math.hypot(dx, dy);
  if (len > 1e-9) { dx /= len; dy /= len; } else { dx = 1; dy = 0; }
  const pts = [...points].sort((p, q) =>
    ((p.x - cx) * dx + (p.y - cy) * dy) - ((q.x - cx) * dx + (q.y - cy) * dy));

  let radius = 0;
  for (const p of pts) {
    const d = Math.hypot(p.x - cx, p.y - cy);
    if (d > radius) radius = d;
  }
  return { pts, cx, cy, radius, depth };
}

/** Distance from a point to a row's polyline. */
function distToRow(r: RowFit, x: number, y: number): number {
  const pts = r.pts;
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

/** How many rows survive the cheap bounding-circle prefilter. */
const CANDIDATE_ROWS = 8;

/**
 * Inverse-distance blend of the nearest rows' depths.
 *
 * Only the nearest few rows contribute, so a distant block on the far side of the
 * venue cannot drag a section's near rows. Squared inverse distance makes the
 * nearest row dominate quickly, which keeps the field flat ALONG a row and
 * varying across it — the shape a rake actually has.
 */
function sampleRows(rows: RowFit[], x: number, y: number): number {
  // Prefilter on each row's bounding circle. `centroidDist - radius` is a true
  // LOWER bound on the polyline distance, so this cannot discard a row that would
  // have won — it just keeps the exact polyline test off ~90 % of the rows, which
  // is what makes the field affordable per cap vertex.
  const candD = new Array<number>(CANDIDATE_ROWS).fill(Infinity);
  const candI = new Array<number>(CANDIDATE_ROWS).fill(-1);
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const lower = Math.hypot(x - r.cx, y - r.cy) - r.radius;
    for (let k = 0; k < CANDIDATE_ROWS; k++) {
      if (lower < candD[k]) {
        for (let j = CANDIDATE_ROWS - 1; j > k; j--) { candD[j] = candD[j - 1]; candI[j] = candI[j - 1]; }
        candD[k] = lower; candI[k] = i;
        break;
      }
    }
  }

  // Nearest BLEND_ROWS by insertion (the list is short and this avoids a sort).
  const bestD = new Array<number>(BLEND_ROWS).fill(Infinity);
  const bestI = new Array<number>(BLEND_ROWS).fill(-1);
  for (const i of candI) {
    if (i < 0) continue;
    const d = distToRow(rows[i], x, y);
    for (let k = 0; k < BLEND_ROWS; k++) {
      if (d < bestD[k]) {
        for (let j = BLEND_ROWS - 1; j > k; j--) { bestD[j] = bestD[j - 1]; bestI[j] = bestI[j - 1]; }
        bestD[k] = d; bestI[k] = i;
        break;
      }
    }
  }
  if (bestI[0] < 0) return 0;
  // Exactly on a row: take its depth, so a seat is never blended off its own row.
  if (bestD[0] < 1e-6) return rows[bestI[0]].depth;

  // Blend only across rows at COMPARABLE distance. Absolute inverse-distance
  // weighting was tried and produced the cap's worst error: in the empty parts of
  // a section outline — beyond the last row, or the gap between two blocks — the
  // two nearest rows can both be hundreds of units away, so their weights stay
  // comparable and the field goes on interpolating between them across the void.
  // Measured, 79 of the gallery's 97 out-of-tolerance sample points sat more than
  // 100 units from ANY seat, and a cap triangle spanning that region missed the
  // surface by up to 10.84 m.
  //
  // A relative cutoff makes the far field settle to the nearest row's depth, i.e.
  // locally CONSTANT, which a flat triangle interpolates exactly. Inside the
  // seating the nearest rows are all within the cutoff, so blending is unchanged
  // and rows stay level.
  const cutoff = bestD[0] * BLEND_DISTANCE_RATIO;
  let num = 0, den = 0;
  for (let k = 0; k < BLEND_ROWS; k++) {
    const i = bestI[k];
    if (i < 0 || bestD[k] > cutoff) continue;
    const w = 1 / (bestD[k] * bestD[k]);
    num += w * rows[i].depth;
    den += w;
  }
  return den > 0 ? num / den : rows[bestI[0]].depth;
}

function rowsRake(rows: RowFit[]): SectionRake {
  const depthAt = (x: number, y: number): number => sampleRows(rows, x, y);
  const nearestRow = (x: number, y: number): number => {
    let best = Infinity, bestI = -1;
    for (let i = 0; i < rows.length; i++) {
      // Bounding-circle lower bound first; only test the polyline if it can win.
      const r = rows[i];
      if (Math.hypot(x - r.cx, y - r.cy) - r.radius >= best) continue;
      const d = distToRow(r, x, y);
      if (d < best) { best = d; bestI = i; }
    }
    return bestI;
  };
  return {
    kind: 'rows',
    rowCount: rows.length,
    rows,
    nearestRow,
    depthAt,
    gradientAt: (x, y) => {
      // Central differences: the blend has no closed form, and shading only needs
      // the direction. A half-unit step is far below row pitch, so this tracks
      // the field rather than smoothing across rows.
      const gx = (depthAt(x + GRAD_STEP, y) - depthAt(x - GRAD_STEP, y)) / (2 * GRAD_STEP);
      const gy = (depthAt(x, y + GRAD_STEP) - depthAt(x, y - GRAD_STEP)) / (2 * GRAD_STEP);
      const len = Math.hypot(gx, gy);
      return len < 1e-9 ? [0, 0] : [gx / len, gy / len];
    },
  };
}

/**
 * Build a section's rake field from its rows.
 *
 * `rows` should be the section's member seats grouped by row. With fewer than two
 * usable rows there is nothing to build a field from, so the radial model is kept
 * — which is also how every chart behaved before this, leaving a row-less or
 * single-row section unchanged.
 */
export function buildSectionRake(rows: RakeRow[], focal: Point): SectionRake {
  const fits: RowFit[] = [];
  for (const r of rows) {
    const f = fitRow(r.points, focal);
    if (f) fits.push(f);
  }
  if (fits.length < 2) return radialRake(focal);
  // Front-first ordering is the contract `rows` promises, and the deck builder
  // relies on it to pair each ribbon with the riser below it.
  fits.sort((a, b) => a.depth - b.depth);
  return rowsRake(fits);
}

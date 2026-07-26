/**
 * THE structure resolver — what a chart's seats actually form, geometrically.
 *
 * A chart is authored in 2D as sections, rows and seats. Rendering it in 3D needs
 * a level above that which the author never states: which rows belong to the same
 * physical STAND, which of them is that stand's front row, and how deep into the
 * stand each row sits. Every height in the venue follows from those three facts.
 *
 * This module resolves them, once, from the authored geometry alone. It is pure —
 * no renderer types, no GL — so the same structure feeds the 3D surface, the
 * eye-height model in `layout.ts`, and anything added later (labels, LOD
 * streaming, per-block camera framing) without any of them re-deriving it. That
 * matters because re-derivation is this codebase's most expensive bug class:
 * three surfaces held apart by offsets, and a cap and its seats measured from
 * different datums, both came from two files computing the same fact differently.
 *
 * ## Why blocks, and why depth is measured inside one
 *
 * A section is not a stand. The amphitheatre's `sec-gall` is a single section
 * holding six wedge blocks that wrap the bowl; the arena's tiers are four blocks
 * each. Height used to be a function of distance from the venue focal, which is
 * wrong for exactly this reason — the side blocks of a tier sit further from the
 * focal than the centre blocks, so they were raised as though they were further
 * back. Measured on `sec-gall`, authored at 6.20 m: its six blocks started at
 * 6.35, 6.37, 8.18, 8.23, 10.60 and 10.65 m. The side wedges were **4.4 m too
 * high**, and that is the tilt-and-lift the owner could see.
 *
 * Depth is therefore measured WITHIN a block, from that block's own front row:
 *
 *     level(row) = section.height + blockDepth(row) · tan(rake)
 *
 * so every block of a tier starts at the tier's authored height, and rows rise by
 * the real spacing between them. A venue whose tier is genuinely flat authors
 * `rake = 0` and every row lands on the same level — the same model, no special
 * case, which is what lets one code path serve a stepped bowl and a flat terrace.
 */

import type { ExpandedSeat, Point } from './types';

/** A row resolved into its stand. */
export interface ResolvedRow {
  /** The row's authored id, or a synthetic one for a seat that has none. */
  id: string;
  /** The row's seats as an ordered polyline (the shape the deck is built on). */
  pts: Point[];
  /** Indices into the input seat array, parallel to nothing — for attribution. */
  seatIndices: number[];
  /** Which block (stand) this row belongs to, within its section. */
  blockId: number;
  /** 0 for the block's front row, then 1, 2, … going back. */
  ordinal: number;
  /**
   * Distance back from the block's FRONT row, chart units, accumulated over the
   * real gaps between consecutive rows.
   *
   * Not the ordinal times a nominal pitch: a stand with an aisle break or a
   * widening row gap should rise over that gap, and accumulating the measured
   * spacing keeps the drawn deck on the seats. Not distance from the venue focal
   * either — that is the defect described above.
   */
  blockDepth: number;
  /** Mean distance of the row's seats from the venue focal (front-row ordering). */
  focalDistance: number;
}

export interface ResolvedSection {
  sectionId: string;
  /** Rows ordered by block, then front-to-back within the block. */
  rows: ResolvedRow[];
  /** Number of distinct blocks found. */
  blockCount: number;
}

/**
 * Two rows join the same block when a probe on one lands within this multiple of
 * the section's typical row spacing of the other.
 *
 * Above 1 so consecutive rows of one stand always connect (they are one spacing
 * apart by definition, and real charts vary). Well below the width of an aisle or
 * a vomitory, which is what has to stay a break — otherwise the six wedges of a
 * bowl merge into one block and the defect this module exists to fix comes back.
 */
const BLOCK_LINK_RATIO = 1.8;

/** Sample points along a row, used for every distance test here. */
function probesOf(pts: readonly Point[]): Point[] {
  const n = pts.length;
  if (n <= 3) return [...pts];
  return [pts[Math.floor(n * 0.25)], pts[Math.floor(n * 0.5)], pts[Math.floor(n * 0.75)]];
}

/** Perpendicular distance from a point to a polyline, chart units. */
export function distanceToPolyline(pts: readonly Point[], x: number, y: number): number {
  if (!pts.length) return Infinity;
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

/** A row's bounding circle — the prune that keeps block detection off O(n²) work. */
interface RowBound { cx: number; cy: number; r: number }

function boundOf(pts: readonly Point[]): RowBound {
  let cx = 0, cy = 0;
  for (const p of pts) { cx += p.x; cy += p.y; }
  const n = pts.length || 1;
  cx /= n; cy /= n;
  let r = 0;
  for (const p of pts) {
    const d = Math.hypot(p.x - cx, p.y - cy);
    if (d > r) r = d;
  }
  return { cx, cy, r };
}

/**
 * Lower bound on the gap between two rows, from their bounding circles.
 *
 * Admissible: the true gap can never be smaller, so pruning on this cannot
 * discard a pair that would have linked. Pair testing is quadratic in a section's
 * row count, and a 50k-seat venue has sections with thousands of rows — without
 * this prune, resolving one of them is hundreds of millions of segment tests.
 */
function boundGap(a: RowBound, b: RowBound): number {
  return Math.hypot(a.cx - b.cx, a.cy - b.cy) - a.r - b.r;
}

/** Shortest distance between two rows, measured from probes on each. */
function rowGap(a: readonly Point[], b: readonly Point[]): number {
  let best = Infinity;
  for (const p of probesOf(a)) {
    const d = distanceToPolyline(b, p.x, p.y);
    if (d < best) best = d;
  }
  for (const p of probesOf(b)) {
    const d = distanceToPolyline(a, p.x, p.y);
    if (d < best) best = d;
  }
  return best;
}

/**
 * Order a row's seats along the row.
 *
 * The chord between the two extremes only decides the ORDER; distances are never
 * measured against it. A curved row orders correctly under this even though its
 * chord is a poor fit to its shape.
 */
function orderAlongRow(pts: Point[], indices: number[]): { pts: Point[]; seatIndices: number[] } {
  if (pts.length < 3) return { pts, seatIndices: indices };
  let cx = 0, cy = 0;
  for (const p of pts) { cx += p.x; cy += p.y; }
  cx /= pts.length; cy /= pts.length;
  let far = -1, ax = pts[0];
  for (const p of pts) {
    const d = Math.hypot(p.x - cx, p.y - cy);
    if (d > far) { far = d; ax = p; }
  }
  let dx = ax.x - cx, dy = ax.y - cy;
  const len = Math.hypot(dx, dy);
  if (len > 1e-9) { dx /= len; dy /= len; } else { dx = 1; dy = 0; }
  const order = pts.map((p, i) => ({ p, i, t: (p.x - cx) * dx + (p.y - cy) * dy }))
    .sort((u, v) => u.t - v.t);
  return { pts: order.map((o) => o.p), seatIndices: order.map((o) => indices[o.i]) };
}

/**
 * Least-squares circle through a set of points (Kåsa fit), or null if degenerate.
 *
 * Used to find the centre a section's rows were struck about, which is NOT the
 * chart's focal point. The amphitheatre makes this concrete: its rows are arcs
 * about a centre `C`, while `focalPoint` is the stage at {0, 75}. Measuring depth
 * from the focal therefore varied ALONG each arc — the original row tilt — and
 * made concentric rows look radial to every heuristic downstream.
 *
 * The focal is where the audience LOOKS. The row centre is what the seating was
 * drawn around. Conflating them is the mistake underneath several of the defects
 * in this file's history.
 */
function fitCircle(pts: readonly Point[]): { cx: number; cy: number } | null {
  const n = pts.length;
  if (n < 3) return null;
  let mx = 0, my = 0;
  for (const p of pts) { mx += p.x; my += p.y; }
  mx /= n; my /= n;
  let suu = 0, suv = 0, svv = 0, suuu = 0, svvv = 0, suvv = 0, svuu = 0;
  for (const p of pts) {
    const u = p.x - mx, v = p.y - my;
    suu += u * u; svv += v * v; suv += u * v;
    suuu += u * u * u; svvv += v * v * v;
    suvv += u * v * v; svuu += v * u * u;
  }
  const det = suu * svv - suv * suv;
  if (Math.abs(det) < 1e-9) return null;
  const b1 = (suuu + suvv) / 2;
  const b2 = (svvv + svuu) / 2;
  const uc = (b1 * svv - b2 * suv) / det;
  const vc = (b2 * suu - b1 * suv) / det;
  const cx = uc + mx, cy = vc + my;
  if (!Number.isFinite(cx) || !Number.isFinite(cy)) return null;
  return { cx, cy };
}

/**
 * Largest share of a section's radial depth that one row may span about a fitted
 * centre before the concentric model is rejected.
 *
 * A true arc row spans ~0 radially. A straight row spans a lot. 0.15 separates
 * them decisively without needing to know which kind of venue this is.
 */
const CIRCLE_ROW_SPREAD_LIMIT = 0.15;

/**
 * A block's rake axis: the direction its rows recede in, or null when its rows do
 * not share one.
 *
 * Fitted PER BLOCK, never per section. A section routinely holds several stands
 * at different angles (a bowl's six wedges), and one axis over all of them fits
 * none — that was tried and did nothing. Within a block the rows ARE parallel, so
 * the fit is well posed.
 *
 * The fit is then VERIFIED rather than trusted: a row must be narrow along the
 * axis compared with the block's whole depth, which is what "the rows lie across
 * the axis" means. Rows that run radially fail this by construction, and the
 * caller falls back rather than producing nonsense from a fit that does not hold.
 */
function fitBlockAxis(group: readonly ResolvedRow[]): { x: number; y: number } | null {
  if (group.length < 2) return null;
  const cents = group.map((r) => {
    let x = 0, y = 0;
    for (const p of r.pts) { x += p.x; y += p.y; }
    return { x: x / r.pts.length, y: y / r.pts.length };
  });
  let ox = 0, oy = 0;
  for (const c of cents) { ox += c.x; oy += c.y; }
  ox /= cents.length; oy /= cents.length;

  let sxx = 0, sxy = 0, syy = 0;
  for (const c of cents) {
    const dx = c.x - ox, dy = c.y - oy;
    sxx += dx * dx; sxy += dx * dy; syy += dy * dy;
  }
  const tr = sxx + syy;
  const det = sxx * syy - sxy * sxy;
  const lambda = tr / 2 + Math.sqrt(Math.max(0, (tr * tr) / 4 - det));
  let ax: number, ay: number;
  if (Math.abs(sxy) > 1e-12) { ax = lambda - syy; ay = sxy; }
  else if (sxx >= syy) { ax = 1; ay = 0; }
  else { ax = 0; ay = 1; }
  const len = Math.hypot(ax, ay);
  if (!(len > 1e-12)) return null;
  ax /= len; ay /= len;

  // Verify: how wide is a row along the axis, against the block's total range?
  let lo = Infinity, hi = -Infinity;
  const widths: number[] = [];
  for (const r of group) {
    let rlo = Infinity, rhi = -Infinity;
    for (const p of r.pts) {
      const t = p.x * ax + p.y * ay;
      if (t < rlo) rlo = t;
      if (t > rhi) rhi = t;
      if (t < lo) lo = t;
      if (t > hi) hi = t;
    }
    widths.push(rhi - rlo);
  }
  const range = hi - lo;
  if (!(range > 1e-9)) return null;
  widths.sort((a, b) => a - b);
  // The 90th percentile, not the median. "The rows lie across this axis" has to
  // hold for nearly ALL of them; a median passes a block that is half wrong. The
  // amphitheatre orchestra is exactly that case: its four wedges merge into one
  // block (their radial rows converge near the focal and genuinely touch), so
  // rows in two of the wedges lie across any fitted axis and rows in the other
  // two run along it. The median was narrow, the fit was accepted, and depth
  // accumulated to 1,716 units — a 9.81 m rise on a tier authored at 0 m, with
  // the terrace above it at 2.20 m. One outlying tail is tolerated; half a block
  // is not.
  const p90 = widths[Math.min(widths.length - 1, Math.floor(widths.length * 0.9))];
  return p90 / range <= AXIS_ROW_WIDTH_LIMIT ? { x: ax, y: ay } : null;
}

/**
 * Largest share of a block's total depth that a single row may span along the
 * fitted axis before the fit is rejected.
 *
 * A row lying across the axis spans almost nothing along it, so real stands sit
 * far below this. A radially-running row spans nearly the whole range and is
 * rejected. 0.35 sits clear of both.
 */
const AXIS_ROW_WIDTH_LIMIT = 0.35;

/**
 * Resolve one section's seats into blocks and depth-ordered rows.
 *
 * `seatIndices` are indices into the caller's own seat array, so a caller can
 * attribute the result back without this module knowing what it is attributing to.
 */
export function resolveSection(
  sectionId: string,
  seats: readonly ExpandedSeat[],
  seatIndices: readonly number[],
  focal: Point,
): ResolvedSection {
  // --- Group by authored row -------------------------------------------------
  const groups = new Map<string, { pts: Point[]; idx: number[] }>();
  for (const i of seatIndices) {
    const s = seats[i];
    // A seat with no row is its own group: it can never drag a real row's shape,
    // and it still gets a deck under it downstream.
    const key = s.rowId || `__seat-${i}`;
    let g = groups.get(key);
    if (!g) { g = { pts: [], idx: [] }; groups.set(key, g); }
    g.pts.push({ x: s.x, y: s.y });
    g.idx.push(i);
  }
  if (!groups.size) return { sectionId, rows: [], blockCount: 0 };

  const rows: ResolvedRow[] = [];
  for (const [id, g] of groups) {
    const ordered = orderAlongRow(g.pts, g.idx);
    let sum = 0;
    for (const p of ordered.pts) sum += Math.hypot(p.x - focal.x, p.y - focal.y);
    rows.push({
      id,
      pts: ordered.pts,
      seatIndices: ordered.seatIndices,
      blockId: -1,
      ordinal: 0,
      blockDepth: 0,
      focalDistance: sum / ordered.pts.length,
    });
  }

  // --- Typical row spacing, to scale the block-link threshold -----------------
  // The median nearest-row gap: robust to a section holding one isolated row, and
  // to blocks whose internal spacing differs from each other's.
  const bounds = rows.map((r) => boundOf(r.pts));
  const nearest: number[] = [];
  for (let i = 0; i < rows.length; i++) {
    let best = Infinity;
    for (let j = 0; j < rows.length; j++) {
      if (i === j) continue;
      // Prune before the exact test; the bound can only understate the gap.
      if (boundGap(bounds[i], bounds[j]) >= best) continue;
      const d = rowGap(rows[i].pts, rows[j].pts);
      if (d < best) best = d;
    }
    if (Number.isFinite(best)) nearest.push(best);
  }
  nearest.sort((a, b) => a - b);
  const typicalGap = nearest.length ? nearest[Math.floor(nearest.length / 2)] : 1;
  const linkDistance = Math.max(typicalGap * BLOCK_LINK_RATIO, 1e-6);

  // --- Blocks: connected components of "close enough to be the same stand" ----
  const adjacency: number[][] = rows.map(() => []);
  for (let i = 0; i < rows.length; i++) {
    for (let j = i + 1; j < rows.length; j++) {
      if (boundGap(bounds[i], bounds[j]) > linkDistance) continue;
      if (rowGap(rows[i].pts, rows[j].pts) <= linkDistance) {
        adjacency[i].push(j);
        adjacency[j].push(i);
      }
    }
  }
  let blockCount = 0;
  for (let i = 0; i < rows.length; i++) {
    if (rows[i].blockId !== -1) continue;
    const id = blockCount++;
    const stack = [i];
    rows[i].blockId = id;
    while (stack.length) {
      const k = stack.pop()!;
      for (const n of adjacency[k]) {
        if (rows[n].blockId !== -1) continue;
        rows[n].blockId = id;
        stack.push(n);
      }
    }
  }

  // --- Depth within each block, along that block's own rake axis --------------
  const byBlock = new Map<number, ResolvedRow[]>();
  for (const r of rows) {
    const a = byBlock.get(r.blockId) ?? [];
    a.push(r);
    byBlock.set(r.blockId, a);
  }
  // --- Concentric model first: is this section a set of arcs about one centre? --
  //
  // Tried before the per-block axis because it is the stronger statement. When it
  // holds, depth is a single scalar (radius) shared by EVERY block, so the wedges
  // of a tier are level with each other by construction rather than by each
  // block happening to resolve the same way. That is what a real tier is.
  // Fit PER ROW and take the median centre, rather than one circle through every
  // seat. A single algebraic fit over points lying on many concentric rings is
  // biased toward the middle ring — measured, it put the amphitheatre orchestra's
  // centre at y = -265 when the chart struck those arcs about y = -520, which
  // made true arcs look 27 % radially spread and got the concentric model
  // rejected. One row is a single arc, so its own fit is well conditioned, and
  // the median across rows is immune to the few rows that are short or straight.
  const centres: Point[] = [];
  for (const r of rows) {
    if (r.pts.length < 4) continue;
    const c = fitCircle(r.pts);
    if (!c) continue;
    if (!Number.isFinite(c.cx) || !Number.isFinite(c.cy)) continue;
    centres.push({ x: c.cx, y: c.cy });
  }
  const centre = centres.length >= 2
    ? ((): { cx: number; cy: number } => {
      const xs = centres.map((c) => c.x).sort((a, b) => a - b);
      const ys = centres.map((c) => c.y).sort((a, b) => a - b);
      const mid = Math.floor(centres.length / 2);
      return { cx: xs[mid], cy: ys[mid] };
    })()
    : null;
  if (centre) {
    const radiusOf = (p: Point): number => Math.hypot(p.x - centre.cx, p.y - centre.cy);
    let lo = Infinity, hi = -Infinity;
    const spreads: number[] = [];
    for (const r of rows) {
      let rlo = Infinity, rhi = -Infinity;
      for (const p of r.pts) {
        const d = radiusOf(p);
        if (d < rlo) rlo = d;
        if (d > rhi) rhi = d;
      }
      spreads.push(rhi - rlo);
      if (rlo < lo) lo = rlo;
      if (rhi > hi) hi = rhi;
    }
    const range = hi - lo;
    spreads.sort((a, b) => a - b);
    const p90 = spreads[Math.min(spreads.length - 1, Math.floor(spreads.length * 0.9))];
    if (range > 1e-9 && p90 / range <= CIRCLE_ROW_SPREAD_LIMIT) {
      const withRadius = rows.map((r) => {
        let sum = 0;
        for (const p of r.pts) sum += radiusOf(p);
        return { row: r, radius: sum / r.pts.length };
      });
      let minR = Infinity;
      for (const w of withRadius) if (w.radius < minR) minR = w.radius;
      withRadius.sort((a, b) => a.radius - b.radius);
      // Rows at the same radius are the SAME row split by an aisle, so they share
      // an ordinal and a level regardless of which block they landed in.
      let ordinal = -1, lastRadius = -Infinity;
      const tolerance = range / Math.max(1, withRadius.length) * 0.5;
      const ordered: ResolvedRow[] = [];
      for (const w of withRadius) {
        if (w.radius - lastRadius > tolerance) { ordinal++; lastRadius = w.radius; }
        w.row.ordinal = ordinal;
        w.row.blockDepth = w.radius - minR;
        ordered.push(w.row);
      }
      return { sectionId, rows: ordered, blockCount };
    }
  }

  const out: ResolvedRow[] = [];
  for (const [, group] of byBlock) {
    const axis = fitBlockAxis(group);
    if (axis) {
      // Rows are parallel and across the axis: order and measure along it. Depth
      // accumulates the REAL gap between consecutive rows, so an aisle break
      // inside a stand rises across it rather than being flattened to one step.
      const key = (r: ResolvedRow): number => {
        let sum = 0;
        for (const p of r.pts) sum += p.x * axis.x + p.y * axis.y;
        return sum / r.pts.length;
      };
      group.sort((a, b) => key(a) - key(b));
      let depth = 0;
      for (let i = 0; i < group.length; i++) {
        if (i > 0) depth += rowGap(group[i - 1].pts, group[i].pts);
        group[i].ordinal = i;
        group[i].blockDepth = depth;
        out.push(group[i]);
      }
    } else {
      // No usable axis — this block's rows are not across a common direction.
      // The amphitheatre orchestra is the real case: its rows run RADIALLY, each
      // spanning radius 6 to 310, so no ordering of them is a front-to-back
      // ordering. Sorting by focal distance and accumulating gaps ran the depth
      // to 8,585 units (197 m) and pinned the tier against its runaway clamp.
      //
      // Fall back to depth measured straight from the focal, relative to this
      // block's own front. It is the pre-block model, which handled this shape
      // correctly, and confining it to the block keeps the property that every
      // block of a tier starts at the tier's authored height.
      let front = Infinity;
      for (const r of group) if (r.focalDistance < front) front = r.focalDistance;
      group.sort((a, b) => a.focalDistance - b.focalDistance);
      for (let i = 0; i < group.length; i++) {
        group[i].ordinal = i;
        group[i].blockDepth = Math.max(0, group[i].focalDistance - front);
        out.push(group[i]);
      }
    }
  }
  return { sectionId, rows: out, blockCount };
}

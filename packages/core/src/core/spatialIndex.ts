/**
 * Pure-TypeScript spatial index for seat hit-testing.
 *
 * WHY THIS EXISTS
 * ---------------
 * `src/engine/SeatmapRenderer.ts` currently leans on Konva's built-in hit graph
 * (the `listening` property, ~58 call sites) for "which seat did the pointer
 * land on". No other renderer we care about ships an equivalent: React Native
 * Skia has nothing at all, and Flutter / SwiftUI / Compose canvases all expect
 * the app to own hit-testing. So the index has to exist on every path — and on
 * the web it additionally lets us drop Konva's hit graph, which is a real win at
 * 5k–13k seats (no per-seat hit-canvas rasterisation, no hit-graph traversal).
 *
 * This module is deliberately DEPENDENCY-FREE: no DOM, no Konva, no browser
 * globals. It runs unchanged in a Web Worker, in workerd, and under React
 * Native. All coordinates are WORLD space — converting screen→world is the
 * caller's job, exactly as `SeatmapRenderer.screenToWorld` does today.
 *
 * STRUCTURE: uniform grid, not a quadtree
 * ---------------------------------------
 * Seats in a venue chart are close to uniformly dense by construction — they sit
 * in rows on a near-regular pitch. That is the single case a uniform grid is
 * optimal for, and it beats a quadtree on every axis that matters here:
 * O(n) build with no rebalancing, flat typed-array storage (one contiguous
 * scan per query, no pointer chasing), and O(1) expected candidates per point
 * query. A quadtree only starts to pay when density varies by orders of
 * magnitude across the extent, which a seating chart does not do. If a future
 * chart shape ever breaks that assumption, `gridStats()` exposes the occupancy
 * numbers needed to prove it before reaching for a tree.
 *
 * Each seat is inserted into EVERY cell its axis-aligned bounding box overlaps
 * (not just the cell holding its centre). That is what makes {@link hitTest}
 * examine exactly one cell: any seat whose shape contains a point also has an
 * AABB containing that point, so it is guaranteed to be registered in that
 * point's cell.
 */

import type { ExpandedSeat, Point } from './types';

/**
 * Default seat radius in world units. Mirrors `SEAT_RADIUS` in
 * `SeatmapRenderer.ts` and `DesignerController.ts` (both 9). The renderer scales
 * this by `theme.seatScale` clamped to [0.7, 1.6]; callers that do the same must
 * pass the scaled value via {@link BuildOptions.seatRadius} so the index agrees
 * with what is actually drawn.
 */
export const DEFAULT_SEAT_RADIUS = 9;

/**
 * Hit geometry for one seat. Real seats are circles; trade-show booths render as
 * rotated rounded rects whose dimensions live on the booth object in the
 * ChartDoc, not on `ExpandedSeat` — so the caller supplies them through
 * {@link BuildOptions.shapeOf} rather than this module reaching for the doc.
 */
export type SeatShape =
  | { kind: 'circle'; r: number }
  | { kind: 'rect'; width: number; height: number; rotation?: number };

export interface BuildOptions {
  /** Radius for circular seats when {@link shapeOf} is absent. Default {@link DEFAULT_SEAT_RADIUS}. */
  seatRadius?: number;
  /**
   * Per-seat hit geometry. Return `null`/`undefined` to fall back to a circle of
   * `seatRadius`. Called exactly once per seat during construction.
   */
  shapeOf?: (seat: ExpandedSeat) => SeatShape | null | undefined;
  /**
   * Upper bound on grid cells, to stop a chart with one far-flung stray object
   * from allocating a huge sparse grid. Default `max(64, 4 * seats.length)`.
   * When the natural cell size would exceed this, cells are grown until it fits.
   */
  maxCells?: number;
}

export interface QueryOptions {
  /**
   * Restrict results to seats this predicate accepts — used to reproduce the
   * renderer's `isSelectable(id) || selection.has(id)` gate. Kept as a query
   * argument rather than build state on purpose: seat statuses change on every
   * websocket tick, and the geometry does not.
   */
  filter?: (id: string, seat: ExpandedSeat) => boolean;
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface RectQueryOptions extends QueryOptions {
  /**
   * `'center'` (default) keeps a seat when its CENTRE falls inside the rect,
   * bounds inclusive. This is what `SeatmapRenderer.finishMarquee` does today,
   * so it is the default in order to be a drop-in replacement.
   *
   * `'overlap'` keeps a seat when its hit SHAPE intersects the rect at all —
   * the right mode for "which seats are on screen" viewport culling and
   * label-rendering passes, where a partially visible seat still counts.
   */
  mode?: 'center' | 'overlap';
}

interface IndexedSeat {
  seat: ExpandedSeat;
  shape: SeatShape;
  /** Half-extents of the shape's axis-aligned bounding box (rotation applied). */
  hx: number;
  hy: number;
}

export interface SeatIndex {
  readonly seats: readonly ExpandedSeat[];
  /** @internal */
  readonly entries: readonly IndexedSeat[];
  /** @internal */
  readonly minX: number;
  /** @internal */
  readonly minY: number;
  /** @internal */
  readonly cell: number;
  /** @internal */
  readonly cols: number;
  /** @internal */
  readonly rows: number;
  /** @internal Prefix-sum offsets into {@link items}; length cols*rows+1. */
  readonly cellStart: Int32Array;
  /** @internal Seat indices grouped by cell. */
  readonly items: Int32Array;
  /** @internal Per-seat visit stamps, for dedup across multi-cell scans. */
  readonly stamp: Int32Array;
  /** @internal Monotonically increasing stamp epoch. */
  epoch: number;
}

/** Axis-aligned half-extents of a shape, accounting for rotation. */
function halfExtents(shape: SeatShape): { hx: number; hy: number } {
  if (shape.kind === 'circle') return { hx: shape.r, hy: shape.r };
  const hw = shape.width / 2;
  const hh = shape.height / 2;
  const rot = shape.rotation ?? 0;
  if (!rot) return { hx: hw, hy: hh };
  const rad = (rot * Math.PI) / 180;
  const c = Math.abs(Math.cos(rad));
  const s = Math.abs(Math.sin(rad));
  return { hx: hw * c + hh * s, hy: hw * s + hh * c };
}

/** Exact containment test for one seat's hit shape. */
function shapeContains(e: IndexedSeat, px: number, py: number): boolean {
  const dx = px - e.seat.x;
  const dy = py - e.seat.y;
  if (e.shape.kind === 'circle') {
    return dx * dx + dy * dy <= e.shape.r * e.shape.r;
  }
  const rot = e.shape.rotation ?? 0;
  let lx = dx;
  let ly = dy;
  if (rot) {
    // Rotate the point INTO the rect's local frame (i.e. by -rotation).
    const rad = (-rot * Math.PI) / 180;
    const c = Math.cos(rad);
    const s = Math.sin(rad);
    lx = dx * c - dy * s;
    ly = dx * s + dy * c;
  }
  return Math.abs(lx) <= e.shape.width / 2 && Math.abs(ly) <= e.shape.height / 2;
}

/** Does a seat's hit shape intersect an axis-aligned rect? */
function shapeIntersectsRect(e: IndexedSeat, x0: number, y0: number, x1: number, y1: number): boolean {
  if (e.shape.kind === 'circle') {
    // Closest point on the rect to the circle centre.
    const cx = Math.min(Math.max(e.seat.x, x0), x1);
    const cy = Math.min(Math.max(e.seat.y, y0), y1);
    const dx = e.seat.x - cx;
    const dy = e.seat.y - cy;
    return dx * dx + dy * dy <= e.shape.r * e.shape.r;
  }
  // Rects: separating-axis test over the 4 candidate axes (2 per box). For the
  // unrotated case this degenerates to a plain AABB overlap.
  const rot = e.shape.rotation ?? 0;
  if (!rot) {
    return (
      e.seat.x - e.hx <= x1 && e.seat.x + e.hx >= x0 && e.seat.y - e.hy <= y1 && e.seat.y + e.hy >= y0
    );
  }
  const rad = (rot * Math.PI) / 180;
  const c = Math.cos(rad);
  const s = Math.sin(rad);
  const hw = e.shape.width / 2;
  const hh = e.shape.height / 2;
  // Rect corners in world space.
  const corners: Array<[number, number]> = [
    [-hw, -hh],
    [hw, -hh],
    [hw, hh],
    [-hw, hh],
  ].map(([lx, ly]) => [e.seat.x + lx * c - ly * s, e.seat.y + lx * s + ly * c] as [number, number]);
  const query: Array<[number, number]> = [
    [x0, y0],
    [x1, y0],
    [x1, y1],
    [x0, y1],
  ];
  const axes: Array<[number, number]> = [
    [1, 0],
    [0, 1],
    [c, s],
    [-s, c],
  ];
  for (const [ax, ay] of axes) {
    let minA = Infinity;
    let maxA = -Infinity;
    for (const [px, py] of corners) {
      const d = px * ax + py * ay;
      if (d < minA) minA = d;
      if (d > maxA) maxA = d;
    }
    let minB = Infinity;
    let maxB = -Infinity;
    for (const [px, py] of query) {
      const d = px * ax + py * ay;
      if (d < minB) minB = d;
      if (d > maxB) maxB = d;
    }
    if (maxA < minB || maxB < minA) return false;
  }
  return true;
}

/**
 * Build a uniform-grid index over `seats`. O(n) in time and memory.
 *
 * CELL SIZE
 * ---------
 * The nominal cell is `4 × maxHalfExtent`, i.e. twice the largest seat's
 * bounding-box width. Two properties fall out of that choice:
 *
 *  - A seat's AABB is at most half a cell across, so it lands in at most 2×2 = 4
 *    cells. Build stays O(n) with a small constant, and the index does not blow
 *    up in memory from duplicated references.
 *  - For the default 9px seat radius the cell is 36 world units, versus a real
 *    row/seat pitch of roughly 20–26. That works out to ~1–2 seats per occupied
 *    cell, so a point query examines about one or two candidates. Halving the
 *    cell would quadruple cell count to shave a fraction of a candidate;
 *    doubling it would put ~6 seats in every cell. 4× the half-extent is the
 *    flat part of that curve.
 *
 * The one pathological input is a chart whose bounds are enormous relative to
 * its seat count — a single stray object parked far from the venue. `maxCells`
 * caps the grid and grows the cell size until it fits, trading query sharpness
 * for bounded memory. Real charts never hit it.
 */
export function buildSeatIndex(seats: readonly ExpandedSeat[], opts: BuildOptions = {}): SeatIndex {
  const seatRadius = opts.seatRadius ?? DEFAULT_SEAT_RADIUS;
  const n = seats.length;
  const entries: IndexedSeat[] = new Array(n);

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let maxHalf = 0;

  for (let i = 0; i < n; i++) {
    const seat = seats[i];
    const shape = opts.shapeOf?.(seat) ?? { kind: 'circle' as const, r: seatRadius };
    const { hx, hy } = halfExtents(shape);
    entries[i] = { seat, shape, hx, hy };
    if (seat.x - hx < minX) minX = seat.x - hx;
    if (seat.y - hy < minY) minY = seat.y - hy;
    if (seat.x + hx > maxX) maxX = seat.x + hx;
    if (seat.y + hy > maxY) maxY = seat.y + hy;
    if (hx > maxHalf) maxHalf = hx;
    if (hy > maxHalf) maxHalf = hy;
  }

  if (n === 0) {
    minX = 0;
    minY = 0;
    maxX = 0;
    maxY = 0;
  }

  // Guard degenerate inputs: zero-extent shapes, or every seat stacked on one
  // point. A cell size of 0 would make the coordinate maths produce NaN.
  const nominal = maxHalf > 0 ? maxHalf * 4 : 1;
  const spanX = Math.max(maxX - minX, 0);
  const spanY = Math.max(maxY - minY, 0);
  const maxCells = Math.max(64, opts.maxCells ?? n * 4);

  let cell = nominal;
  let cols = Math.max(1, Math.ceil(spanX / cell) || 1);
  let rows = Math.max(1, Math.ceil(spanY / cell) || 1);
  // Grow the cell until the grid fits the budget. Each doubling quarters the
  // cell count, so this converges in a handful of iterations even for absurd
  // spans, and cannot loop forever once cols and rows both reach 1.
  while (cols * rows > maxCells && (cols > 1 || rows > 1)) {
    cell *= 2;
    cols = Math.max(1, Math.ceil(spanX / cell) || 1);
    rows = Math.max(1, Math.ceil(spanY / cell) || 1);
  }

  const cellCount = cols * rows;
  const cellStart = new Int32Array(cellCount + 1);

  // Pass 1 — count how many cells each seat's AABB touches.
  let total = 0;
  for (let i = 0; i < n; i++) {
    const e = entries[i];
    const cx0 = clampInt(Math.floor((e.seat.x - e.hx - minX) / cell), 0, cols - 1);
    const cx1 = clampInt(Math.floor((e.seat.x + e.hx - minX) / cell), 0, cols - 1);
    const cy0 = clampInt(Math.floor((e.seat.y - e.hy - minY) / cell), 0, rows - 1);
    const cy1 = clampInt(Math.floor((e.seat.y + e.hy - minY) / cell), 0, rows - 1);
    for (let cy = cy0; cy <= cy1; cy++) {
      for (let cx = cx0; cx <= cx1; cx++) {
        cellStart[cy * cols + cx + 1]++;
        total++;
      }
    }
  }

  // Prefix sum → per-cell start offsets.
  for (let c = 0; c < cellCount; c++) cellStart[c + 1] += cellStart[c];

  // Pass 2 — scatter seat indices into their cells.
  const items = new Int32Array(total);
  const cursor = cellStart.slice(0, cellCount);
  for (let i = 0; i < n; i++) {
    const e = entries[i];
    const cx0 = clampInt(Math.floor((e.seat.x - e.hx - minX) / cell), 0, cols - 1);
    const cx1 = clampInt(Math.floor((e.seat.x + e.hx - minX) / cell), 0, cols - 1);
    const cy0 = clampInt(Math.floor((e.seat.y - e.hy - minY) / cell), 0, rows - 1);
    const cy1 = clampInt(Math.floor((e.seat.y + e.hy - minY) / cell), 0, rows - 1);
    for (let cy = cy0; cy <= cy1; cy++) {
      for (let cx = cx0; cx <= cx1; cx++) {
        const c = cy * cols + cx;
        items[cursor[c]++] = i;
      }
    }
  }

  return {
    seats,
    entries,
    minX,
    minY,
    cell,
    cols,
    rows,
    cellStart,
    items,
    stamp: new Int32Array(n),
    epoch: 0,
  };
}

function clampInt(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/**
 * The seat whose hit shape contains `p`, or null.
 *
 * On overlap — seats drawn close enough that their circles intersect — the seat
 * whose CENTRE is nearest to `p` wins. That matches what a user perceives (you
 * hit the thing you aimed at) and, unlike Konva, is order-independent: Konva's
 * hit graph resolves overlap by draw order, returning the topmost/last-added
 * node regardless of how far off-centre the pointer was.
 */
export function hitTest(index: SeatIndex, p: Point, opts: QueryOptions = {}): string | null {
  const { cols, rows, cell, minX, minY, cellStart, items, entries } = index;
  const cx = Math.floor((p.x - minX) / cell);
  const cy = Math.floor((p.y - minY) / cell);
  if (cx < 0 || cy < 0 || cx >= cols || cy >= rows) return null;

  // Every seat containing p has an AABB containing p, so it is registered in
  // p's own cell — one cell is a complete candidate set.
  const c = cy * cols + cx;
  const end = cellStart[c + 1];
  let best = -1;
  let bestD = Infinity;
  for (let k = cellStart[c]; k < end; k++) {
    const i = items[k];
    const e = entries[i];
    if (opts.filter && !opts.filter(e.seat.id, e.seat)) continue;
    if (!shapeContains(e, p.x, p.y)) continue;
    const dx = p.x - e.seat.x;
    const dy = p.y - e.seat.y;
    const d = dx * dx + dy * dy;
    // Ties break toward the lower seat index so the answer never depends on
    // grid layout or cell-scan order — it matches a plain array-order scan.
    if (d < bestD || (d === bestD && i < best)) {
      bestD = d;
      best = i;
    }
  }
  return best < 0 ? null : entries[best].seat.id;
}

/**
 * Nearest seat CENTRE strictly within `radius` world units of `p`, or null.
 *
 * This is the near-miss rescue from `SeatmapRenderer.nearestSeatToScreen`,
 * lifted verbatim. The caller computes the radius the same way the renderer
 * does today:
 *
 *     const reachWorld = seatR + slopPx / stageScale;   // SEAT_TAP_SLOP_PX = 14
 *     nearestWithin(index, screenToWorld(pointer), reachWorld, { filter });
 *
 * Note the comparison is STRICTLY less-than, mirroring the renderer's
 * `bestD = reachWorld; ... if (d < bestD)` loop: a seat centre sitting exactly
 * `reachWorld` away does not qualify. Distance is measured to the seat centre,
 * not the shape edge — so for the default circle, "centre within seatR + slop"
 * is identical to "edge within slop", which is what the renderer's docstring
 * describes.
 */
export function nearestWithin(
  index: SeatIndex,
  p: Point,
  radius: number,
  opts: QueryOptions = {},
): string | null {
  if (!(radius > 0)) return null;
  const { cols, rows, cell, minX, minY, cellStart, items, entries } = index;

  const cx0 = Math.max(0, Math.floor((p.x - radius - minX) / cell));
  const cx1 = Math.min(cols - 1, Math.floor((p.x + radius - minX) / cell));
  const cy0 = Math.max(0, Math.floor((p.y - radius - minY) / cell));
  const cy1 = Math.min(rows - 1, Math.floor((p.y + radius - minY) / cell));
  if (cx0 > cx1 || cy0 > cy1) return null;

  // A seat centre within `radius` of p lies inside the box p ± radius, and a
  // seat is always registered in the cell holding its own centre — so scanning
  // the cells overlapping that box is complete.
  let best = -1;
  let bestD = radius * radius;
  const stamp = index.stamp;
  const ep = ++index.epoch;
  for (let cy = cy0; cy <= cy1; cy++) {
    const rowBase = cy * cols;
    for (let cx = cx0; cx <= cx1; cx++) {
      const c = rowBase + cx;
      const end = cellStart[c + 1];
      for (let k = cellStart[c]; k < end; k++) {
        const i = items[k];
        if (stamp[i] === ep) continue; // already considered via another cell
        stamp[i] = ep;
        const e = entries[i];
        if (opts.filter && !opts.filter(e.seat.id, e.seat)) continue;
        const dx = p.x - e.seat.x;
        const dy = p.y - e.seat.y;
        const d = dx * dx + dy * dy;
        // Lower seat index wins ties — identical to the renderer's first-wins
        // `for (const seat of this.seats)` loop.
        if (d < bestD || (d === bestD && i < best)) {
          bestD = d;
          best = i;
        }
      }
    }
  }
  return best < 0 ? null : entries[best].seat.id;
}

/**
 * Seat ids inside a world-space rect. Negative width/height are normalised, so a
 * marquee dragged up-and-left works without the caller sorting the corners.
 *
 * Default `mode: 'center'` reproduces `SeatmapRenderer.finishMarquee` exactly:
 * a seat is kept when its centre is within the rect, bounds INCLUSIVE. Use
 * `mode: 'overlap'` for viewport culling, where a seat straddling the edge
 * should still be drawn.
 *
 * Results come back in ascending seat-array order, so the output is stable
 * across calls regardless of grid layout.
 */
export function queryRect(index: SeatIndex, rect: Rect, opts: RectQueryOptions = {}): string[] {
  const x0 = Math.min(rect.x, rect.x + rect.width);
  const x1 = Math.max(rect.x, rect.x + rect.width);
  const y0 = Math.min(rect.y, rect.y + rect.height);
  const y1 = Math.max(rect.y, rect.y + rect.height);
  const mode = opts.mode ?? 'center';

  const { cols, rows, cell, minX, minY, cellStart, items, entries } = index;
  const cx0 = Math.max(0, Math.floor((x0 - minX) / cell));
  const cx1 = Math.min(cols - 1, Math.floor((x1 - minX) / cell));
  const cy0 = Math.max(0, Math.floor((y0 - minY) / cell));
  const cy1 = Math.min(rows - 1, Math.floor((y1 - minY) / cell));
  if (cx0 > cx1 || cy0 > cy1) return [];

  const found: number[] = [];
  const stamp = index.stamp;
  const ep = ++index.epoch;
  for (let cy = cy0; cy <= cy1; cy++) {
    const rowBase = cy * cols;
    for (let cx = cx0; cx <= cx1; cx++) {
      const c = rowBase + cx;
      const end = cellStart[c + 1];
      for (let k = cellStart[c]; k < end; k++) {
        const i = items[k];
        if (stamp[i] === ep) continue; // seat spans several cells
        stamp[i] = ep;
        const e = entries[i];
        if (opts.filter && !opts.filter(e.seat.id, e.seat)) continue;
        const ok =
          mode === 'center'
            ? e.seat.x >= x0 && e.seat.x <= x1 && e.seat.y >= y0 && e.seat.y <= y1
            : shapeIntersectsRect(e, x0, y0, x1, y1);
        if (ok) found.push(i);
      }
    }
  }
  found.sort((a, b) => a - b);
  return found.map((i) => entries[i].seat.id);
}

/**
 * Occupancy stats for the built grid. Diagnostic only — this is the evidence to
 * check before anyone argues the uniform grid has stopped being good enough and
 * a tree is warranted.
 */
export function gridStats(index: SeatIndex): {
  cell: number;
  cols: number;
  rows: number;
  cells: number;
  occupiedCells: number;
  refs: number;
  maxPerCell: number;
  meanPerOccupiedCell: number;
} {
  const cells = index.cols * index.rows;
  let occupied = 0;
  let maxPerCell = 0;
  for (let c = 0; c < cells; c++) {
    const len = index.cellStart[c + 1] - index.cellStart[c];
    if (len > 0) occupied++;
    if (len > maxPerCell) maxPerCell = len;
  }
  const refs = index.items.length;
  return {
    cell: index.cell,
    cols: index.cols,
    rows: index.rows,
    cells,
    occupiedCells: occupied,
    refs,
    maxPerCell,
    meanPerOccupiedCell: occupied ? refs / occupied : 0,
  };
}

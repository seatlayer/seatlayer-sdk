import type { Point } from './types';

/**
 * Where a label belongs inside a polygon.
 *
 * A polygon's average-of-vertices centroid is not a label anchor. Two things
 * break it on real venue geometry:
 *
 *  - Concavity. An L-shaped concourse block, a C-shaped bowl tier, or a wedge
 *    with an aisle cut out can have its centroid land in the notch — outside
 *    the shape entirely.
 *  - Vertex density. A traced contour samples a curved outer arc with dozens of
 *    points and the two straight radial edges with two. The average is dragged
 *    onto the arc, so the label sits hard against the boundary and its pill
 *    spills into the neighbouring section.
 *
 * The right anchor is the *pole of inaccessibility*: the interior point
 * furthest from every edge — the centre of the largest circle that fits inside
 * the polygon. That is the fattest part of the shape, which is exactly where a
 * label has room. This is the Mapbox `polylabel` algorithm: subdivide the
 * bounding box into cells, keep the cell whose optimistic upper bound is best,
 * and stop once no cell can beat the incumbent by more than `precision`.
 *
 * The returned `radius` is as useful as the point: it is the half-width of the
 * room available, so a caller can shrink a label to fit — or decide it never
 * will — without measuring glyphs.
 */
export interface InscribedAnchor {
  /** Interior point furthest from every ring (outer boundary and holes). */
  point: Point;
  /** Distance from `point` to the nearest edge — the inscribed circle radius. */
  radius: number;
}

/** Cells are explored best-first; a hand-rolled binary heap keeps that cheap. */
interface Cell {
  x: number;
  y: number;
  /** Half the cell's side. */
  h: number;
  /** Signed distance from the cell centre to the polygon (positive = inside). */
  d: number;
  /** Upper bound on the distance anywhere in this cell. */
  max: number;
}

/**
 * Hard cap on explored cells. Precision alone bounds the work for a normal
 * shape, but a pathological ring (thousands of traced vertices, near-zero
 * area) could otherwise churn. A big venue runs this once per section per
 * rebuild, so the cap is what keeps a 53k-seat chart's rebuild honest.
 */
const MAX_CELLS = 4000;

function distanceToSegment(p: Point, a: Point, b: Point): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const denominator = dx * dx + dy * dy;
  const t = denominator
    ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / denominator))
    : 0;
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

/** Distance from `p` to the closest edge of any ring (unsigned). */
export function distanceToRings(p: Point, rings: readonly (readonly Point[])[]): number {
  let best = Infinity;
  for (const ring of rings) {
    if (ring.length < 2) continue;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const d = distanceToSegment(p, ring[j], ring[i]);
      if (d < best) best = d;
    }
  }
  return best;
}

function inRing(p: Point, ring: readonly Point[]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i].x;
    const yi = ring[i].y;
    const xj = ring[j].x;
    const yj = ring[j].y;
    const hit = yi > p.y !== yj > p.y && p.x < ((xj - xi) * (p.y - yi)) / (yj - yi) + xi;
    if (hit) inside = !inside;
  }
  return inside;
}

/** Positive inside the outer ring and outside every hole; negative otherwise. */
function signedDistance(
  p: Point,
  outer: readonly Point[],
  holes: readonly (readonly Point[])[],
): number {
  const inside = inRing(p, outer) && !holes.some((hole) => inRing(p, hole));
  const distance = distanceToRings(p, [outer, ...holes]);
  return inside ? distance : -distance;
}

function cellAt(x: number, y: number, h: number, outer: readonly Point[], holes: readonly (readonly Point[])[]): Cell {
  const d = signedDistance({ x, y }, outer, holes);
  return { x, y, h, d, max: d + h * Math.SQRT2 };
}

/** Max-heap on `max`. Small, allocation-light, and never sorts the whole set. */
class CellQueue {
  private items: Cell[] = [];

  get size(): number {
    return this.items.length;
  }

  push(cell: Cell): void {
    const items = this.items;
    items.push(cell);
    let index = items.length - 1;
    while (index > 0) {
      const parent = (index - 1) >> 1;
      if (items[parent].max >= items[index].max) break;
      [items[parent], items[index]] = [items[index], items[parent]];
      index = parent;
    }
  }

  pop(): Cell | undefined {
    const items = this.items;
    const top = items[0];
    const last = items.pop();
    if (items.length && last) {
      items[0] = last;
      let index = 0;
      for (;;) {
        const left = index * 2 + 1;
        const right = left + 1;
        let best = index;
        if (left < items.length && items[left].max > items[best].max) best = left;
        if (right < items.length && items[right].max > items[best].max) best = right;
        if (best === index) break;
        [items[best], items[index]] = [items[index], items[best]];
        index = best;
      }
    }
    return top;
  }
}

/** Area of a ring (absolute, shoelace). */
export function polygonArea(ring: readonly Point[]): number {
  if (ring.length < 3) return 0;
  let sum = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    sum += (ring[j].x + ring[i].x) * (ring[j].y - ring[i].y);
  }
  return Math.abs(sum) / 2;
}

/** Net area of a polygon with holes — the space a section actually occupies. */
export function polygonNetArea(outer: readonly Point[], holes?: readonly (readonly Point[])[]): number {
  return Math.max(0, polygonArea(outer) - (holes ?? []).reduce((total, hole) => total + polygonArea(hole), 0));
}

/**
 * Largest-inscribed-circle anchor for a polygon (with optional holes).
 *
 * Deterministic: no randomness, no dependence on vertex order or winding, so
 * the same geometry always produces the same anchor. Callers can therefore
 * memoize on geometry alone.
 */
export function polygonInscribedAnchor(
  outer: readonly Point[],
  holes?: readonly (readonly Point[])[],
): InscribedAnchor {
  const rings = holes ?? [];
  if (!outer.length) return { point: { x: 0, y: 0 }, radius: 0 };
  if (outer.length < 3) {
    const x = outer.reduce((total, p) => total + p.x, 0) / outer.length;
    const y = outer.reduce((total, p) => total + p.y, 0) / outer.length;
    return { point: { x, y }, radius: 0 };
  }
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of outer) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  const width = maxX - minX;
  const height = maxY - minY;
  const cellSize = Math.min(width, height);
  if (!(cellSize > 0)) {
    return { point: { x: (minX + maxX) / 2, y: (minY + maxY) / 2 }, radius: 0 };
  }
  // Relative precision: a metre-scale room and a stadium both get ~the same
  // number of refinement steps, so cost does not depend on the unit system.
  // 1/150 of the long edge is well inside the sub-pixel band a label anchor can
  // express, and each extra digit of precision costs a full 4-way subdivision
  // level — measured over 300 dense traced shells, 1/500 cost 470 ms per
  // rebuild against 1/150's 163 ms, for an anchor no human could tell apart
  // (both stay within 5% of an exhaustive grid search's inscribed radius).
  const precision = Math.max(width, height) / 150;

  const queue = new CellQueue();
  let h = cellSize / 2;
  for (let x = minX; x < maxX; x += cellSize) {
    for (let y = minY; y < maxY; y += cellSize) {
      queue.push(cellAt(x + h, y + h, h, outer, rings));
    }
  }

  // Seed with the bbox centre; a convex-ish shape often stops right here.
  let best = cellAt(minX + width / 2, minY + height / 2, 0, outer, rings);
  let explored = 0;
  while (queue.size) {
    const cell = queue.pop();
    if (!cell) break;
    if (cell.d > best.d) best = cell;
    if (cell.max - best.d <= precision) continue;
    if (explored >= MAX_CELLS) continue;
    explored += 1;
    h = cell.h / 2;
    queue.push(cellAt(cell.x - h, cell.y - h, h, outer, rings));
    queue.push(cellAt(cell.x + h, cell.y - h, h, outer, rings));
    queue.push(cellAt(cell.x - h, cell.y + h, h, outer, rings));
    queue.push(cellAt(cell.x + h, cell.y + h, h, outer, rings));
  }
  return { point: { x: best.x, y: best.y }, radius: Math.max(0, best.d) };
}

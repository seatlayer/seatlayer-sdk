/**
 * Pure geometry primitives for the view3d scene — no OGL, no DOM, so the whole
 * scene-model builder is unit-testable in a plain runtime.
 *
 * Coordinate convention: chart units (x, y) map to world metres as
 *   worldX = x * METRES_PER_CHART_UNIT
 *   worldZ = y * METRES_PER_CHART_UNIT
 *   worldY = up (height in metres)
 * i.e. the chart's audience-depth (+y) becomes world +Z, and Y is the vertical.
 */

import earcut from 'earcut';
import polygonClipping from 'polygon-clipping';
import type { Point } from '../../core/types';
import { CHART_UNITS_PER_METRE, METRES_PER_CHART_UNIT } from '../../core/units';
import type { RGB } from '../palette';

export const M = METRES_PER_CHART_UNIT;

export interface MeshData {
  /** Non-indexed triangle soup: 3 floats per vertex. */
  position: Float32Array;
  normal: Float32Array;
  /** Baked vertex colour incl. AO, 3 floats per vertex. */
  color: Float32Array;
  /**
   * Owning floor index per vertex.
   *
   * Lets one merged mesh be dimmed per floor without splitting it into a draw
   * call per floor. A multi-floor chart (the opera house has three) draws every
   * floor at once, so the balcony sits over the parterre and hides it; isolating
   * one is the only way to look at the level you are actually booking.
   */
  floor: Float32Array;
  /** Vertex count (position.length / 3). */
  count: number;
}

/**
 * Thinnest triangle the mesh will accept, world metres.
 *
 * Measured as the shortest altitude. Every path that triangulates a polygon can
 * emit degenerate slivers from inputs that are geometrically valid: earcut fans
 * near-collinear runs, and a boolean union of overlapping shapes leaves
 * zero-width SLITS where two boundaries nearly coincide — measured at 9.74 m long
 * and 0.5 mm wide when the block footprints were introduced, with aspect ratios
 * to 4.6 million. Such a triangle has a numerically meaningless face normal and
 * flat-shades as a dark hairline across the surface.
 *
 * Cleaning each producer separately does not work: the slit's vertices are far
 * apart, so point-merging and Douglas-Peucker both legitimately keep them. A
 * guard at the point of emission catches every producer at once, and dropping a
 * 2 mm-wide triangle cannot open a visible hole — it is sub-pixel at any view
 * that could ever show it.
 */
const MIN_TRI_ALTITUDE_M = 0.002;

/** True when a triangle is too thin to contribute anything but shading noise. */
function isDegenerate(
  p0: readonly [number, number, number],
  p1: readonly [number, number, number],
  p2: readonly [number, number, number],
): boolean {
  const e0 = Math.hypot(p1[0] - p0[0], p1[1] - p0[1], p1[2] - p0[2]);
  const e1 = Math.hypot(p2[0] - p1[0], p2[1] - p1[1], p2[2] - p1[2]);
  const e2 = Math.hypot(p0[0] - p2[0], p0[1] - p2[1], p0[2] - p2[2]);
  const longest = Math.max(e0, e1, e2);
  if (longest < 1e-9) return true;
  const s = (e0 + e1 + e2) / 2;
  const area = Math.sqrt(Math.max(0, s * (s - e0) * (s - e1) * (s - e2)));
  return (2 * area) / longest < MIN_TRI_ALTITUDE_M;
}

/** Accumulates flat-shaded, per-vertex-coloured triangles. */
/**
 * Growable Float32 buffer.
 *
 * `MeshBuilder` accumulated into plain `number[]` and converted once at the end.
 * On a 99k-seat venue that meant four arrays of ~1.2M boxed numbers each and a
 * final copy of all of them — profiled at 11 % of scene build in `build()`
 * alone, plus a share of the 8 % spent in GC. Writing straight into typed
 * storage that doubles when full removes both the boxing and the final copy.
 */
class F32Buffer {
  private buf: Float32Array;
  private len = 0;

  constructor(initial = 1 << 14) {
    this.buf = new Float32Array(initial);
  }

  push3(a: number, b: number, c: number): void {
    if (this.len + 3 > this.buf.length) this.grow(this.len + 3);
    this.buf[this.len++] = a;
    this.buf[this.len++] = b;
    this.buf[this.len++] = c;
  }

  push1(a: number): void {
    if (this.len + 1 > this.buf.length) this.grow(this.len + 1);
    this.buf[this.len++] = a;
  }

  private grow(need: number): void {
    let cap = this.buf.length * 2;
    while (cap < need) cap *= 2;
    const next = new Float32Array(cap);
    next.set(this.buf.subarray(0, this.len));
    this.buf = next;
  }

  get length(): number { return this.len; }

  /** A copy trimmed to the used length. */
  toArray(): Float32Array {
    return this.buf.slice(0, this.len);
  }
}

export class MeshBuilder {
  private pos = new F32Buffer();
  private nor = new F32Buffer();
  private col = new F32Buffer();
  private flr = new F32Buffer();
  /** Floor index stamped onto every triangle emitted from now on. */
  private currentFloor = 0;

  /** Stamp subsequent triangles as belonging to `index`. */
  setFloor(index: number): void {
    this.currentFloor = index;
  }

  /** One triangle with a shared (flat) normal and per-vertex colours. */
  tri(
    p0: readonly [number, number, number],
    p1: readonly [number, number, number],
    p2: readonly [number, number, number],
    n: readonly [number, number, number],
    c0: RGB,
    c1: RGB = c0,
    c2: RGB = c0,
  ): void {
    if (isDegenerate(p0, p1, p2)) return;
    this.pos.push3(p0[0], p0[1], p0[2]); this.pos.push3(p1[0], p1[1], p1[2]); this.pos.push3(p2[0], p2[1], p2[2]);
    this.nor.push3(n[0], n[1], n[2]); this.nor.push3(n[0], n[1], n[2]); this.nor.push3(n[0], n[1], n[2]);
    this.col.push3(c0[0], c0[1], c0[2]); this.col.push3(c1[0], c1[1], c1[2]); this.col.push3(c2[0], c2[1], c2[2]);
    this.flr.push1(this.currentFloor); this.flr.push1(this.currentFloor); this.flr.push1(this.currentFloor);
  }

  /** One triangle with independent per-vertex normals (smooth shading). */
  triN(
    p0: readonly [number, number, number],
    p1: readonly [number, number, number],
    p2: readonly [number, number, number],
    n0: readonly [number, number, number],
    n1: readonly [number, number, number],
    n2: readonly [number, number, number],
    c0: RGB,
    c1: RGB = c0,
    c2: RGB = c0,
  ): void {
    if (isDegenerate(p0, p1, p2)) return;
    this.pos.push3(p0[0], p0[1], p0[2]); this.pos.push3(p1[0], p1[1], p1[2]); this.pos.push3(p2[0], p2[1], p2[2]);
    this.nor.push3(n0[0], n0[1], n0[2]); this.nor.push3(n1[0], n1[1], n1[2]); this.nor.push3(n2[0], n2[1], n2[2]);
    this.col.push3(c0[0], c0[1], c0[2]); this.col.push3(c1[0], c1[1], c1[2]); this.col.push3(c2[0], c2[1], c2[2]);
    this.flr.push1(this.currentFloor); this.flr.push1(this.currentFloor); this.flr.push1(this.currentFloor);
  }

  get vertexCount(): number {
    return this.pos.length / 3;
  }

  build(): MeshData {
    return {
      position: this.pos.toArray(),
      normal: this.nor.toArray(),
      color: this.col.toArray(),
      floor: this.flr.toArray(),
      count: this.pos.length / 3,
    };
  }
}

/** Face normal of a triangle (right-handed). */
export function faceNormal(
  a: readonly [number, number, number],
  b: readonly [number, number, number],
  c: readonly [number, number, number],
): [number, number, number] {
  const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
  const vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
  let nx = uy * vz - uz * vy;
  let ny = uz * vx - ux * vz;
  let nz = ux * vy - uy * vx;
  const len = Math.hypot(nx, ny, nz) || 1;
  nx /= len; ny /= len; nz /= len;
  return [nx, ny, nz];
}

export interface Triangulation {
  /** Outline points followed by every hole's points, in order. */
  pts: Point[];
  /** Triangle vertex indices into `pts` (length is a multiple of 3). */
  tris: number[];
}

/** Triangulate a closed polygon with optional holes via earcut. */
export function triangulate(outline: Point[], holes?: Point[][]): Triangulation {
  const pts: Point[] = [...outline];
  const flat: number[] = [];
  for (const p of outline) flat.push(p.x, p.y);
  const holeIndices: number[] = [];
  if (holes) {
    for (const hole of holes) {
      if (hole.length < 3) continue;
      holeIndices.push(pts.length);
      for (const p of hole) {
        pts.push(p);
        flat.push(p.x, p.y);
      }
    }
  }
  const tris = earcut(flat, holeIndices.length ? holeIndices : undefined, 2);
  return { pts, tris };
}

/** Centroid of a point ring (average — good enough for wall orientation). */
export function centroid(pts: Point[]): Point {
  let x = 0, y = 0;
  for (const p of pts) { x += p.x; y += p.y; }
  const n = pts.length || 1;
  return { x: x / n, y: y / n };
}

/** Signed area of a ring (shoelace). Positive = CCW, negative = CW, ~0 = degenerate. */
export function signedArea(pts: Point[]): number {
  let a = 0;
  for (let i = 0, n = pts.length; i < n; i++) {
    const p = pts[i], q = pts[(i + 1) % n];
    a += p.x * q.y - q.x * p.y;
  }
  return a / 2;
}

/** Return the ring wound counter-clockwise (reversed copy if it was CW), so
 * CW and CCW inputs of the same polygon extrude to identical geometry. */
export function toCCW(pts: Point[]): Point[] {
  return signedArea(pts) < 0 ? [...pts].reverse() : pts;
}

/** Recursion ceiling for uniform cap subdivision (4^d triangles per seed). */
const MAX_CAP_SPLIT_DEPTH = 3;

/** Max deviation of the plane from the surface, sampled over a triangle. */
function capDeviation(a: Point, b: Point, c: Point, topY: (p: Point) => number): number {
  const ya = topY(a), yb = topY(b), yc = topY(c);
  const edge = (p: Point, q: Point, yp: number, yq: number): number =>
    Math.abs(topY({ x: (p.x + q.x) / 2, y: (p.y + q.y) / 2 }) - (yp + yq) / 2);
  const cx3 = (a.x + b.x + c.x) / 3, cy3 = (a.y + b.y + c.y) / 3;
  const yCen = (ya + yb + yc) / 3;
  let worst = Math.max(
    edge(a, b, ya, yb), edge(b, c, yb, yc), edge(c, a, yc, ya),
    Math.abs(topY({ x: cx3, y: cy3 }) - yCen),
  );
  // Mid-edge-to-centroid probes: the deviation is concave and zero at the
  // vertices, so its maximum lies in the interior and edge samples alone
  // under-report it — worst at the fold where a flat front plateau meets a rake.
  const probe = (px: number, py: number, yp: number): void => {
    const d = Math.abs(topY({ x: (px + cx3) / 2, y: (py + cy3) / 2 }) - (yp + yCen) / 2);
    if (d > worst) worst = d;
  };
  probe((a.x + b.x) / 2, (a.y + b.y) / 2, (ya + yb) / 2);
  probe((b.x + c.x) / 2, (b.y + c.y) / 2, (yb + yc) / 2);
  probe((c.x + a.x) / 2, (c.y + a.y) / 2, (yc + ya) / 2);
  return worst;
}

/** Worst deviation over a triangle uniformly subdivided `depth` times. */
function maxDevAtDepth(a: Point, b: Point, c: Point, topY: (p: Point) => number, depth: number): number {
  if (depth <= 0) return capDeviation(a, b, c, topY);
  const ab = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  const bc = { x: (b.x + c.x) / 2, y: (b.y + c.y) / 2 };
  const ca = { x: (c.x + a.x) / 2, y: (c.y + a.y) / 2 };
  return Math.max(
    maxDevAtDepth(a, ab, ca, topY, depth - 1),
    maxDevAtDepth(ab, b, bc, topY, depth - 1),
    maxDevAtDepth(ca, bc, c, topY, depth - 1),
    maxDevAtDepth(ab, bc, ca, topY, depth - 1),
  );
}

/**
 * Emit one cap triangle uniformly subdivided `depth` times (1→4 each level).
 *
 * Uniform, at a depth shared by every triangle in the section — NOT adaptive.
 * Adaptive refinement was tried first and produced visible dark hairlines across
 * the decks: two triangles sharing an edge each pick which edge to split
 * independently, so one can split a shared edge while its neighbour does not.
 * That leaves a T-junction, and the crack between them shows the background
 * through the deck. A uniform depth guarantees both sides of every shared edge
 * are subdivided identically, so the mesh stays watertight by construction.
 */
function emitCapUniform(
  builder: MeshBuilder,
  a: Point, b: Point, c: Point,
  topY: (p: Point) => number,
  colTop: RGB,
  depth: number,
  topN?: (p: Point) => [number, number, number],
): void {
  if (depth > 0) {
    const ab = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    const bc = { x: (b.x + c.x) / 2, y: (b.y + c.y) / 2 };
    const ca = { x: (c.x + a.x) / 2, y: (c.y + a.y) / 2 };
    emitCapUniform(builder, a, ab, ca, topY, colTop, depth - 1, topN);
    emitCapUniform(builder, ab, b, bc, topY, colTop, depth - 1, topN);
    emitCapUniform(builder, ca, bc, c, topY, colTop, depth - 1, topN);
    emitCapUniform(builder, ab, bc, ca, topY, colTop, depth - 1, topN);
    return;
  }
  const at: [number, number, number] = [a.x * M, topY(a), a.y * M];
  const bt: [number, number, number] = [b.x * M, topY(b), b.y * M];
  const ct: [number, number, number] = [c.x * M, topY(c), c.y * M];
  if (topN) {
    // Analytic per-vertex normals: continuous across every shared edge, so the
    // deck shades as the smooth surface it approximates rather than as facets,
    // and a degenerate triangle (whose face normal is numerically meaningless)
    // still shades identically to its neighbours.
    builder.triN(at, bt, ct, topN(a), topN(b), topN(c), colTop);
    return;
  }
  let n = faceNormal(at, bt, ct);
  if (n[1] < 0) n = [-n[0], -n[1], -n[2]]; // caps face up
  builder.tri(at, bt, ct, n, colTop);
}
/** Ceiling on inserted points per ring edge, so a pathological outline cannot
 * explode the vertex count. */
const MAX_RING_SPLIT_DEPTH = 8;

/**
 * Insert points along a ring's edges until each sub-edge's midpoint height is
 * within `maxError` of the straight interpolation between its ends.
 *
 * This is what lets the wall tops follow the same curved surface as the cap. A
 * wall's top edge is a straight line between two outline vertices; on a raked
 * tier the true surface bows away from that line, so an undensified ring leaves
 * the wall top hanging above or below the cap it is supposed to meet. Densifying
 * once, before triangulation, fixes cap boundary and wall top together — they
 * are built from the same point list.
 */
function densifyRing(ring: Point[], topY: (p: Point) => number, maxError: number): Point[] {
  if (!Number.isFinite(maxError)) return ring;
  const out: Point[] = [];
  const emit = (p: Point, q: Point, yp: number, yq: number, depth: number): void => {
    if (depth > 0) {
      const mid: Point = { x: (p.x + q.x) / 2, y: (p.y + q.y) / 2 };
      const ym = topY(mid);
      if (Math.abs(ym - (yp + yq) / 2) > maxError) {
        emit(p, mid, yp, ym, depth - 1);
        emit(mid, q, ym, yq, depth - 1);
        return;
      }
    }
    out.push(p); // q is emitted by the next edge (ring is closed)
  };
  for (let i = 0; i < ring.length; i++) {
    const p = ring[i], q = ring[(i + 1) % ring.length];
    emit(p, q, topY(p), topY(q), MAX_RING_SPLIT_DEPTH);
  }
  return out;
}

/**
 * Drop ring points that sit closer than `eps` to the previous kept point, and
 * points that are collinear with their neighbours to within `eps`.
 *
 * This is the SOURCE of the remaining slivers, and it is upstream of shading.
 * `outsetRing`'s closing union re-emits intersection points that can land within
 * nanometres of an input vertex, and `densifyRing` then splits around them; a
 * point pair 1e-7 chart units apart is a zero-area triangle to earcut, which
 * fans it against a distant vertex. Measured aspect ratios reached 8.7e6.
 *
 * Removing them cannot move the outline perceptibly — `eps` is a fraction of a
 * millimetre in world metres — but it removes the degeneracy earcut amplifies.
 * Collinear removal is the same argument: a point exactly on the segment between
 * its neighbours carries no shape, and it is what turns one clean triangle into
 * a needle plus a remainder.
 */
function dedupeRing(ring: Point[], eps: number): Point[] {
  if (ring.length < 3) return ring;
  const out: Point[] = [];
  for (const p of ring) {
    const last = out[out.length - 1];
    if (last && Math.hypot(p.x - last.x, p.y - last.y) < eps) continue;
    out.push(p);
  }
  // Close-the-loop duplicate.
  while (out.length > 2 && Math.hypot(out[0].x - out[out.length - 1].x, out[0].y - out[out.length - 1].y) < eps) {
    out.pop();
  }
  if (out.length < 3) return ring;
  // Collinear pass: drop p when its perpendicular distance to (prev,next) < eps.
  const keep: Point[] = [];
  for (let i = 0; i < out.length; i++) {
    const prev = keep.length ? keep[keep.length - 1] : out[(i - 1 + out.length) % out.length];
    const p = out[i];
    const next = out[(i + 1) % out.length];
    const ax = next.x - prev.x, ay = next.y - prev.y;
    const len = Math.hypot(ax, ay);
    if (len > eps) {
      const cross = Math.abs((p.x - prev.x) * ay - (p.y - prev.y) * ax) / len;
      if (cross < eps) continue;
    }
    keep.push(p);
  }
  return keep.length >= 3 ? keep : out;
}

/** Ring cleanup tolerance in chart units (~0.1 mm in world metres). */
const RING_EPS_U = 1e-3 * CHART_UNITS_PER_METRE * 0.1;

/**
 * Extrude a closed polygon into a prism: a (possibly sloped) top cap, a bottom
 * cap, and side walls with a baked top→bottom AO gradient.
 *
 * `topY(p)` returns the world-metre height of the top surface at chart-point `p`
 * (constant for a slab, rake-sloped for a raked tier). `bottomY` is the floor.
 *
 * `maxCapError` (metres) bounds how far the drawn cap may deviate from `topY`;
 * omit it (or pass Infinity) for a flat top, where the cap is exact by
 * construction and no subdivision is wanted.
 */
export function extrudePrism(
  builder: MeshBuilder,
  outlineIn: Point[],
  holesIn: Point[][] | undefined,
  topY: (p: Point) => number,
  bottomY: number,
  colTop: RGB,
  colWall: RGB,
  ao: { top: number; wallBottom: number; bottomCap: number },
  maxCapError: number | undefined = Infinity,
  topNormal?: (p: Point) => [number, number, number],
): void {
  // Guard degenerate/near-collinear polygons (zero visible area) — a free-hand
  // or generated outline can collapse to a sliver and would emit garbage tris.
  if (!outlineIn || outlineIn.length < 3) return;
  if (maxCapError === undefined) maxCapError = Infinity;
  if (Math.abs(signedArea(outlineIn)) < 1e-4) return;
  // Normalise winding so CW and CCW inputs produce identical geometry (the solid
  // program also disables culling, but this keeps the emitted mesh deterministic).
  // Densify the rings against the surface FIRST, so the cap boundary and the
  // wall tops are generated from one point list and cannot part company.
  const outline = dedupeRing(densifyRing(dedupeRing(toCCW(outlineIn), RING_EPS_U), topY, maxCapError), RING_EPS_U);
  const holes = holesIn?.map((h) => dedupeRing(densifyRing(dedupeRing(toCCW(h), RING_EPS_U), topY, maxCapError), RING_EPS_U))
    .filter((h) => h.length >= 3 && Math.abs(signedArea(h)) >= 1e-4);
  const { pts, tris } = triangulate(outline, holes);
  const cTop: RGB = [colTop[0] * ao.top, colTop[1] * ao.top, colTop[2] * ao.top];
  const cBot: RGB = [colTop[0] * ao.bottomCap, colTop[1] * ao.bottomCap, colTop[2] * ao.bottomCap];
  const cWallTop: RGB = [colWall[0] * ao.top, colWall[1] * ao.top, colWall[2] * ao.top];
  const cWallBot: RGB = [colWall[0] * ao.wallBottom, colWall[1] * ao.wallBottom, colWall[2] * ao.wallBottom];

  // Resolve ONE subdivision depth for the whole section: the smallest depth at
  // which every cap triangle tracks the surface within `maxCapError`. Shared by
  // all triangles so the cap stays watertight (see emitCapUniform).
  let capDepth = 0;
  if (Number.isFinite(maxCapError)) {
    for (; capDepth < MAX_CAP_SPLIT_DEPTH; capDepth++) {
      let worst = 0;
      for (let i = 0; i < tris.length; i += 3) {
        const d = maxDevAtDepth(pts[tris[i]], pts[tris[i + 1]], pts[tris[i + 2]], topY, capDepth);
        if (d > worst) worst = d;
      }
      if (worst <= maxCapError) break;
    }
  }

  // Top + bottom caps.
  for (let i = 0; i < tris.length; i += 3) {
    const a = pts[tris[i]], b = pts[tris[i + 1]], c = pts[tris[i + 2]];
    emitCapUniform(builder, a, b, c, topY, cTop, capDepth, topNormal);
    // Bottom cap (reversed winding, faces down).
    const ab: [number, number, number] = [a.x * M, bottomY, a.y * M];
    const bb: [number, number, number] = [b.x * M, bottomY, b.y * M];
    const cb: [number, number, number] = [c.x * M, bottomY, c.y * M];
    builder.tri(ab, cb, bb, [0, -1, 0], cBot);
  }

  // Side walls. Orient outline walls away from the outline centroid; hole walls
  // face into the hole (flip). Vertical walls → horizontal normals.
  // Wall tops must land on exactly the vertices the cap's boundary produced, or
  // a crack opens along the top edge. Uniform cap subdivision splits every
  // boundary edge into 2^capDepth equal parts, so split the wall rings the same
  // way and both meshes share the identical point list.
  const splitRing = (ring: Point[]): Point[] => {
    if (capDepth <= 0) return ring;
    const n = 1 << capDepth;
    const out: Point[] = [];
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i], b = ring[(i + 1) % ring.length];
      for (let k = 0; k < n; k++) {
        const t = k / n;
        out.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
      }
    }
    return out;
  };
  const oc = centroid(outline);
  const rings: Array<{ ring: Point[]; flip: boolean }> = [{ ring: splitRing(outline), flip: false }];
  if (holes) for (const h of holes) if (h.length >= 3) rings.push({ ring: splitRing(h), flip: true });

  for (const { ring, flip } of rings) {
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i];
      const b = ring[(i + 1) % ring.length];
      const dx = (b.x - a.x) * M;
      const dz = (b.y - a.y) * M;
      let nx = dz, nz = -dx;
      const nl = Math.hypot(nx, nz) || 1;
      nx /= nl; nz /= nl;
      // Orient outward from the outline centroid.
      const mx = (a.x + b.x) / 2 - oc.x;
      const mz = (a.y + b.y) / 2 - oc.y;
      let dot = nx * mx + nz * mz;
      if (flip) dot = -dot;
      if (dot < 0) { nx = -nx; nz = -nz; }
      const n: [number, number, number] = [nx, 0, nz];

      const aTop: [number, number, number] = [a.x * M, topY(a), a.y * M];
      const bTop: [number, number, number] = [b.x * M, topY(b), b.y * M];
      const aBot: [number, number, number] = [a.x * M, bottomY, a.y * M];
      const bBot: [number, number, number] = [b.x * M, bottomY, b.y * M];
      builder.tri(aTop, bTop, bBot, n, cWallTop, cWallTop, cWallBot);
      builder.tri(aTop, bBot, aBot, n, cWallTop, cWallBot, cWallBot);
    }
  }
}

/** Merge several MeshData buffers into one (single draw call). */
export function mergeMeshData(parts: MeshData[]): MeshData {
  let total = 0;
  for (const p of parts) total += p.count;
  const position = new Float32Array(total * 3);
  const normal = new Float32Array(total * 3);
  const color = new Float32Array(total * 3);
  const floor = new Float32Array(total);
  let off = 0;
  for (const p of parts) {
    position.set(p.position, off * 3);
    normal.set(p.normal, off * 3);
    color.set(p.color, off * 3);
    floor.set(p.floor, off);
    off += p.count;
  }
  return { position, normal, color, floor, count: total };
}

/**
 * Grow a ring outward by `d` chart units — a MITER offset, not a dilation.
 *
 * Seat dots have a real world radius, so a seat authored hard against its
 * section boundary overhangs the deck and appears to float in the aisle. Seats
 * are chart data and must not move, so the DECK grows to meet them.
 *
 * The first implementation was a true Minkowski dilation (union of the ring, a
 * quad per edge, a disc per vertex). It was geometrically correct and visually
 * wrong: it tripled a 30-point outline to ~90 points with clusters of
 * near-duplicates where discs meet quads, and earcut fans such clusters into
 * needle triangles — 10,787 of 23,621 slivers at up to 20,650:1, which
 * flat-shade into dark hairlines streaking across the deck. Decimating the
 * result then cut the very corners the dilation had just rounded, putting seats
 * back over the edge. Dilate-then-decimate was fighting itself.
 *
 * A miter offset emits exactly ONE point per input vertex instead: each vertex
 * moves along its angle bisector by `d / cos(half-angle)`, which lands precisely
 * on the intersection of the two offset edges. Corners stay sharp and exact, the
 * point count does not grow, so there is nothing to decimate and no sliver
 * source. Sharp spikes are bevelled at `miterLimit`, and the single union at the
 * end resolves the self-intersections a miter offset produces where a concave
 * outline folds over itself.
 *
 * Holes are deliberately left alone: eroding them needs the complement and they
 * are rare in practice. A seat authored on a hole's rim can still overhang it.
 */
export function outsetRing(ring: Point[], d: number, miterLimit = 2.5): Point[] {
  if (d <= 0 || ring.length < 3) return ring;
  const r = toCCW(ring);
  const n = r.length;
  // Outward unit normal of each edge (valid because the ring is CCW).
  const nrm: Array<{ x: number; y: number }> = [];
  for (let i = 0; i < n; i++) {
    const a = r[i], b = r[(i + 1) % n];
    const dx = b.x - a.x, dy = b.y - a.y;
    const len = Math.hypot(dx, dy) || 1;
    nrm.push({ x: dy / len, y: -dx / len });
  }
  const out: [number, number][] = [];
  for (let i = 0; i < n; i++) {
    const p = r[i];
    const nPrev = nrm[(i - 1 + n) % n];  // edge arriving at p
    const nCur = nrm[i];                 // edge leaving p
    let mx = nPrev.x + nCur.x, my = nPrev.y + nCur.y;
    const ml = Math.hypot(mx, my);
    // Bevel a spike (or a full reversal) into the two edge-offset points rather
    // than letting the miter shoot off to infinity.
    const bevel = (): void => {
      out.push([p.x + nPrev.x * d, p.y + nPrev.y * d]);
      out.push([p.x + nCur.x * d, p.y + nCur.y * d]);
    };
    if (ml < 1e-9) { bevel(); continue; }
    mx /= ml; my /= ml;
    const cosHalf = mx * nPrev.x + my * nPrev.y;
    const scale = 1 / Math.max(cosHalf, 1e-6);
    if (!Number.isFinite(scale) || scale > miterLimit) { bevel(); continue; }
    out.push([p.x + mx * d * scale, p.y + my * d * scale]);
  }
  if (out.length < 3) return ring;
  try {
    // Self-union: resolves the loops a miter offset folds into concave corners.
    const merged = polygonClipping.union([[...out, out[0]]]);
    let best: [number, number][] | null = null, bestArea = -Infinity;
    for (const poly of merged) {
      const area = Math.abs(signedArea(poly[0].map(([x, y]) => ({ x, y }))));
      if (area > bestArea) { bestArea = area; best = poly[0]; }
    }
    if (!best) return ring;
    const pts = best.map(([x, y]) => ({ x, y }));
    // union() repeats the first point to close the ring; drop the duplicate.
    if (pts.length > 1) {
      const f = pts[0], l = pts[pts.length - 1];
      if (Math.abs(f.x - l.x) < 1e-9 && Math.abs(f.y - l.y) < 1e-9) pts.pop();
    }
    return pts.length >= 3 ? pts : ring;
  } catch {
    return ring; // never let a degenerate outline break the whole scene
  }
}

/** Sample an ellipse (chart units) into a closed polygon of `seg` points. */
export function ellipsePolygon(cx: number, cy: number, rx: number, ry: number, seg = 28): Point[] {
  const out: Point[] = [];
  for (let i = 0; i < seg; i++) {
    const a = (i / seg) * Math.PI * 2;
    out.push({ x: cx + rx * Math.cos(a), y: cy + ry * Math.sin(a) });
  }
  return out;
}

/** Axis-aligned rectangle (chart units) as a closed polygon. */
export function rectPolygon(x: number, y: number, w: number, h: number): Point[] {
  return [
    { x, y },
    { x: x + w, y },
    { x: x + w, y: y + h },
    { x, y: y + h },
  ];
}

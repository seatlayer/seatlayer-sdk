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
import type { Point } from '../../core/types';
import { METRES_PER_CHART_UNIT } from '../../core/units';
import type { RGB } from '../palette';

export const M = METRES_PER_CHART_UNIT;

export interface MeshData {
  /** Non-indexed triangle soup: 3 floats per vertex. */
  position: Float32Array;
  normal: Float32Array;
  /** Baked vertex colour incl. AO, 3 floats per vertex. */
  color: Float32Array;
  /** Vertex count (position.length / 3). */
  count: number;
}

/** Accumulates flat-shaded, per-vertex-coloured triangles. */
export class MeshBuilder {
  private pos: number[] = [];
  private nor: number[] = [];
  private col: number[] = [];

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
    this.pos.push(p0[0], p0[1], p0[2], p1[0], p1[1], p1[2], p2[0], p2[1], p2[2]);
    this.nor.push(n[0], n[1], n[2], n[0], n[1], n[2], n[0], n[1], n[2]);
    this.col.push(c0[0], c0[1], c0[2], c1[0], c1[1], c1[2], c2[0], c2[1], c2[2]);
  }

  get vertexCount(): number {
    return this.pos.length / 3;
  }

  build(): MeshData {
    return {
      position: new Float32Array(this.pos),
      normal: new Float32Array(this.nor),
      color: new Float32Array(this.col),
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

/**
 * Extrude a closed polygon into a prism: a (possibly sloped) top cap, a bottom
 * cap, and side walls with a baked top→bottom AO gradient.
 *
 * `topY(p)` returns the world-metre height of the top surface at chart-point `p`
 * (constant for a slab, rake-sloped for a raked tier). `bottomY` is the floor.
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
): void {
  // Guard degenerate/near-collinear polygons (zero visible area) — a free-hand
  // or generated outline can collapse to a sliver and would emit garbage tris.
  if (!outlineIn || outlineIn.length < 3) return;
  if (Math.abs(signedArea(outlineIn)) < 1e-4) return;
  // Normalise winding so CW and CCW inputs produce identical geometry (the solid
  // program also disables culling, but this keeps the emitted mesh deterministic).
  const outline = toCCW(outlineIn);
  const holes = holesIn?.map((h) => toCCW(h)).filter((h) => h.length >= 3 && Math.abs(signedArea(h)) >= 1e-4);
  const { pts, tris } = triangulate(outline, holes);
  const cTop: RGB = [colTop[0] * ao.top, colTop[1] * ao.top, colTop[2] * ao.top];
  const cBot: RGB = [colTop[0] * ao.bottomCap, colTop[1] * ao.bottomCap, colTop[2] * ao.bottomCap];
  const cWallTop: RGB = [colWall[0] * ao.top, colWall[1] * ao.top, colWall[2] * ao.top];
  const cWallBot: RGB = [colWall[0] * ao.wallBottom, colWall[1] * ao.wallBottom, colWall[2] * ao.wallBottom];

  // Top + bottom caps.
  for (let i = 0; i < tris.length; i += 3) {
    const a = pts[tris[i]], b = pts[tris[i + 1]], c = pts[tris[i + 2]];
    const at: [number, number, number] = [a.x * M, topY(a), a.y * M];
    const bt: [number, number, number] = [b.x * M, topY(b), b.y * M];
    const ct: [number, number, number] = [c.x * M, topY(c), c.y * M];
    let n = faceNormal(at, bt, ct);
    if (n[1] < 0) n = [-n[0], -n[1], -n[2]]; // caps face up
    builder.tri(at, bt, ct, n, cTop);
    // Bottom cap (reversed winding, faces down).
    const ab: [number, number, number] = [a.x * M, bottomY, a.y * M];
    const bb: [number, number, number] = [b.x * M, bottomY, b.y * M];
    const cb: [number, number, number] = [c.x * M, bottomY, c.y * M];
    builder.tri(ab, cb, bb, [0, -1, 0], cBot);
  }

  // Side walls. Orient outline walls away from the outline centroid; hole walls
  // face into the hole (flip). Vertical walls → horizontal normals.
  const oc = centroid(outline);
  const rings: Array<{ ring: Point[]; flip: boolean }> = [{ ring: outline, flip: false }];
  if (holes) for (const h of holes) if (h.length >= 3) rings.push({ ring: h, flip: true });

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
  let off = 0;
  for (const p of parts) {
    position.set(p.position, off * 3);
    normal.set(p.normal, off * 3);
    color.set(p.color, off * 3);
    off += p.count;
  }
  return { position, normal, color, count: total };
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

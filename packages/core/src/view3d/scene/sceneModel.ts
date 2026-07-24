/**
 * The JS-side source of truth for the 3D scene — a pure, GPU-free description
 * built once from the chart's existing height contract. Everything the renderer
 * uploads (merged solid geometry, the instanced seat cloud, camera-framing
 * bounds, the seat-state colour LUT) is derived here, so it survives a WebGL
 * context loss: on `webglcontextrestored` the renderer simply re-uploads from
 * this model without recomputing anything.
 *
 * Feeds 100% from `sectionGeometry` / `Floor.baseHeightM` / `ExpandedSeat`
 * (docs/3d-program-workorder §Architecture) — no new chart data is invented.
 */

import type { ChartDoc, ChartObject, ExpandedSeat, Point, SectionObject } from '../../core/types';
import { sectionGeometry } from '../../core/units';
import { seatStateColorLUT, STRUCTURE, hexToRgb, mix, desaturate, scaleRgb, type RGB } from '../palette';
import {
  MeshBuilder, extrudePrism, mergeMeshData, ellipsePolygon, rectPolygon, M, type MeshData,
} from './geometry';
import { buildSeatInstances, type SeatInstanceData } from './seatInstances';

/** One resolved plane of geometry — a single-floor chart is one of these. */
interface FloorUnit {
  objects: ChartObject[];
  focal: Point;
  baseHeightM: number;
}

export interface SceneModel {
  /** Every non-seat surface merged into one triangle soup (1 draw call). */
  solids: MeshData;
  seats: SeatInstanceData;
  bounds: {
    /** World-metre venue centre (camera target). */
    center: [number, number, number];
    /** Half-diagonal of the horizontal footprint, metres (camera fit). */
    radius: number;
    groundY: number;
  };
  /** 5 × vec3 flat LUT for the seat fragment shader. */
  stateColorLUT: number[];
  seatCount: number;
  /** Venue focal point in world metres (cinematic look-at target). */
  focalWorld: [number, number, number];
}

function floorUnits(doc: ChartDoc): FloorUnit[] {
  if (doc.floors?.length) {
    return doc.floors.map((f) => ({
      objects: f.objects,
      focal: f.focalPoint ?? doc.focalPoint,
      baseHeightM: f.baseHeightM ?? 0,
    }));
  }
  return [{ objects: doc.objects, focal: doc.focalPoint, baseHeightM: 0 }];
}

const AO = { top: 1.0, wallBottom: 0.5, bottomCap: 0.4 };

/** Seats sit on the deck, so the deck surface is drawn this far BELOW the seat
 * dots (which lift SEAT_SURFACE_LIFT_M above the same resolved surface). Keeping
 * the deck under the dots stops the tier cap from occluding its own seats. */
const DECK_DROP_M = 0.28;
/** Hard ceiling on rake rise so a mis-authored / arc-wrapped section can never
 * produce a runaway spike (defect guard). */
const MAX_TIER_RISE_M = 25;

/**
 * Fold a surface's 2D fill colour into the dark structure palette: desaturate
 * ~40 %, darken, then ground it in the neutral structure grey so a tier top
 * reads architectural — a recognisable hue (purple/green/orange) but muted, not
 * candy-coloured paint. Risers/walls stay neutral concrete; baked AO still
 * multiplies these per vertex downstream. `null` fill ⇒ the neutral grey.
 */
function tintTop(fill: RGB | null, neutral: RGB): RGB {
  if (!fill) return neutral;
  const muted = scaleRgb(desaturate(fill, 0.4), 0.62);
  return mix(neutral, muted, 0.72);
}

/**
 * Resolve each section's 2D paint colour, keyed by logical section id
 * (`logicalSectionId ?? id`, matching how expanded seats attribute `sectionId`):
 * the count-weighted mix of its member seats' category colours — the same source
 * the 2D renderer blends into a section's block fill. An explicit `section.color`
 * override is applied later (it wins in `sectionFill`).
 */
function resolveSectionFills(doc: ChartDoc, seats: ExpandedSeat[]): Map<string, RGB> {
  const catColor = new Map<string, string>();
  for (const c of doc.categories ?? []) catColor.set(c.key, c.color);
  const counts = new Map<string, Map<string, number>>();
  for (const s of seats) {
    if (!s.sectionId) continue;
    let m = counts.get(s.sectionId);
    if (!m) { m = new Map(); counts.set(s.sectionId, m); }
    m.set(s.categoryKey, (m.get(s.categoryKey) ?? 0) + 1);
  }
  const out = new Map<string, RGB>();
  for (const [sid, byCat] of counts) {
    let r = 0, g = 0, b = 0, w = 0;
    for (const [key, n] of byCat) {
      const rgb = hexToRgb(catColor.get(key));
      if (!rgb) continue;
      r += rgb[0] * n; g += rgb[1] * n; b += rgb[2] * n; w += n;
    }
    if (w > 0) out.set(sid, [r / w, g / w, b / w]);
  }
  return out;
}

/** A section's fill: explicit `color` override wins, else the member-category mix. */
function sectionFill(section: SectionObject, byLogical: Map<string, RGB>): RGB | null {
  return hexToRgb(section.color) ?? byLogical.get(section.logicalSectionId ?? section.id) ?? null;
}

/** Extrude one section into the shared builder (rake-sloped or flat slab). */
function buildTier(builder: MeshBuilder, section: SectionObject, unit: FloorUnit, fill: RGB | null): void {
  if (!section.outline || section.outline.length < 3) return;
  const geo = sectionGeometry(section, { floorBaseHeightM: unit.baseHeightM });
  const bottomY = unit.baseHeightM;
  const rakeRad = (geo.rake * Math.PI) / 180;
  const flat = geo.rake <= 0.01 && geo.height <= bottomY + 0.001;
  const colTop = tintTop(fill, STRUCTURE.tierTop);

  if (flat) {
    // Thin slab whose top stays below the seat dots (which sit at ~lift height).
    const topY = bottomY + 0.05;
    extrudePrism(builder, section.outline, section.holes, () => topY, bottomY, colTop, STRUCTURE.tierWall, AO);
    return;
  }

  // Front edge = the section's OWN minimum focal distance (mirrors the
  // assignEyeHeights sightline model: rise grows with drawn radial depth). For
  // arc/ring sections whose outline wraps the focal point this per-vertex delta
  // is bounded by MAX_TIER_RISE_M so no vertex spikes into a fin.
  let frontDist = Infinity;
  for (const p of section.outline) {
    const d = Math.hypot(p.x - unit.focal.x, p.y - unit.focal.y);
    if (d < frontDist) frontDist = d;
  }
  const tan = Math.tan(rakeRad);
  const topY = (p: Point): number => {
    const d = Math.hypot(p.x - unit.focal.x, p.y - unit.focal.y);
    const depthM = Math.max(0, d - frontDist) * M;
    const rise = Math.min(depthM * tan, MAX_TIER_RISE_M);
    return Math.max(bottomY + 0.05, geo.height + rise - DECK_DROP_M);
  };
  extrudePrism(builder, section.outline, section.holes, topY, bottomY, colTop, STRUCTURE.tierWall, AO);
}

/** Resolve a shape object to a closed chart-unit polygon (or null to skip). */
function shapePolygon(shape: Extract<ChartObject, { type: 'shape' }>): Point[] | null {
  if (shape.kind === 'polygon' && shape.points && shape.points.length >= 3) return shape.points;
  if (shape.kind === 'rect' && shape.width && shape.height) {
    return rectPolygon(shape.x ?? 0, shape.y ?? 0, shape.width, shape.height);
  }
  if (shape.kind === 'ellipse' && shape.width && shape.height) {
    const cx = (shape.x ?? 0) + shape.width / 2;
    const cy = (shape.y ?? 0) + shape.height / 2;
    return ellipsePolygon(cx, cy, shape.width / 2, shape.height / 2);
  }
  return null; // line / polyline are stroke-only
}

function buildShape(builder: MeshBuilder, shape: Extract<ChartObject, { type: 'shape' }>, base: number): void {
  const poly = shapePolygon(shape);
  if (!poly) return;
  const isStage = shape.role === 'stage';
  const height = isStage ? base + 1.0 : base + 0.25;
  const colTop = isStage ? STRUCTURE.stageTop : STRUCTURE.decorTop;
  const colWall = isStage ? STRUCTURE.stageWall : STRUCTURE.decorWall;
  extrudePrism(builder, poly, undefined, () => height, base, colTop, colWall, AO);
}

function buildGa(builder: MeshBuilder, ga: Extract<ChartObject, { type: 'gaArea' }>, base: number, fill: RGB | null): void {
  if (!ga.points || ga.points.length < 3) return;
  const colTop = tintTop(fill, STRUCTURE.gaTop);
  extrudePrism(builder, ga.points, ga.holes, () => base + 0.15, base, colTop, STRUCTURE.gaWall, AO);
}

/** Compute the horizontal chart-unit footprint over everything drawable. */
function chartFootprint(units: FloorUnit[], seats: ExpandedSeat[]): { minX: number; minY: number; maxX: number; maxY: number } {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const acc = (x: number, y: number): void => {
    if (x < minX) minX = x; if (y < minY) minY = y;
    if (x > maxX) maxX = x; if (y > maxY) maxY = y;
  };
  for (const s of seats) acc(s.x, s.y);
  for (const u of units) {
    for (const o of u.objects) {
      if (o.type === 'section') for (const p of o.outline) acc(p.x, p.y);
      else if (o.type === 'shape' && o.points) for (const p of o.points) acc(p.x, p.y);
      else if (o.type === 'gaArea') for (const p of o.points) acc(p.x, p.y);
    }
  }
  if (!Number.isFinite(minX)) { minX = -100; minY = -100; maxX = 100; maxY = 100; }
  return { minX, minY, maxX, maxY };
}

export interface SceneModelInput {
  doc: ChartDoc;
  seats: ExpandedSeat[];
  /** Optional initial per-seat state (default all available). */
  initialState?: (seat: ExpandedSeat) => import('../palette').SeatState3D;
}

export function buildSceneModel(input: SceneModelInput): SceneModel {
  const { doc, seats } = input;
  const units = floorUnits(doc);
  const builder = new MeshBuilder();

  // Ground slab sized to the footprint (+ margin), sitting at datum 0.
  const fp = chartFootprint(units, seats);
  const padU = Math.max(60, (fp.maxX - fp.minX + fp.maxY - fp.minY) * 0.06);
  const groundPoly = rectPolygon(fp.minX - padU, fp.minY - padU, (fp.maxX - fp.minX) + padU * 2, (fp.maxY - fp.minY) + padU * 2);
  extrudePrism(builder, groundPoly, undefined, () => 0, -0.4, STRUCTURE.ground, STRUCTURE.ground, AO);

  // Per-section 2D fill colours (member-category mix), carried onto tier tops.
  const sectionFills = resolveSectionFills(doc, seats);
  const catColor = new Map<string, string>();
  for (const c of doc.categories ?? []) catColor.set(c.key, c.color);

  for (const unit of units) {
    for (const o of unit.objects) {
      if (o.type === 'section') buildTier(builder, o, unit, sectionFill(o, sectionFills));
      else if (o.type === 'shape') buildShape(builder, o, unit.baseHeightM);
      else if (o.type === 'gaArea') buildGa(builder, o, unit.baseHeightM, hexToRgb(catColor.get(o.categoryKey)));
    }
  }

  const solids = mergeMeshData([builder.build()]);
  const seatData: SeatInstanceData = buildSeatInstances(seats, input.initialState);

  const cx = ((fp.minX + fp.maxX) / 2) * M;
  const cz = ((fp.minY + fp.maxY) / 2) * M;
  const radius = 0.5 * Math.hypot((fp.maxX - fp.minX) * M, (fp.maxY - fp.minY) * M) || 10;

  const focal = doc.focalPoint ?? { x: (fp.minX + fp.maxX) / 2, y: (fp.minY + fp.maxY) / 2 };

  return {
    solids,
    seats: seatData,
    bounds: { center: [cx, radius * 0.08, cz], radius, groundY: 0 },
    stateColorLUT: seatStateColorLUT(),
    seatCount: seats.length,
    // Look-at target ~1.5 m up so a seated camera aims slightly down at the stage.
    focalWorld: [focal.x * M, 1.5, focal.y * M],
  };
}

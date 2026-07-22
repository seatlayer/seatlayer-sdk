/**
 * Pure geometry helpers — no Konva, no DOM. Turns the parametric chart
 * document into concrete seat coordinates and computes bounding boxes.
 */

import type {
  AccessibilityType,
  BoothObject,
  ChartDoc,
  ChartObject,
  ExpandedSeat,
  Floor,
  LabelStyle,
  Point,
  RowObject,
  RectTableSeatCounts,
  RectTableSide,
  SeatOverride,
  SectionObject,
  TableObject,
} from './types';
import { distributeAlongCubic } from './complexGeometry';
import { translateSectionOutlinePath } from './sectionPath';
import { toLetters, toRoman } from './labeling';
import { METRES_PER_CHART_UNIT, SEATED_EYE_HEIGHT_M, sectionGeometry } from './units';

/** Resolve a seat override's accessibility, honouring the legacy boolean flag. */
function overrideAccessibility(o: SeatOverride | undefined): AccessibilityType[] {
  if (!o) return [];
  if (o.accessibility && o.accessibility.length) {
    return o.wheelchairSpaceType && !o.accessibility.includes('wheelchair')
      ? ['wheelchair', ...o.accessibility]
      : o.accessibility;
  }
  if (o.wheelchairSpaceType) return ['wheelchair'];
  return o.accessible ? ['wheelchair'] : [];
}

const DEG = Math.PI / 180;
/** Seat visual radius (mirrors the renderer) — used only for bounds padding. */
const SEAT_R = 9;
/** How far outside a table's body its seats sit. */
const TABLE_SEAT_OFFSET = 16;

/** Rotate a local point clockwise by `deg` (screen coords, +y down) then translate. */
function place(lx: number, ly: number, deg: number, origin: Point): { x: number; y: number } {
  const a = deg * DEG;
  const cos = Math.cos(a);
  const sin = Math.sin(a);
  return {
    x: origin.x + lx * cos - ly * sin,
    y: origin.y + lx * sin + ly * cos,
  };
}

/**
 * Expand a parametric row into seat positions.
 *
 * Straight (curve === 0): seat i sits at local (i·spacing, 0).
 *
 * Curved: seats lie on a circular arc. Per-seat angular step is
 * `curve/(seatCount-1)`; radius is derived so the chord between neighbours
 * equals seatSpacing → radius = spacing / (2·sin(step/2)). Seat 0 sits at the
 * bottom of the arc (local origin) with the circle centre directly above it at
 * (0,-radius); increasing index sweeps toward +x while the ends rise toward -y,
 * i.e. positive curve is concave toward -y (a row wrapping a stage above it).
 * Local points are then rotated by `rotation` and translated to `origin`.
 *
 * Numbering (labels only, never geometry): `seatNumbering.direction === 'rtl'`
 * numbers from the far physical end; `step === 2` produces odd/even numbering
 * (start at 1 → 1,3,5…; start at 2 → 2,4,6…).
 */
/** Base (pre-override) seat centre per index — shared by expandRow + designer edit mode. */
export function rowSeatPositions(row: RowObject): Point[] {
  const { seatCount, seatSpacing, curve, rotation, origin } = row;
  const out: Point[] = [];
  if (row.path) return distributeAlongCubic(row.path, seatCount);
  if (seatCount <= 1) {
    if (seatCount === 1) out.push({ x: origin.x, y: origin.y });
    return out;
  }
  if (curve === 0) {
    for (let i = 0; i < seatCount; i++) out.push(place(i * seatSpacing, 0, rotation, origin));
    return out;
  }
  const arcStep = (curve / (seatCount - 1)) * DEG; // radians per seat
  const radius = seatSpacing / (2 * Math.sin(Math.abs(arcStep) / 2));
  // Centre above seat 0. φ measured from the downward vertical, growing with index.
  for (let i = 0; i < seatCount; i++) {
    const phi = i * arcStep;
    const lx = radius * Math.sin(phi);
    const ly = -radius + radius * Math.cos(phi); // ≤ 0 → ends rise toward -y
    out.push(place(lx, ly, rotation, origin));
  }
  return out;
}

function overrideMap(row: RowObject): Map<number, SeatOverride> {
  const m = new Map<number, SeatOverride>();
  if (row.overrides) for (const o of row.overrides) m.set(o.index, o);
  return m;
}

/** Sellable row slots: skipped slots are absent; empty wheelchair bays remain. */
export function rowInventoryCount(row: RowObject): number {
  const skipped = new Set((row.overrides ?? [])
    .filter((override) => override.skip && Number.isInteger(override.index)
      && override.index >= 0 && override.index < row.seatCount)
    .map((override) => override.index));
  return Math.max(0, row.seatCount - skipped.size);
}

/**
 * Every seat slot of a row INCLUDING skipped ones (designer seat-edit mode uses
 * this to draw un-skip handles). Overrides (dx/dy/label/categoryKey) are applied
 * but a skipped slot is flagged, not omitted.
 */
export interface RowSeatSlot {
  index: number;
  x: number;
  y: number;
  label: string;
  displayLabel: string;
  categoryKey: string;
  skipped: boolean;
  accessible: boolean;
  accessibility: AccessibilityType[];
  wheelchairSpaceType?: SeatOverride['wheelchairSpaceType'];
  commercial?: RowObject['commercial'];
  viewUrl?: string;
  labelStyle?: LabelStyle;
}

/** Every authored table-chair slot, including skipped inventory. This mirrors
 * row seat slots so Designer, MCP and buyer/event expansion share one semantic
 * source while retaining the table's stable numeric slot identity. */
export interface TableSeatSlot extends RowSeatSlot {
  side?: RectTableSide;
}

/**
 * Number outward from the middle: rank seats by distance from centre (inner-left
 * wins ties), so the centre seat gets rank 0 (the lowest number). Shared by the
 * `center` direction across every scheme.
 */
function centerRank(n: number): number[] {
  const rank = new Array<number>(n);
  Array.from({ length: n }, (_, i) => i)
    .sort((a, b) => Math.abs(2 * a - (n - 1)) - Math.abs(2 * b - (n - 1)) || a - b)
    .forEach((idx, k) => (rank[idx] = k));
  return rank;
}

/**
 * The seat NUMBER part of a row seat's label (the row prefix is prepended by the
 * caller). Applies the row's numbering scheme, direction, step, start and label
 * prefix. Labels only — never geometry. See `RowObject.seatNumbering.scheme`.
 */
export function seatLabelPart(row: RowObject, i: number): string {
  const rawStart = row.seatLabelStart ?? 1;
  const dir = row.seatNumbering?.direction ?? 'ltr';
  const step = row.seatNumbering?.step ?? 1;
  const scheme = row.seatNumbering?.scheme ?? 'decimal';
  const prefix = row.seatNumbering?.prefix ?? '';
  const endAt = row.seatNumbering?.endAt;
  const n = row.seatCount;

  // Both up/down variants replace direction and number by physical left→right
  // order. `updown` is odd-up-even-back (1,3,5,…,6,4,2); the distinct reverse
  // variant is odd-back-even-up (…5,3,1,2,4,6). `start` shifts either sequence.
  // They own their sequence, so both ignore `endAt`.
  if (scheme === 'updown' || scheme === 'updown-descending') {
    const half = Math.ceil(n / 2);
    const core = scheme === 'updown'
      ? (i < half ? rawStart + 2 * i : rawStart - 1 + 2 * (n - i))
      : (i < half ? rawStart + 2 * (half - 1 - i) : rawStart + 1 + 2 * (i - half));
    return `${prefix}${core}`;
  }

  // End-at preset ("useEndAt"): derive `start` so the LAST-numbered seat
  // (position rank n-1) lands on `endAt`, honouring the scheme's effective step
  // (odd/even = 2). `endAt` wins over the stored `seatLabelStart`.
  const effStep = scheme === 'odd' || scheme === 'even' ? 2 : step;
  const start = endAt != null && Number.isFinite(endAt) ? endAt - (n - 1) * effStep : rawStart;

  // Position rank p ∈ [0, n-1]: the 0-based ordinal along the numbering
  // direction. Every remaining scheme is a formatting of `start + p*step`.
  const p = dir === 'center' ? centerRank(n)[i] : dir === 'rtl' ? n - 1 - i : i;

  let core: string;
  switch (scheme) {
    case 'odd': {
      const firstOdd = start % 2 === 1 ? start : start + 1;
      core = String(firstOdd + p * 2);
      break;
    }
    case 'even': {
      const firstEven = start % 2 === 0 ? start : start + 1;
      core = String(firstEven + p * 2);
      break;
    }
    case 'roman':
      core = toRoman(start + p * step);
      break;
    case 'letters-upper':
      core = toLetters(start + p * step, false);
      break;
    case 'letters-lower':
      core = toLetters(start + p * step, true);
      break;
    case 'decimal':
    default:
      core = String(start + p * step);
      break;
  }
  return `${prefix}${core}`;
}

export function expandRowSlots(row: RowObject): RowSeatSlot[] {
  const ov = overrideMap(row);
  return rowSeatPositions(row).map((p, i) => {
    const o = ov.get(i);
    const accessibility = overrideAccessibility(o);
    const part = seatLabelPart(row, i);
    const inventoryLabel = o?.label ?? `${row.label}-${part}`;
    const displayPrefix = row.displayLabel ?? row.label;
    const commercial = { ...row.commercial, ...o?.commercial };
    return {
      index: i,
      x: p.x + (o?.dx ?? 0),
      y: p.y + (o?.dy ?? 0),
      label: inventoryLabel,
      displayLabel: o?.displayLabel ?? `${displayPrefix}-${part}`,
      categoryKey: o?.categoryKey ?? row.categoryKey,
      skipped: !!o?.skip,
      accessible: accessibility.length > 0,
      accessibility,
      wheelchairSpaceType: o?.wheelchairSpaceType,
      commercial: Object.values(commercial).some((value) => value !== undefined && value !== false && value !== '') ? commercial : undefined,
      viewUrl: o?.viewFromSeatUrl ?? row.viewFromSeatUrl,
      labelStyle: o?.labelStyle,
    };
  });
}

export function expandRow(row: RowObject): ExpandedSeat[] {
  const seats: ExpandedSeat[] = [];
  for (const slot of expandRowSlots(row)) {
    if (slot.skipped) continue; // physical seat absent; numbering gap preserved
    seats.push({
      id: `${row.id}:${slot.index}`,
      label: slot.label,
      displayLabel: slot.displayLabel === slot.label ? undefined : slot.displayLabel,
      x: slot.x,
      y: slot.y,
      rowId: row.id,
      categoryKey: slot.categoryKey,
      accessible: slot.accessible || undefined,
      accessibility: slot.accessibility.length ? slot.accessibility : undefined,
      wheelchairSpaceType: slot.wheelchairSpaceType,
      commercial: slot.commercial,
      viewUrl: slot.viewUrl,
      labelStyle: slot.labelStyle,
    });
  }
  return seats;
}

/**
 * Expand a table into its perimeter seats.
 *
 * Round: seats spread evenly on a circle of radius `radius + 16`, the first at
 * angle `rotation` (degrees, clockwise from +x). Rect: seats line the top and
 * bottom edges (split evenly, any remainder to the top), 16u outside the edge,
 * the whole set rotated about the table centre.
 */
/** Legacy rect tables distribute aggregate capacity round-robin across enabled
 * sides, then emit chairs in canonical top/bottom/left/right order. */
export function tableSeatCountsBySide(t: TableObject): RectTableSeatCounts {
  if (t.seatCountsBySide) return { ...t.seatCountsBySide };
  const enabled = t.sides && t.sides.length ? t.sides : ['top', 'bottom'];
  const order = (['top', 'bottom', 'left', 'right'] as const).filter((side) => enabled.includes(side));
  const counts: RectTableSeatCounts = { top: 0, bottom: 0, left: 0, right: 0 };
  if (!order.length) return counts;
  const n = Math.max(0, Math.round(t.seatCount));
  for (let index = 0; index < n; index++) counts[order[index % order.length]] += 1;
  return counts;
}

/** Expand every authored table chair, including skipped slots needed by the
 * Designer to restore inventory. */
export function expandTableSlots(t: TableObject): TableSeatSlot[] {
  const seats: TableSeatSlot[] = [];
  const n = Math.max(0, Math.round(t.seatCount));
  if (n === 0) return seats;
  const overrides = new Map((t.overrides ?? []).map((override) => [override.index, override]));
  const mk = (index: number, x: number, y: number, side?: RectTableSide): TableSeatSlot => {
    const override = overrides.get(index);
    const accessibility = overrideAccessibility(override);
    const label = override?.label ?? `${t.label}-${index + 1}`;
    const displayPrefix = t.displayLabel ?? t.label;
    return {
      index,
      label,
      displayLabel: override?.displayLabel ?? `${displayPrefix}-${index + 1}`,
      x: x + (override?.dx ?? 0),
      y: y + (override?.dy ?? 0),
      categoryKey: override?.categoryKey ?? t.categoryKey,
      skipped: !!override?.skip,
      accessible: accessibility.length > 0,
      accessibility,
      wheelchairSpaceType: override?.wheelchairSpaceType,
      commercial: override?.commercial,
      viewUrl: override?.viewFromSeatUrl,
      labelStyle: override?.labelStyle,
      ...(side ? { side } : {}),
    };
  };

  if (t.shape === 'round') {
    const R = (t.radius ?? 40) + TABLE_SEAT_OFFSET;
    const base = t.rotation * DEG;
    const arc = Math.max(0, Math.min(360, t.seatArc ?? 360));
    if (arc >= 360 || n === 1) {
      for (let i = 0; i < n; i++) {
        const a = base + (i / n) * 2 * Math.PI;
        seats.push(mk(i, t.center.x + R * Math.cos(a), t.center.y + R * Math.sin(a)));
      }
      return seats;
    }
    const arcRad = arc * DEG;
    const halfGap = (2 * Math.PI - arcRad) / 2;
    const start = base + halfGap;
    for (let i = 0; i < n; i++) {
      const a = start + (i / (n - 1)) * arcRad;
      seats.push(mk(i, t.center.x + R * Math.cos(a), t.center.y + R * Math.sin(a)));
    }
    return seats;
  }

  const w = t.width ?? 80;
  const h = t.height ?? 50;
  const counts = tableSeatCountsBySide(t);
  const order = ['top', 'bottom', 'left', 'right'] as const;
  let idx = 0;
  for (const side of order) {
    const count = counts[side];
    for (let j = 0; j < count; j++) {
      let localX: number;
      let localY: number;
      if (side === 'top') {
        localX = -w / 2 + ((j + 0.5) * w) / count;
        localY = -h / 2 - TABLE_SEAT_OFFSET;
      } else if (side === 'bottom') {
        localX = -w / 2 + ((j + 0.5) * w) / count;
        localY = h / 2 + TABLE_SEAT_OFFSET;
      } else if (side === 'left') {
        localX = -w / 2 - TABLE_SEAT_OFFSET;
        localY = -h / 2 + ((j + 0.5) * h) / count;
      } else {
        localX = w / 2 + TABLE_SEAT_OFFSET;
        localY = -h / 2 + ((j + 0.5) * h) / count;
      }
      const point = place(localX, localY, t.rotation, t.center);
      seats.push(mk(idx++, point.x, point.y, side));
    }
  }
  return seats;
}

/** Sellable individual table chairs. Grouped tables own one atomic inventory
 * unit elsewhere and therefore retain their full authored chair capacity. */
export function tableInventoryCount(t: TableObject): number {
  if (t.bookAsWhole || t.variableOccupancy) return Math.max(0, Math.round(t.seatCount));
  return expandTableSlots(t).filter((slot) => !slot.skipped).length;
}

export function expandTable(t: TableObject): ExpandedSeat[] {
  return expandTableSlots(t).filter((slot) => !slot.skipped).map((slot) => ({
    id: `${t.id}:${slot.index}`,
    label: slot.label,
    ...(slot.displayLabel !== slot.label ? { displayLabel: slot.displayLabel } : {}),
    x: slot.x,
    y: slot.y,
    rowId: t.id,
    categoryKey: slot.categoryKey,
    ...(slot.accessible ? { accessible: true } : {}),
    ...(slot.accessibility.length ? { accessibility: slot.accessibility } : {}),
    ...(slot.wheelchairSpaceType ? { wheelchairSpaceType: slot.wheelchairSpaceType } : {}),
    ...(slot.commercial ? { commercial: slot.commercial } : {}),
    ...(slot.viewUrl ? { viewUrl: slot.viewUrl } : {}),
    ...(slot.labelStyle ? { labelStyle: slot.labelStyle } : {}),
  }));
}

/** Expand a booth into its single bookable block unit. */
export function expandBooth(b: BoothObject): ExpandedSeat[] {
  return [
    {
      id: `${b.id}:0`,
      label: b.label,
      ...(b.displayLabel && b.displayLabel !== b.label ? { displayLabel: b.displayLabel } : {}),
      x: b.center.x,
      y: b.center.y,
      rowId: b.id,
      categoryKey: b.categoryKey,
      kind: 'booth',
    },
  ];
}

/** Ray-cast point-in-polygon test — odd crossings ⇒ inside. */
export function pointInPolygon(p: Point, poly: Point[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i].x;
    const yi = poly[i].y;
    const xj = poly[j].x;
    const yj = poly[j].y;
    const hit = yi > p.y !== yj > p.y && p.x < ((xj - xi) * (p.y - yi)) / (yj - yi) + xi;
    if (hit) inside = !inside;
  }
  return inside;
}

function pointOnPolygonBoundary(p: Point, poly: Point[]): boolean {
  return poly.some((start, index) => {
    const end = poly[(index + 1) % poly.length];
    const cross = (p.y - start.y) * (end.x - start.x) - (p.x - start.x) * (end.y - start.y);
    if (Math.abs(cross) > 1e-7) return false;
    const dot = (p.x - start.x) * (end.x - start.x) + (p.y - start.y) * (end.y - start.y);
    const lengthSquared = (end.x - start.x) ** 2 + (end.y - start.y) ** 2;
    return dot >= -1e-7 && dot <= lengthSquared + 1e-7;
  });
}

export function pointInPolygonWithHoles(p: Point, outer: Point[], holes: Point[][] | undefined): boolean {
  return pointInPolygon(p, outer)
    && !(holes ?? []).some((hole) => pointInPolygon(p, hole) || pointOnPolygonBoundary(p, hole));
}

/** Stable interior label anchor that cannot land inside a polygon cutout. */
export function polygonLabelPoint(outer: Point[], holes: Point[][] | undefined): Point {
  if (!outer.length) return { x: 0, y: 0 };
  const xs = outer.map((point) => point.x);
  const ys = outer.map((point) => point.y);
  const bounds = { minX: Math.min(...xs), maxX: Math.max(...xs), minY: Math.min(...ys), maxY: Math.max(...ys) };
  const centroid = polygonCentroid(outer);
  if (pointInPolygonWithHoles(centroid, outer, holes)) return centroid;
  let best = outer[0];
  let bestScore = -Infinity;
  const rings = [outer, ...(holes ?? [])];
  for (let row = 1; row < 24; row += 1) {
    for (let column = 1; column < 24; column += 1) {
      const point = {
        x: bounds.minX + ((bounds.maxX - bounds.minX) * column) / 24,
        y: bounds.minY + ((bounds.maxY - bounds.minY) * row) / 24,
      };
      if (!pointInPolygonWithHoles(point, outer, holes)) continue;
      const score = Math.min(...rings.flatMap((ring) => ring.map((start, index) => {
        const end = ring[(index + 1) % ring.length];
        const dx = end.x - start.x;
        const dy = end.y - start.y;
        const denominator = dx * dx + dy * dy;
        const projection = denominator
          ? ((point.x - start.x) * dx + (point.y - start.y) * dy) / denominator
          : 0;
        const t = Math.max(0, Math.min(1, projection));
        return Math.hypot(point.x - (start.x + t * dx), point.y - (start.y + t * dy));
      })));
      if (score > bestScore) { best = point; bestScore = score; }
    }
  }
  return best;
}

/** Average of polygon vertices (v1 centroid — good enough for labels/membership). */
function polygonCentroid(pts: Point[]): Point {
  if (!pts.length) return { x: 0, y: 0 };
  let x = 0;
  let y = 0;
  for (const p of pts) {
    x += p.x;
    y += p.y;
  }
  return { x: x / pts.length, y: y / pts.length };
}

/**
 * Visual centre of any object — used for spatial section membership and for
 * rotating an object about its centre. Rows: centroid of expanded seats (or
 * origin when empty); tables/booths: centre; GA/section: polygon centroid;
 * shape: bbox centre; text: its position.
 */
export function objectCenter(o: ChartObject): Point {
  switch (o.type) {
    case 'row': {
      const seats = expandRow(o);
      if (!seats.length) return { x: o.origin.x, y: o.origin.y };
      let x = 0;
      let y = 0;
      for (const s of seats) {
        x += s.x;
        y += s.y;
      }
      return { x: x / seats.length, y: y / seats.length };
    }
    case 'table':
    case 'booth':
      return { x: o.center.x, y: o.center.y };
    case 'gaArea':
      return polygonCentroid(o.points);
    case 'section':
      return polygonCentroid(o.outline);
    case 'text':
      return { x: o.position.x, y: o.position.y };
    case 'shape':
      if (o.points && o.points.length) return polygonCentroid(o.points);
      if (o.x != null && o.y != null && o.width != null && o.height != null) {
        return { x: o.x + o.width / 2, y: o.y + o.height / 2 };
      }
      return { x: o.x ?? 0, y: o.y ?? 0 };
    case 'decorImage':
      return { x: o.x + o.width / 2, y: o.y + o.height / 2 };
  }
}

function samePoints(left: Point[], right: Point[]): boolean {
  return left.length === right.length
    && left.every((point, index) => point.x === right[index].x && point.y === right[index].y);
}

function sameGASurfaceAsSection(object: ChartObject, section: SectionObject): boolean {
  if (object.type !== 'gaArea' || !samePoints(object.points, section.outline)) return false;
  const objectHoles = object.holes ?? [];
  const sectionHoles = section.holes ?? [];
  return objectHoles.length === sectionHoles.length
    && objectHoles.every((hole, index) => samePoints(hole, sectionHoles[index]));
}

/**
 * Resolve one bookable object's owning physical section using the canonical
 * first-match rule. Generated reference inventory may name a logical section,
 * but that provenance is trusted only when the stored geometry confirms it.
 * Keeping this primitive in layout lets section inventory, category painting,
 * and buyer view inheritance share one ownership decision.
 */
export function owningSectionForObject(
  objects: ChartObject[],
  object: ChartObject,
): SectionObject | undefined {
  const sections = objects.filter((candidate): candidate is SectionObject => candidate.type === 'section');
  const referencedLogicalId = 'referenceInventorySource' in object
    ? object.referenceInventorySource?.logicalSectionId
    : undefined;
  const center = objectCenter(object);
  const referencedOwner = referencedLogicalId
    ? sections.find((section) => (
        (section.logicalSectionId ?? section.id) === referencedLogicalId
        && (sameGASurfaceAsSection(object, section)
          || pointInPolygonWithHoles(center, section.outline, section.holes))
      ))
    : undefined;
  return referencedOwner
    ?? sections.find((section) => pointInPolygonWithHoles(center, section.outline, section.holes));
}

/**
 * Normalized floor list (Batch 5): a multi-floor chart's `floors`, or a synthetic
 * single floor wrapping a single-floor chart's `objects`. Every consumer that needs
 * to reason about floors goes through this so single-floor charts stay untouched.
 */
export function floorsOf(doc: ChartDoc): Floor[] {
  if (doc.floors && doc.floors.length) return doc.floors;
  return [{
    id: 'floor-0',
    name: 'Main',
    objects: doc.objects,
    focalPoint: doc.focalPoint,
    referenceImage: doc.referenceImage,
    backgroundImage: doc.backgroundImage,
  }];
}

/** Objects of one floor by id (defaults to the first floor). */
export function floorObjects(doc: ChartDoc, floorId?: string): ChartObject[] {
  const floors = floorsOf(doc);
  return (floorId ? floors.find((f) => f.id === floorId) : floors[0])?.objects ?? [];
}

/** Every object across ALL floors — the whole venue (single-floor = `doc.objects`). */
export function allObjects(doc: ChartDoc): ChartObject[] {
  return doc.floors && doc.floors.length ? doc.floors.flatMap((f) => f.objects) : doc.objects;
}

/** A copy of an object translated by (dx, dy) — every coordinate field shifted. */
function translateObject(o: ChartObject, dx: number, dy: number): ChartObject {
  const p = (pt: Point): Point => ({ x: pt.x + dx, y: pt.y + dy });
  const pts = (a: Point[]): Point[] => a.map(p);
  switch (o.type) {
    case 'row':
      return { ...o, origin: p(o.origin) };
    case 'table':
    case 'booth':
      return { ...o, center: p(o.center) };
    case 'gaArea':
      return { ...o, points: pts(o.points), ...(o.holes ? { holes: o.holes.map(pts) } : {}) };
    case 'section':
      return {
        ...o,
        outline: pts(o.outline),
        ...(o.outlinePath ? { outlinePath: translateSectionOutlinePath(o.outlinePath, dx, dy) } : {}),
        ...(o.holes ? { holes: o.holes.map(pts) } : {}),
      };
    case 'text':
      return { ...o, position: p(o.position) };
    case 'shape':
      return {
        ...o,
        ...(o.points ? { points: pts(o.points) } : {}),
        ...(o.x != null ? { x: o.x + dx } : {}),
        ...(o.y != null ? { y: o.y + dy } : {}),
      };
    case 'decorImage':
      return { ...o, x: o.x + dx, y: o.y + dy };
  }
}

/**
 * Multi-floor 3D stack (Batch 5): flatten every floor into ONE doc with floor `i`
 * lifted by `i * spread` in −y, so the isometric view shows the floors as stacked
 * decks (ground at the bottom). Returns a single-floor doc (no `floors`). Meant
 * only for the 3D overview render — 2D still shows one floor via `floorObjects`.
 */
export function stackFloors(doc: ChartDoc, spread = 900): ChartDoc {
  if (!doc.floors || doc.floors.length < 2) return doc;
  const objects: ChartObject[] = [];
  doc.floors.forEach((f, i) => {
    const dy = -i * spread;
    for (const o of f.objects) objects.push(dy === 0 ? o : translateObject(o, 0, dy));
  });
  return { ...doc, objects, floors: undefined };
}

export interface ExpandChartOptions {
  /** Physical height for a single-floor projection extracted from a multi-floor
   * document. Full multi-floor documents resolve each floor directly. */
  floorBaseHeightM?: number;
}

function expandFloorObjects(
  objects: ChartObject[],
  zones: ChartDoc['zones'],
  fallbackFocal: Point | undefined,
): ExpandedSeat[] {
  const out: ExpandedSeat[] = [];
  const segmented = new Map<string, {
    groupId: string;
    adjacencyOffset: number;
    displayOffset: number;
    displayLabel: string;
    totalSeats: number;
    canonical: RowObject;
    viewFromSeatUrl?: string;
  }>();

  // Resolve only complete, internally coherent groups. Malformed metadata is
  // surfaced by validation and deliberately falls back to physical-row
  // semantics here, so a corrupt document can never make buyer adjacency more
  // permissive than the legacy model.
  const grouped = new Map<string, RowObject[]>();
  for (const object of objects) {
    if (object.type !== 'row' || !object.segmentedRow) continue;
    const list = grouped.get(object.segmentedRow.groupId) ?? [];
    list.push(object);
    grouped.set(object.segmentedRow.groupId, list);
  }
  for (const [groupId, members] of grouped) {
    const ordered = members.slice().sort((left, right) => (
      left.segmentedRow!.componentIndex - right.segmentedRow!.componentIndex
    ));
    const expectedCount = ordered[0]?.segmentedRow?.componentCount ?? 0;
    const first = ordered[0]?.segmentedRow;
    if (!first) continue;
    const valid = expectedCount >= 2
      && ordered.length === expectedCount
      && first?.boundaryBefore === 'start'
      && ordered.every((row, index) => (
        row.segmentedRow?.kind === 'segmented-row-v1'
        && row.segmentedRow.groupId === groupId
        && row.segmentedRow.componentCount === expectedCount
        && row.segmentedRow.componentIndex === index
        && (index === 0
          ? row.segmentedRow.boundaryBefore === 'start'
          : row.segmentedRow.boundaryBefore !== 'start')
        && row.segmentedRow.displayLabel === first.displayLabel
      ));
    if (!valid) continue;
    const totalSeats = ordered.reduce((sum, row) => sum + row.seatCount, 0);
    let adjacencyOffset = 0;
    let displayOffset = 0;
    for (const row of ordered) {
      if (row.segmentedRow!.boundaryBefore === 'break') adjacencyOffset += 1;
      segmented.set(row.id, {
        groupId,
        adjacencyOffset,
        displayOffset,
        displayLabel: first.displayLabel,
        totalSeats,
        canonical: ordered[0],
        viewFromSeatUrl: first.viewFromSeatUrl,
      });
      adjacencyOffset += row.seatCount;
      displayOffset += row.seatCount;
    }
  }

  for (const obj of objects) {
    let seats: ExpandedSeat[] = [];
    if (obj.type === 'row') seats = expandRow(obj);
    else if (obj.type === 'table') seats = expandTable(obj);
    else if (obj.type === 'booth') seats = expandBooth(obj);
    if (!seats.length) continue;
    if (obj.type === 'row') {
      const logical = segmented.get(obj.id);
      if (logical) {
        const overrides = new Map((obj.overrides ?? []).map((override) => [override.index, override]));
        for (const seat of seats) {
          const physicalIndex = Number(seat.id.slice(seat.id.lastIndexOf(':') + 1));
          if (!Number.isInteger(physicalIndex)) continue;
          const displayOrdinal = logical.displayOffset + physicalIndex;
          seat.logicalRowId = logical.groupId;
          seat.logicalSeatIndex = logical.adjacencyOffset + physicalIndex;
          // A seat-level display override remains the highest-precedence copy.
          if (!overrides.get(physicalIndex)?.displayLabel) {
            const numberingRow: RowObject = {
              ...logical.canonical,
              seatCount: logical.totalSeats,
              label: logical.displayLabel,
              displayLabel: logical.displayLabel,
            };
            seat.displayLabel = `${logical.displayLabel}-${seatLabelPart(numberingRow, displayOrdinal)}`;
          }
          seat.viewUrl ??= logical.viewFromSeatUrl;
        }
      }
    }
    const owner = owningSectionForObject(objects, obj);
    const inheritedView = owner?.viewFromSeatUrl;
    const zone = owner?.zone ? zones?.find((candidate) => candidate.id === owner.zone) : undefined;
    const resolvedFocal = zone?.focalPoint ?? fallbackFocal;
    for (const seat of seats) {
      if (inheritedView) seat.viewUrl ??= inheritedView;
      if (owner) seat.sectionId = owner.logicalSectionId ?? owner.id;
      if (owner?.zone) seat.zoneId = owner.zone;
      if (resolvedFocal) seat.focalPoint = { ...resolvedFocal };
    }
    out.push(...seats);
  }
  return out;
}

/** Expand every seat-bearing object across all floors (rows, tables, booths).
 * Multi-floor ownership is resolved one floor at a time: local coordinates may
 * overlap between floors and must never assign a seat to another floor's section. */
export function expandChart(doc: ChartDoc, options: ExpandChartOptions = {}): ExpandedSeat[] {
  if (doc.floors?.length) {
    const out: ExpandedSeat[] = [];
    for (const floor of doc.floors) {
      const floorFocal = floor.focalPoint ?? doc.focalPoint;
      const seats = expandFloorObjects(floor.objects, doc.zones, floorFocal);
      assignEyeHeights(floor.objects, floor.focalPoint ?? doc.focalPoint, floor.baseHeightM ?? 0, seats);
      out.push(...seats);
    }
    return out;
  }
  const out = expandFloorObjects(doc.objects, doc.zones, doc.focalPoint);
  assignEyeHeights(doc.objects, doc.focalPoint, options.floorBaseHeightM ?? 0, out);
  return out;
}

/**
 * Phase B2: annotate each expanded seat with a real-world eye height (metres above
 * the focal/stage datum) for the auto-360° generator. Resolved once at expand time
 * — never per render frame — so the 13k-seat render path pays no cost.
 *
 * `eyeHeightM = section front-edge height + row rise + seated eye height`, where
 * the ROW RISE is derived from the seat's DRAWN radial depth into its section
 * (chart units → metres × tan(rake)), NOT a hard-coded row pitch. Deriving rise
 * from drawn geometry (the same distances the panorama already uses horizontally)
 * is the binding fix for the 30–40% under-rise the sightline de-risk study flagged
 * (docs/3d-sightline-derisk-2026-07-21.md §7).
 *
 * A chart with no elevated/raked/height-authored section skips the spatial pass
 * entirely and every seat resolves to the flat seated-eye baseline — so legacy
 * charts stay pixel-identical and `expandChart`'s other callers pay nothing.
 */
function assignEyeHeights(
  objects: ChartObject[],
  focal: Point | undefined,
  floorBaseHeightM: number,
  seats: ExpandedSeat[],
): void {
  const sections = objects.filter((o): o is SectionObject => o.type === 'section');
  const hasGeometry = floorBaseHeightM > 0
    || sections.some((s) => s.height !== undefined || s.rake !== undefined || (s.elevation ?? 0) > 0);
  if (!sections.length || !hasGeometry || !focal) {
    for (const seat of seats) seat.eyeHeightM = floorBaseHeightM + SEATED_EYE_HEIGHT_M;
    return;
  }
  // Pass 1: owning section (first drawn section containing the seat) + the drawn
  // distance of the section's front edge (nearest member to the focal point).
  const owner = new Array<SectionObject | null>(seats.length);
  const geo = new Map<string, { height: number; rake: number }>();
  const frontDistU = new Map<string, number>();
  for (let i = 0; i < seats.length; i++) {
    const seat = seats[i];
    const sec = sections.find((s) => pointInPolygonWithHoles({ x: seat.x, y: seat.y }, s.outline, s.holes)) ?? null;
    owner[i] = sec;
    if (!sec) continue;
    if (!geo.has(sec.id)) geo.set(sec.id, sectionGeometry(sec, { floorBaseHeightM }));
    const seatFocal = seat.focalPoint ?? focal;
    const d = Math.hypot(seat.x - seatFocal.x, seat.y - seatFocal.y);
    const cur = frontDistU.get(sec.id);
    if (cur === undefined || d < cur) frontDistU.set(sec.id, d);
  }
  // Pass 2: front-edge height + drawn-depth rise + seated eye.
  for (let i = 0; i < seats.length; i++) {
    const seat = seats[i];
    const sec = owner[i];
    if (!sec) { seat.eyeHeightM = floorBaseHeightM + SEATED_EYE_HEIGHT_M; continue; }
    const g = geo.get(sec.id)!;
    let riseM = 0;
    if (g.rake > 0) {
      const seatFocal = seat.focalPoint ?? focal;
      const d = Math.hypot(seat.x - seatFocal.x, seat.y - seatFocal.y);
      const depthU = Math.max(0, d - (frontDistU.get(sec.id) ?? d));
      riseM = depthU * METRES_PER_CHART_UNIT * Math.tan((g.rake * Math.PI) / 180);
    }
    seat.eyeHeightM = g.height + riseM + SEATED_EYE_HEIGHT_M;
  }
}

const PAD = 40;

/** Axis-aligned bounds over every object plus the background image, with padding. */
export function chartBounds(doc: ChartDoc): { x: number; y: number; width: number; height: number } {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;

  const acc = (x: number, y: number) => {
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  };

  for (const s of expandChart(doc)) acc(s.x, s.y);

  for (const obj of allObjects(doc)) {
    if (obj.type === 'gaArea') {
      for (const p of obj.points) acc(p.x, p.y);
    } else if (obj.type === 'section') {
      for (const p of obj.outline) acc(p.x, p.y);
    } else if (obj.type === 'decorImage') {
      acc(obj.x, obj.y);
      acc(obj.x + obj.width, obj.y + obj.height);
    } else if (obj.type === 'shape') {
      if (obj.points && obj.points.length) {
        for (const p of obj.points) acc(p.x, p.y);
      } else if (obj.x != null && obj.y != null && obj.width != null && obj.height != null) {
        acc(obj.x, obj.y);
        acc(obj.x + obj.width, obj.y + obj.height);
      }
    } else if (obj.type === 'table') {
      const off = TABLE_SEAT_OFFSET + SEAT_R;
      const ext =
        obj.shape === 'round'
          ? (obj.radius ?? 40) + off
          : Math.max((obj.width ?? 80) / 2, (obj.height ?? 50) / 2) + off; // rotation-agnostic over-approximation
      acc(obj.center.x - ext, obj.center.y - ext);
      acc(obj.center.x + ext, obj.center.y + ext);
    } else if (obj.type === 'booth') {
      const ext = Math.max(obj.width, obj.height) / 2;
      acc(obj.center.x - ext, obj.center.y - ext);
      acc(obj.center.x + ext, obj.center.y + ext);
    } else if (obj.type === 'text') {
      const w = obj.fontSize * obj.text.length * 0.6; // approximate glyph advance
      acc(obj.position.x, obj.position.y);
      acc(obj.position.x + w, obj.position.y + obj.fontSize);
    }
  }

  for (const image of [doc.referenceImage, doc.backgroundImage]) {
    if (!image) continue;
    const { center, width } = image;
    const bh = (width * 3) / 4; // assume 4:3 when the true aspect is unknown at bounds-time
    acc(center.x - width / 2, center.y - bh / 2);
    acc(center.x + width / 2, center.y + bh / 2);
  }

  // Empty document → a sane default box around the focal point.
  if (!isFinite(minX)) {
    const f = doc.focalPoint ?? { x: 0, y: 0 };
    return { x: f.x - 200, y: f.y - 200, width: 400, height: 400 };
  }

  return {
    x: minX - PAD,
    y: minY - PAD,
    width: maxX - minX + PAD * 2,
    height: maxY - minY + PAD * 2,
  };
}

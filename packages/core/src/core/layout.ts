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
  SeatOverride,
  TableObject,
} from './types';
import { distributeAlongCubic } from './complexGeometry';
import { translateSectionOutlinePath } from './sectionPath';

/** Resolve a seat override's accessibility, honouring the legacy boolean flag. */
function overrideAccessibility(o: SeatOverride | undefined): AccessibilityType[] {
  if (!o) return [];
  if (o.accessibility && o.accessibility.length) return o.accessibility;
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
function rowSeatPositions(row: RowObject): Point[] {
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
  commercial?: RowObject['commercial'];
  viewUrl?: string;
  labelStyle?: LabelStyle;
}

export function expandRowSlots(row: RowObject): RowSeatSlot[] {
  const start = row.seatLabelStart ?? 1;
  const dir = row.seatNumbering?.direction ?? 'ltr';
  const step = row.seatNumbering?.step ?? 1;
  const n = row.seatCount;
  let seatNumber: (i: number) => number;
  if (dir === 'center') {
    // Number outward from the middle: rank seats by distance from centre
    // (inner-left wins ties), so the centre seat gets `start`.
    const rank = new Array<number>(n);
    Array.from({ length: n }, (_, i) => i)
      .sort((a, b) => Math.abs(2 * a - (n - 1)) - Math.abs(2 * b - (n - 1)) || a - b)
      .forEach((idx, k) => (rank[idx] = k));
    seatNumber = (i) => start + rank[i] * step;
  } else {
    seatNumber = (i) => start + (dir === 'rtl' ? n - 1 - i : i) * step;
  }
  const ov = overrideMap(row);
  return rowSeatPositions(row).map((p, i) => {
    const o = ov.get(i);
    const accessibility = overrideAccessibility(o);
    const inventoryLabel = o?.label ?? `${row.label}-${seatNumber(i)}`;
    const displayPrefix = row.displayLabel ?? row.label;
    const commercial = { ...row.commercial, ...o?.commercial };
    return {
      index: i,
      x: p.x + (o?.dx ?? 0),
      y: p.y + (o?.dy ?? 0),
      label: inventoryLabel,
      displayLabel: o?.displayLabel ?? `${displayPrefix}-${seatNumber(i)}`,
      categoryKey: o?.categoryKey ?? row.categoryKey,
      skipped: !!o?.skip,
      accessible: accessibility.length > 0,
      accessibility,
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
export function expandTable(t: TableObject): ExpandedSeat[] {
  const seats: ExpandedSeat[] = [];
  const n = Math.max(0, Math.round(t.seatCount));
  if (n === 0) return seats;

  const mk = (i: number, x: number, y: number): ExpandedSeat => ({
    id: `${t.id}:${i}`,
    label: `${t.label}-${i + 1}`,
    x,
    y,
    rowId: t.id,
    categoryKey: t.categoryKey,
  });

  if (t.shape === 'round') {
    const R = (t.radius ?? 40) + TABLE_SEAT_OFFSET;
    const base = t.rotation * DEG;
    const arc = Math.max(0, Math.min(360, t.seatArc ?? 360));
    if (arc >= 360 || n === 1) {
      // Full ring (or a lone seat) — evenly spaced around the whole table.
      for (let i = 0; i < n; i++) {
        const a = base + (i / n) * 2 * Math.PI;
        seats.push(mk(i, t.center.x + R * Math.cos(a), t.center.y + R * Math.sin(a)));
      }
      return seats;
    }
    // Open side: seats fill the arc, leaving a gap centred on `rotation` (the
    // opening — face it toward the aisle/wall). Seats span edge-to-edge of the
    // seated arc so people flank the gap.
    const arcRad = arc * DEG;
    const halfGap = (2 * Math.PI - arcRad) / 2;
    const start = base + halfGap;
    for (let i = 0; i < n; i++) {
      const a = start + (i / (n - 1)) * arcRad;
      seats.push(mk(i, t.center.x + R * Math.cos(a), t.center.y + R * Math.sin(a)));
    }
    return seats;
  }

  // Rect: seats line the enabled edges. Round-robin the count across sides in
  // canonical order so they stay balanced; top/bottom run along width, left/
  // right along height, all 16u outside and rotated with the table.
  const w = t.width ?? 80;
  const h = t.height ?? 50;
  const enabled: NonNullable<TableObject['sides']> =
    t.sides && t.sides.length ? t.sides : ['top', 'bottom'];
  const order = (['top', 'bottom', 'left', 'right'] as const).filter((s) => enabled.includes(s));
  if (!order.length) return seats;
  const counts = new Map<(typeof order)[number], number>(order.map((s) => [s, 0]));
  for (let i = 0; i < n; i++) {
    const s = order[i % order.length];
    counts.set(s, counts.get(s)! + 1);
  }
  let idx = 0;
  for (const side of order) {
    const count = counts.get(side)!;
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
      const p = place(localX, localY, t.rotation, t.center);
      seats.push(mk(idx++, p.x, p.y));
    }
  }
  return seats;
}

/** Expand a booth into its single bookable block unit. */
export function expandBooth(b: BoothObject): ExpandedSeat[] {
  return [
    {
      id: `${b.id}:0`,
      label: b.label,
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

/**
 * Normalized floor list (Batch 5): a multi-floor chart's `floors`, or a synthetic
 * single floor wrapping a single-floor chart's `objects`. Every consumer that needs
 * to reason about floors goes through this so single-floor charts stay untouched.
 */
export function floorsOf(doc: ChartDoc): Floor[] {
  if (doc.floors && doc.floors.length) return doc.floors;
  return [{ id: 'floor-0', name: 'Main', objects: doc.objects, focalPoint: doc.focalPoint, backgroundImage: doc.backgroundImage }];
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

/** Expand every seat-bearing object across all floors (rows, tables, booths). */
export function expandChart(doc: ChartDoc): ExpandedSeat[] {
  const out: ExpandedSeat[] = [];
  for (const obj of allObjects(doc)) {
    if (obj.type === 'row') out.push(...expandRow(obj));
    else if (obj.type === 'table') out.push(...expandTable(obj));
    else if (obj.type === 'booth') out.push(...expandBooth(obj));
  }
  return out;
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

  if (doc.backgroundImage) {
    const { center, width } = doc.backgroundImage;
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

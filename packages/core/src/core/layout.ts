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
  Point,
  RowObject,
  SeatOverride,
  TableObject,
} from './types';

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
  categoryKey: string;
  skipped: boolean;
  accessible: boolean;
  accessibility: AccessibilityType[];
}

export function expandRowSlots(row: RowObject): RowSeatSlot[] {
  const start = row.seatLabelStart ?? 1;
  const dir = row.seatNumbering?.direction ?? 'ltr';
  const step = row.seatNumbering?.step ?? 1;
  const seatNumber = (i: number) => start + (dir === 'rtl' ? row.seatCount - 1 - i : i) * step;
  const ov = overrideMap(row);
  return rowSeatPositions(row).map((p, i) => {
    const o = ov.get(i);
    const accessibility = overrideAccessibility(o);
    return {
      index: i,
      x: p.x + (o?.dx ?? 0),
      y: p.y + (o?.dy ?? 0),
      label: o?.label ?? `${row.label}-${seatNumber(i)}`,
      categoryKey: o?.categoryKey ?? row.categoryKey,
      skipped: !!o?.skip,
      accessible: accessibility.length > 0,
      accessibility,
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
      x: slot.x,
      y: slot.y,
      rowId: row.id,
      categoryKey: slot.categoryKey,
      accessible: slot.accessible || undefined,
      accessibility: slot.accessibility.length ? slot.accessibility : undefined,
      viewUrl: row.viewFromSeatUrl,
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
    for (let i = 0; i < n; i++) {
      const a = base + (i / n) * 2 * Math.PI;
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
  }
}

/** Expand every seat-bearing object (rows, tables, booths). */
export function expandChart(doc: ChartDoc): ExpandedSeat[] {
  const out: ExpandedSeat[] = [];
  for (const obj of doc.objects) {
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

  for (const obj of doc.objects) {
    if (obj.type === 'gaArea') {
      for (const p of obj.points) acc(p.x, p.y);
    } else if (obj.type === 'section') {
      for (const p of obj.outline) acc(p.x, p.y);
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

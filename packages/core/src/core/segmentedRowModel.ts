/**
 * The segmented-row model — one logical row made of several physical rows.
 *
 * A segmented row is drawn as a chain of nodes and stored as N physical
 * `RowObject`s tied together by `segmentedRow` metadata. Two questions have to
 * be answered consistently or the feature lies to somebody:
 *
 * 1. **At draft time** — given the author's nodes, exactly which components,
 *    seat counts and pitches will be committed? (`segmentedRowComponents`)
 * 2. **At read time** — given stored physical rows, what is the logical row they
 *    form, and where does each component sit inside its numbering?
 *    (`resolveSegmentedRowGroups`)
 *
 * These lived apart — (1) in `rowDraft.ts` next to the ghost preview, (2) in
 * `layout.ts` next to buyer expansion — which is precisely how the canvas came
 * to number a segmented row `1-7` / `1-6` while buyers correctly saw
 * `A-1…A-13`. They are two halves of one rule, so they live in one module.
 *
 * The standing rule this module exists to enforce: **the ghost preview and the
 * commit share one resolver.** A preview that can lie is a bug.
 */
import type { ChartObject, Point, RowObject } from './types';

// ---------------------------------------------------------------------------
// Draft time — nodes to components
// ---------------------------------------------------------------------------

/** One physical component of a segmented (node-drawn) row. */
export interface SegmentedRowComponent {
  origin: Point;
  /** Bearing in degrees, matching RowObject.rotation. */
  rotation: number;
  seatCount: number;
  /** Pitch is per-component: each span divides evenly into whole seats. */
  seatSpacing: number;
}

/**
 * Resolve node points into the exact components `finishSegmentedRowDrawing`
 * commits, so the ghost preview and the committed rows always agree.
 *
 * `boundaries[i]` describes the junction BEFORE component i+1. The first
 * component owns the first node's seat; every later component starts one pitch
 * after its junction so a continuous bend never double-books a seat, and a
 * declared break skips two pitches to leave a visible aisle.
 */
export function segmentedRowComponents(
  points: readonly Point[],
  boundaries: readonly ('continuous' | 'break')[],
  seatSpacing: number,
): SegmentedRowComponent[] {
  const components: SegmentedRowComponent[] = [];
  for (let index = 0; index < points.length - 1; index += 1) {
    const start = points[index];
    const end = points[index + 1];
    const distance = Math.hypot(end.x - start.x, end.y - start.y);
    if (distance <= 0) continue;
    const pitchCount = Math.max(1, Math.round(distance / seatSpacing));
    const pitch = distance / pitchCount;
    const angle = Math.atan2(end.y - start.y, end.x - start.x);
    const firstComponent = index === 0;
    const boundaryBefore = index > 0 ? boundaries[index - 1] : undefined;
    const skippedPitches = boundaryBefore === 'break' ? 2 : 1;
    const origin = firstComponent
      ? { ...start }
      : {
        x: start.x + Math.cos(angle) * pitch * skippedPitches,
        y: start.y + Math.sin(angle) * pitch * skippedPitches,
      };
    const seatCount = firstComponent ? pitchCount + 1 : Math.max(1, pitchCount - (skippedPitches - 1));
    components.push({ origin, rotation: (angle * 180) / Math.PI, seatCount, seatSpacing: pitch });
  }
  return components;
}

/** Seat centres for a resolved component, in seat order. */
export function segmentedRowComponentSeats(component: SegmentedRowComponent): Point[] {
  const rad = (component.rotation * Math.PI) / 180;
  const axis = { x: Math.cos(rad), y: Math.sin(rad) };
  return Array.from({ length: component.seatCount }, (_, index) => ({
    x: component.origin.x + axis.x * index * component.seatSpacing,
    y: component.origin.y + axis.y * index * component.seatSpacing,
  }));
}

/** Total seats a segmented draft would commit — the number the badge shows. */
export function segmentedRowSeatTotal(components: readonly SegmentedRowComponent[]): number {
  return components.reduce((total, component) => total + component.seatCount, 0);
}

// ---------------------------------------------------------------------------
// Read time — physical rows to the logical row
// ---------------------------------------------------------------------------

/** Resolved logical placement of one physical component inside a segmented row. */
export interface SegmentedRowPlacement {
  groupId: string;
  /** Buyer adjacency index base (a declared aisle break costs one index). */
  adjacencyOffset: number;
  /** Continuous seat-numbering base across the whole logical row. */
  displayOffset: number;
  displayLabel: string;
  totalSeats: number;
  canonical: RowObject;
  viewFromSeatUrl?: string;
}

/**
 * Group physical rows into their logical segmented rows, keyed by physical row id.
 *
 * Resolves only complete, internally coherent groups. Malformed metadata is
 * surfaced by validation and deliberately falls back to physical-row semantics,
 * so a corrupt document can never make buyer adjacency more permissive than the
 * legacy model.
 *
 * Shared by buyer expansion AND the Designer canvas so a segmented row cannot be
 * numbered one way for buyers and another way for the author.
 */
export function resolveSegmentedRowGroups(
  objects: readonly ChartObject[],
): Map<string, SegmentedRowPlacement> {
  const segmented = new Map<string, SegmentedRowPlacement>();
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
  return segmented;
}

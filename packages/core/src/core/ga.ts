import type { ChartDoc, GAAreaObject, GAInventorySegment } from './types';
import { allObjects } from './layout';

const PREFIX = '__sl_ga__';
export const MAX_GA_CAPACITY = 100_000;
export const MAX_EVENT_INVENTORY = 100_000;

/** Stable internal inventory label for one unit of a GA area's capacity. */
export function gaUnitLabel(areaId: string, index: number): string {
  return `${PREFIX}${encodeURIComponent(areaId)}__${index + 1}`;
}

/** Strict, bounded validation for durable Join Areas inventory provenance. */
export function validGAInventorySegments(area: GAAreaObject): boolean {
  const segments = area.inventorySegments;
  if (segments === undefined) return true;
  if (!Array.isArray(segments) || segments.length < 1 || segments.length > 256) return false;
  let total = 0;
  const ranges = new Map<string, Array<{ start: number; end: number }>>();
  for (const segment of segments) {
    if (!segment || typeof segment.sourceAreaId !== 'string'
      || !segment.sourceAreaId.trim() || segment.sourceAreaId.length > 160
      || !Number.isInteger(segment.startIndex) || segment.startIndex < 0
      || !Number.isInteger(segment.count) || segment.count < 1
      || segment.startIndex + segment.count > MAX_GA_CAPACITY) return false;
    total += segment.count;
    if (total > MAX_GA_CAPACITY) return false;
    const sourceRanges = ranges.get(segment.sourceAreaId) ?? [];
    const end = segment.startIndex + segment.count;
    if (sourceRanges.some((range) => segment.startIndex < range.end && end > range.start)) return false;
    sourceRanges.push({ start: segment.startIndex, end });
    ranges.set(segment.sourceAreaId, sourceRanges);
  }
  return total === area.capacity;
}

/** Canonical source ranges. Invalid explicit provenance intentionally yields no
 * labels: chart validation blocks publication instead of inventing identities. */
export function gaInventorySegments(area: GAAreaObject): GAInventorySegment[] {
  const capacity = Math.min(MAX_GA_CAPACITY, Math.max(0, Math.floor(area.capacity)));
  if (area.inventorySegments === undefined) {
    return capacity ? [{ sourceAreaId: area.id, startIndex: 0, count: capacity }] : [];
  }
  if (!validGAInventorySegments(area)) return [];
  return area.inventorySegments.map((segment) => ({ ...segment }));
}

export function gaUnitLabels(area: GAAreaObject): string[] {
  return gaInventorySegments(area).flatMap((segment) => Array.from(
    { length: segment.count },
    (_, offset) => gaUnitLabel(segment.sourceAreaId, segment.startIndex + offset),
  ));
}

/** Append-only capacity semantics for an already joined GA surface. */
export function growJoinedGAInventory(area: GAAreaObject, nextCapacity: number): GAInventorySegment[] | undefined {
  if (area.inventorySegments === undefined || nextCapacity === area.capacity) return area.inventorySegments;
  if (nextCapacity < area.capacity) return undefined;
  const segments = gaInventorySegments(area);
  if (!segments.length) return undefined;
  const extra = nextCapacity - area.capacity;
  if (!extra) return segments;
  const ownRanges = segments.filter((segment) => segment.sourceAreaId === area.id);
  const startIndex = ownRanges.reduce((max, segment) => Math.max(max, segment.startIndex + segment.count), 0);
  const last = segments[segments.length - 1];
  if (last?.sourceAreaId === area.id && last.startIndex + last.count === startIndex) {
    last.count += extra;
  } else {
    if (segments.length >= 256) return undefined;
    segments.push({ sourceAreaId: area.id, startIndex, count: extra });
  }
  return segments;
}

export function gaAreasOf(doc: ChartDoc): GAAreaObject[] {
  return allObjects(doc).filter((o): o is GAAreaObject => o.type === 'gaArea');
}

export function isGaUnitLabel(label: string): boolean {
  return label.startsWith(PREFIX);
}

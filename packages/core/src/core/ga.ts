import type { ChartDoc, GAAreaObject } from './types';
import { allObjects } from './layout';

const PREFIX = '__sl_ga__';
export const MAX_GA_CAPACITY = 100_000;
export const MAX_EVENT_INVENTORY = 100_000;

/** Stable internal inventory label for one unit of a GA area's capacity. */
export function gaUnitLabel(areaId: string, index: number): string {
  return `${PREFIX}${encodeURIComponent(areaId)}__${index + 1}`;
}

export function gaUnitLabels(area: GAAreaObject): string[] {
  const capacity = Math.min(MAX_GA_CAPACITY, Math.max(0, Math.floor(area.capacity)));
  return Array.from({ length: capacity }, (_, i) => gaUnitLabel(area.id, i));
}

export function gaAreasOf(doc: ChartDoc): GAAreaObject[] {
  return allObjects(doc).filter((o): o is GAAreaObject => o.type === 'gaArea');
}

export function isGaUnitLabel(label: string): boolean {
  return label.startsWith(PREFIX);
}

import { allObjects, expandTable } from './layout';
import type { ChartDoc, ExpandedSeat, TableObject } from './types';

export type ClientInventoryModelVersion = 1 | 2;
export type GroupedTableBookingMode = 'whole' | 'variable';

/**
 * Buyer-side projection of one atomic table inventory unit. The physical
 * chairs remain renderer geometry, but `label` is the only booking identity.
 */
export interface GroupedTableInventoryUnit {
  objectId: string;
  label: string;
  displayLabel?: string;
  displayType?: string;
  categoryKey: string;
  mode: GroupedTableBookingMode;
  capacity: number;
  minOccupancy: number;
  maxOccupancy: number;
  chairs: ExpandedSeat[];
}

export class GroupedTableProjectionError extends Error {
  constructor(
    readonly objectId: string,
    message: string,
  ) {
    super(message);
    this.name = 'GroupedTableProjectionError';
  }
}

function bounds(table: TableObject): { min: number; max: number } {
  const min = table.minOccupancy;
  const max = table.maxOccupancy;
  if (
    !Number.isInteger(min)
    || !Number.isInteger(max)
    || min! < 1
    || max! < min!
    || max! > table.seatCount
  ) {
    throw new GroupedTableProjectionError(
      table.id,
      `Table "${table.label}" has invalid variable-occupancy bounds`,
    );
  }
  return { min: min!, max: max! };
}

/**
 * Project grouped tables only for the event's explicit model-2 contract.
 * Model 1 deliberately returns no groups even if a legacy snapshot happens to
 * carry a grouping flag, preserving per-chair selection byte-for-byte.
 */
export function groupedTableInventory(
  doc: ChartDoc,
  modelVersion: ClientInventoryModelVersion,
): GroupedTableInventoryUnit[] {
  if (modelVersion !== 2) return [];
  const units: GroupedTableInventoryUnit[] = [];
  for (const object of allObjects(doc)) {
    if (object.type !== 'table' || (!object.bookAsWhole && !object.variableOccupancy)) continue;
    if (object.bookAsWhole && object.variableOccupancy) {
      throw new GroupedTableProjectionError(
        object.id,
        `Table "${object.label}" cannot be whole-table and variable-occupancy inventory`,
      );
    }
    if (!Number.isInteger(object.seatCount) || object.seatCount < 1 || !object.label.trim()) {
      throw new GroupedTableProjectionError(object.id, 'Grouped tables require a label and at least one chair');
    }
    const mode: GroupedTableBookingMode = object.variableOccupancy ? 'variable' : 'whole';
    const occupancy = mode === 'variable'
      ? bounds(object)
      : { min: object.seatCount, max: object.seatCount };
    units.push({
      objectId: object.id,
      label: object.label,
      ...(object.displayLabel ? { displayLabel: object.displayLabel } : {}),
      ...(object.displayType ? { displayType: object.displayType } : {}),
      categoryKey: object.categoryKey,
      mode,
      capacity: object.seatCount,
      minOccupancy: occupancy.min,
      maxOccupancy: occupancy.max,
      chairs: expandTable(object),
    });
  }
  return units;
}

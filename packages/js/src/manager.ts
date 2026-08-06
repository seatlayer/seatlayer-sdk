/**
 * `@seatlayer/js/manager` — the organizer cockpit, and nothing else.
 *
 * WHY THIS ENTRY EXISTS
 *
 * The main barrel (`@seatlayer/js`) is a buyer SDK that happens to also export
 * the organizer cockpit. A host that imports only `SeatManager` from it still
 * pays for `SeatPicker`, `SeatingChart`, `EmbeddedDesigner`, the buyer realtime
 * client and the buyer-access context — and, transitively, for the engine's
 * `PickerController`, `generatePanorama` and `renderedQuality`. None of that
 * runs in a control room. It was measured at ~197 KB of minified JS in the
 * dashboard's own Control Room route chunk, plus the engine code those buyer
 * surfaces are the only reason to reach.
 *
 * Bundlers cannot fix that from the outside. The published `dist/index.js` is
 * one file, and the classes in it are not provably side-effect-free at the
 * granularity a tree-shaker needs, so the buyer half survives even an import
 * that names one symbol.
 *
 * So the split is made HERE, where the module graph is still real: a separate
 * tsup entry whose graph reaches the cockpit and the engine it renders with,
 * and stops. `SeatManager` is imported from its own module rather than through
 * the barrel — going through the barrel would re-admit everything this entry
 * exists to exclude.
 *
 * Nothing is removed from the main barrel: `@seatlayer/js` still exports
 * `SeatManager` exactly as before. This is purely a cheaper door to the same
 * class, and the two share the emitted chunks a host that uses both would
 * otherwise duplicate.
 */
export { SeatManager } from './SeatManager';
export type {
  SeatManagerOptions,
  SeatManagerMode,
  SeatManagerCapability,
  SeatManagerTallies,
  SeatManagerActivity,
  SeatManagerActionResult,
  SeatManagerConnection,
} from './SeatManager';
export { ManageApi, ManageApiError } from './manageApi';
export type {
  ControlRoomActivityEntry,
  ControlRoomSectionMetric,
  ControlRoomSnapshot,
  LogEntry,
  ReportResult,
} from './manageApi';
export type { ExpandedSeat, SeatHoverDetails } from '@seatlayer/core';

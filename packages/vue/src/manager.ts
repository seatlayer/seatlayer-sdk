/**
 * `@seatlayer/vue/manager` — the organizer control room, and nothing else.
 *
 * A separate entry for the same reason as `@seatlayer/js/manager` and
 * `@seatlayer/react/manager`: a buyer app that imports `@seatlayer/vue` must
 * never carry the control room, and a control room must never carry the buyer
 * picker. The package root does not export `SeatManager` at all.
 *
 * The one rule that makes this work: this file, and `./SeatManager` behind it,
 * import from `@seatlayer/js/manager`, never from `@seatlayer/js`. One bare
 * import anywhere in this graph brings the whole buyer SDK back in, and it
 * looks like nothing at all in a diff.
 */
export { SeatManager } from './SeatManager';
export type { SeatManagerExposed, SeatManagerHandle, SeatManagerProps } from './SeatManager';
export type {
  SeatManagerOptions,
  SeatManagerMode,
  EventScopedManageToken,
  SeatManagerTallies,
  SeatManagerSale,
  SeatManagerActivity,
  SeatManagerActionResult,
  SeatManagerConnection,
  SeatManagerRoomState,
  SeatManagerFilteredSection,
  SeatManagerSelectionValidity,
  SeatManagerCategoryPrice,
  EventTableBookingMode,
  ControlRoomActivityEntry,
  ControlRoomSectionMetric,
  ControlRoomSnapshot,
} from '@seatlayer/js/manager';

/**
 * `@seatlayer/angular/manager` — the organizer control room, and nothing else.
 *
 * An ng-packagr secondary entry point, for the same reason as
 * `@seatlayer/js/manager` and `@seatlayer/react/manager`: a buyer app that
 * imports `@seatlayer/angular` must never carry the control room, and a control
 * room must never carry the buyer picker. The package root does not export
 * `SeatLayerSeatManagerComponent` at all.
 *
 * The one rule that makes this work: this entry imports from
 * `@seatlayer/js/manager`, never from `@seatlayer/js`. One bare import brings
 * the whole buyer SDK back in, and it looks like nothing at all in a diff.
 */
export { SeatLayerSeatManagerComponent } from './seat-manager.component';
export type { SeatManagerOpenOrder, SeatManagerOpenTrend } from './seat-manager.component';
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

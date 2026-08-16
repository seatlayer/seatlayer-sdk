/**
 * `@seatlayer/react/manager` — the organizer cockpit component, and nothing else.
 *
 * The React counterpart of `@seatlayer/js/manager`, and it exists for the same
 * reason: importing `SeatManager` from the package root drags `SeatPicker`,
 * `SeatingChart` and `EmbeddedDesigner` in with it, and through them the buyer
 * half of the engine. See the header of `@seatlayer/js`'s `src/manager.ts` for
 * the measurement and why a bundler cannot undo it from the outside.
 *
 * The one rule that makes this work: this file — and `./SeatManager` behind it
 * — must import from `@seatlayer/js/manager`, never from `@seatlayer/js`. One
 * bare-barrel import anywhere in this graph re-admits the whole buyer SDK and
 * the saving silently disappears, which is exactly the kind of regression that
 * looks like nothing at all in a diff.
 *
 * The package root keeps exporting `SeatManager` unchanged.
 */
export { SeatManager } from './SeatManager';
export type {
  SeatManagerHandle,
  SeatManagerProps,
  SeatManagerOptions,
  SeatManagerMode,
  EventScopedManageToken,
  SeatManagerTallies,
  SeatManagerActivity,
  SeatManagerActionResult,
  SeatManagerConnection,
} from './SeatManager';
export type {
  ControlRoomActivityEntry,
  ControlRoomSectionMetric,
  ControlRoomSnapshot,
} from '@seatlayer/js/manager';

/**
 * @seatlayer/react — the React wrapper for the SeatLayer embed SDK.
 */
export { SeatingChart } from './SeatingChart';
export { EmbeddedDesigner } from './EmbeddedDesigner';
export type {
  SeatingChartProps,
  SeatingChartHandle,
  SelectedSeat,
  HoldResult,
  BestAvailableResult,
  GAAreaAvailability,
  HoldLineItem,
} from './SeatingChart';
export type { EmbeddedDesignerProps, EmbeddedDesignerHandle, EmbeddedDesignerMessage } from './EmbeddedDesigner';
export { SeatPicker } from './SeatPicker';
export type {
  SeatPickerHandle,
  SeatPickerProps,
  SeatPickerOptions,
  SeatPickerTheme,
  CheckoutHandoff,
  CheckoutLineItem,
} from './SeatPicker';
// The framework-agnostic widget class — for the one-call modal (SeatPickerWidget.open()).
export { SeatPicker as SeatPickerWidget } from '@seatlayer/js';

// Organizer control room: Monitor + Inspect + bulk Block/unblock on one renderer.
export { SeatManager } from './SeatManager';
export type {
  SeatManagerHandle,
  SeatManagerProps,
  SeatManagerOptions,
  SeatManagerMode,
  SeatManagerTallies,
  SeatManagerActivity,
  SeatManagerActionResult,
} from './SeatManager';
export type { ControlRoomSectionMetric, ControlRoomSnapshot } from '@seatlayer/js';

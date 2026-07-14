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

// Organizer manage surface (M1: live View board + bulk Block/unblock).
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

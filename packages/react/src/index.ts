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
  SeatHoverDetails,
} from './SeatingChart';
export type { EmbeddedDesignerProps, EmbeddedDesignerHandle, EmbeddedDesignerMessage } from './EmbeddedDesigner';
export { SeatPicker } from './SeatPicker';
export type {
  SeatPickerHandle,
  SeatPickerProps,
  SeatPickerOptions,
  SeatPickerTheme,
  SeatPickerPricing,
  SeatPickerBestAvailableOptions,
  SeatPickerBuyerView,
  SeatPickerBuyerViewOptions,
  PickerMapTheme,
  RendererViewMode,
  CheckoutHandoff,
  CheckoutLineItem,
} from './SeatPicker';
// The framework-agnostic widget class — for the one-call modal (SeatPickerWidget.open()).
export { SeatPicker as SeatPickerWidget } from '@seatlayer/js';
// Host-side embed helper: grows the iframe on `seatlayer:height` and pins it on
// `seatlayer:fullscreen`. React hosts depend on this package alone, so it has to
// be reachable here rather than only from @seatlayer/js.
export { attachPickerFrame } from '@seatlayer/js';
export type { AttachPickerFrameOptions } from '@seatlayer/js';

// Organizer control room: Monitor + Inspect + bulk Block/unblock on one renderer.
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
// Sales Channels — buyer access sessions for private channel inventory.
export type {
  BuyerAccessToken,
  BuyerAccessTokenProvider,
  BuyerAccessRefreshReason,
  BuyerAccessUnavailableReason,
  BuyerAccessExpiredEvent,
  BuyerAccessUnavailableEvent,
  SelectedObjectUnavailableEvent,
} from '@seatlayer/js';

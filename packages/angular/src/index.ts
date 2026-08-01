/**
 * @seatlayer/angular — the Angular wrapper for the SeatLayer embed SDK.
 *
 * The component is standalone; import it directly rather than through an
 * NgModule.
 */
export { SeatLayerSeatingChartComponent } from './seating-chart.component';

export type {
  SelectedSeat,
  HoldResult,
  BestAvailableResult,
  GAAreaAvailability,
  HoldLineItem,
  SeatHoverDetails,
} from '@seatlayer/js';

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

// The framework-agnostic widget class — for the one-call modal (SeatPickerWidget.open()).
export { SeatPicker as SeatPickerWidget } from '@seatlayer/js';

// Host-side embed helper: grows the iframe on `seatlayer:height` and pins it on
// `seatlayer:fullscreen`. Angular hosts depend on this package alone, so it has to
// be reachable here rather than only from @seatlayer/js.
export { attachPickerFrame } from '@seatlayer/js';

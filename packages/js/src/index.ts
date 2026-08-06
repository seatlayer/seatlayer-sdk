/**
 * @seatlayer/js — the framework-agnostic SeatLayer embed SDK.
 *
 * Works in any JS environment (plain HTML, React, Vue, Svelte, Angular, …).
 * Framework wrappers (@seatlayer/react, …) build on top of this.
 */
export { SeatingChart } from './SeatingChart';
export type { SeatingChartOptions, SelectedSeat, GAAreaAvailability } from './SeatingChart';
export { ApiError } from './api';
export type { HoldResult, ResumedHoldResult, HoldConflict, HoldLineItem, BestAvailableResult, PubApiOptions } from './api';
// Hosted checkout (SeatPicker's `checkout: 'hosted'`). TYPES ONLY — the card
// that takes the payment is a lazy chunk and never enters this entry's graph,
// so importing these costs a host nothing at runtime.
export type {
  PaymentProviderName,
  PaymentOptionsReason,
  PaymentOptionsResult,
  CheckoutSessionResult,
  OrderStatusResult,
} from './api';
// Sales Channels — buyer access sessions (private channel inventory).
export { BuyerAccessContext, BuyerAccessUnavailableError, createBuyerAccessContext } from './buyerAccess';
export type {
  BuyerAccessToken,
  BuyerAccessTokenProvider,
  BuyerAccessRefreshReason,
  BuyerAccessUnavailableReason,
  BuyerAccessExpiredEvent,
  BuyerAccessUnavailableEvent,
  SelectedObjectUnavailableEvent,
} from './buyerAccess';
export { BuyerRealtimeClient, createControllerSink } from './buyerRealtime';
export type {
  RealtimeSink,
  StatusChange,
  Projection,
  SubscribeTicket,
  BuyerRealtimeOptions,
} from './buyerRealtime';
export { EmbeddedDesigner } from './EmbeddedDesigner';
export type {
  EmbeddedDesignerOptions,
  EmbeddedDesignerMessage,
  EmbeddedDesignerEventType,
} from './EmbeddedDesigner';
export type { SeatHoverDetails } from '@seatlayer/core';
export { SeatPicker } from './SeatPicker';
export type {
  SeatPickerOptions,
  SeatPickerTheme,
  CheckoutHandoff,
  CheckoutLineItem,
} from './SeatPicker';
// Host helper for iframe picker embeds: auto-height + fullscreen pin/restore.
export { attachPickerFrame } from './attachPickerFrame';
export type { AttachPickerFrameOptions } from './attachPickerFrame';
// Organizer control room: Monitor + Inspect + bulk Block/unblock on one renderer.
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
// Sales channels — the cockpit's Channels mode and its pure planning helpers.
// Exported so a host can reuse the review-bucket renderer (Apply results AND
// the chart-update `channel_assignment_would_drop` refusal share it).
export { ChannelsMode, bucketRowsHtml } from './channelsMode';
export type {
  ChannelsCapabilities, ChannelsClient, ChannelsModeHost, ChannelsRowView, ChannelsSeatView,
} from './channelsMode';
export {
  ACCESS_LINK_DEFAULTS,
  PUBLIC_CHANNEL_ID,
  PUBLIC_CHANNEL_NAME,
  accessIntentLabel,
  accessLine,
  accessLinkBadge,
  accessLinkErrorCopy,
  accessLinkIsLive,
  accessLinkPolicyLines,
  bucketRows,
  dropReviewRows,
  isPublicChannelId,
  markerLetter,
  markerOf,
  mutationCount,
  needsMoveConfirmation,
  planAssignment,
  retryAfterCopy,
  selectionSources,
  stateBadge,
  suggestMarker,
} from './channelPlan';
export type {
  AccessLinkRecord,
  AccessLinkReveal,
  AccessLinkState,
  AccessLinkStatus,
  AccessLinkStatusRecord,
  ArchiveBlockedDetails,
  AssignmentBuckets,
  AssignmentDropDetails,
  AssignmentResult,
  BucketRow,
  ChannelAccessIntent,
  ChannelAccessSummary,
  ChannelCounts,
  ChannelListResult,
  ChannelRecord,
  ChannelSeatStatus,
  ChannelState,
  SelectionSourceRow,
} from './channelPlan';
export { ManageApi, ManageApiError } from './manageApi';
export type {
  ChannelAllocationPage,
  ChannelAuditEntry,
  ChannelAuditPage,
  ChannelPreviewProjection,
  ReportResult,
  ReportByStatus,
  ReportCategoryRow,
  ReportCategoryMeta,
  ControlRoomActivityEntry,
  ControlRoomSectionMetric,
  ControlRoomSnapshot,
  LogEntry,
  LogPage,
} from './manageApi';
// Engine seat shape — surfaced for manage callbacks (selection payloads).
export type { ExpandedSeat } from '@seatlayer/core';

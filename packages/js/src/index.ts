/**
 * @seatlayer/js — the framework-agnostic SeatLayer embed SDK.
 *
 * Works in any JS environment (plain HTML, React, Vue, Svelte, Angular, …).
 * Framework wrappers (@seatlayer/react, …) build on top of this.
 */
export { SeatingChart } from './SeatingChart';
export type { SeatingChartOptions, SelectedSeat, GAAreaAvailability } from './SeatingChart';
export { ApiError } from './api';
export type { HoldResult, HoldConflict, HoldLineItem, BestAvailableResult } from './api';
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
// Organizer manage surface (M1: live View board + bulk Block/unblock).
export { SeatManager } from './SeatManager';
export type {
  SeatManagerOptions,
  SeatManagerMode,
  SeatManagerTallies,
  SeatManagerActivity,
  SeatManagerActionResult,
} from './SeatManager';
export { ManageApi, ManageApiError } from './manageApi';
export type {
  ReportResult,
  ReportByStatus,
  ReportCategoryRow,
  ReportCategoryMeta,
  LogEntry,
  LogPage,
} from './manageApi';
// Engine seat shape — surfaced for manage callbacks (selection payloads).
export type { ExpandedSeat } from '@seatlayer/core';

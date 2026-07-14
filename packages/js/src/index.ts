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

/**
 * SeatLayer mobile bridge — barrel.
 *
 * Deliberately NOT re-exported from `@seatlayer/js`'s public entry. Like
 * `renderChartDocument`, this is an EMBEDDING MECHANISM for a surface we
 * control (a native WebView wrapper), not a customer-facing API — shipping it
 * on npm would make the wire protocol a semver-supported contract for every
 * integrator. It is exported from the CDN entry only.
 */
export {
  BRIDGE_CAPABILITIES,
  BRIDGE_COMMANDS,
  BRIDGE_EVENTS,
  startBridge,
} from './host';
export type { BridgeChart, BridgeHandle, StartBridgeOptions } from './host';
export {
  BridgeError,
  ENVELOPE_MARKER,
  ERROR_CODES,
  PROTOCOL_MAX,
  PROTOCOL_MIN,
  decode,
  encode,
  negotiate,
} from './protocol';
export type {
  BridgeErrorCode,
  BridgeErrorPayload,
  Envelope,
  EnvelopeKind,
  HelloPayload,
  InitPayload,
  Negotiation,
  ProtocolRange,
} from './protocol';
export { detectTransport, installReceiver } from './transport';
export type { BridgeTransport, BridgeReceiver, TransportName } from './transport';

/**
 * Browser/CDN entrypoint. The implementation is re-exported directly from the
 * same @seatlayer/js source tree that produces npm; this file only adds an
 * inspectable release version for script-tag consumers.
 *
 * This entry is deliberately a SUPERSET of the npm public API. The npm surface
 * (`packages/js/src/index.ts`) stays the clean, supported integration contract;
 * the extra exports below are internal QA tooling that only ever runs inside a
 * headless browser we control, so they ship on the CDN artifact and nowhere else.
 */
export * from '../../packages/js/src/index';

/**
 * Internal, CDN-only: the headless buyer-renderer capture entry used by
 * Cloudflare Browser Rendering to produce AI chart-review evidence. It replaces
 * the retired private `@seatlayer/js` 0.2.x bundle, whose consumer calls
 * `window.seatlayer.renderChartDocument(...)`.
 *
 * NOT part of the npm public API and NOT semver-supported for integrators —
 * `BUYER_RENDERER_CONTRACT_VERSION` is the version the review worker validates.
 */
export { renderChartDocument, BUYER_RENDERER_CONTRACT_VERSION } from './ChartDocumentPreview';
export type {
  ChartDocumentPreview,
  ChartDocumentPreviewOptions,
  BuyerEvidenceState,
} from './ChartDocumentPreview';

/**
 * Internal, CDN-only: the native mobile bridge. A WebView wrapper loads this
 * bundle and calls `window.seatlayer.startBridge()`; everything after that is
 * the versioned envelope protocol in `packages/js/src/bridge/`.
 *
 * Same reasoning as `renderChartDocument` above — this is an embedding
 * mechanism for a surface we control, not a customer API, so it must NOT
 * appear in the npm `@seatlayer/js` types.
 */
import {
  startBridge as startBridgeImpl,
  type BridgeHandle,
  type StartBridgeOptions,
} from '../../packages/js/src/bridge/index';

export {
  BRIDGE_CAPABILITIES,
  BRIDGE_COMMANDS,
  BRIDGE_EVENTS,
  BridgeError,
  ERROR_CODES as BRIDGE_ERROR_CODES,
  PROTOCOL_MAX as BRIDGE_PROTOCOL_MAX,
  PROTOCOL_MIN as BRIDGE_PROTOCOL_MIN,
  decode as decodeBridgeEnvelope,
  detectTransport as detectBridgeTransport,
  encode as encodeBridgeEnvelope,
  negotiate as negotiateBridgeProtocol,
} from '../../packages/js/src/bridge/index';
export type {
  BridgeChart,
  BridgeErrorCode,
  BridgeErrorPayload,
  BridgeHandle,
  BridgeTransport,
  Envelope as BridgeEnvelope,
  EnvelopeKind as BridgeEnvelopeKind,
  HelloPayload as BridgeHelloPayload,
  InitPayload as BridgeInitPayload,
  Negotiation as BridgeNegotiation,
  ProtocolRange as BridgeProtocolRange,
  StartBridgeOptions,
  TransportName as BridgeTransportName,
} from '../../packages/js/src/bridge/index';

declare const __SEATLAYER_SDK_VERSION__: string;
export const version = __SEATLAYER_SDK_VERSION__;

/**
 * Start the native bridge. Thin wrapper over the runtime so the `hello`
 * envelope reports the real CDN bundle version without `packages/js` having to
 * know about the build-time define.
 */
export function startBridge(options: StartBridgeOptions = {}): BridgeHandle {
  return startBridgeImpl({ bundle: __SEATLAYER_SDK_VERSION__, ...options });
}

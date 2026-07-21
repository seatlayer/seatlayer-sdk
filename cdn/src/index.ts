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

declare const __SEATLAYER_SDK_VERSION__: string;
export const version = __SEATLAYER_SDK_VERSION__;

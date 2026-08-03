/**
 * Entry for the lazy hosted-checkout chunk (`seatlayer-checkout.mjs`).
 *
 * ONE export, and the module behind it imports nothing at runtime — see the
 * header of packages/js/src/hostedCheckout.ts. That is what keeps this asset a
 * few kilobytes of payment UI rather than a second copy of the engine: a single
 * value import from `@seatlayer/core` would drag the renderer in behind it,
 * because a standalone CDN asset cannot share a chunk with the main bundle.
 */
export { mountCheckout } from '../../packages/js/src/hostedCheckout';

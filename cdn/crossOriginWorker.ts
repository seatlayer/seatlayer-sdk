import type { Plugin } from 'vite';

/**
 * Make the scene worker survive being loaded from another origin.
 *
 * The 3D chunk starts its scene compiler with
 *
 *   new Worker(new URL('./scene/scene.worker.ts', import.meta.url), { type: 'module' })
 *
 * which Vite emits as a hashed asset beside the chunk. That works everywhere the
 * chunk and the asset share the page's origin — a bundled npm consumer, the app
 * itself. It does NOT work on the CDN, and this is not a CORS problem we can
 * configure away: **the `Worker` constructor refuses a cross-origin script URL
 * outright**, whatever headers the response carries, and it refuses it by
 * THROWING. Measured in Chrome against the real cdn/src/worker.mjs serving the
 * real asset with `Access-Control-Allow-Origin: *`:
 *
 *   DOMException: Failed to construct 'Worker': Script at
 *   'http://cdn.example/seatlayer-js@0.46.0/assets/scene.worker-<hash>.js'
 *   cannot be accessed from origin 'http://host.example'.
 *
 * (`type: 'module'` relaxes the same-origin rule for the worker's own *imports*,
 * not for its top-level script URL.) Because the throw happens inside the promise
 * executor in prepareScene.ts, prepareVenue3D REJECTS — it does not take its
 * documented non-fatal main-thread fallback — so opening 3D fails outright for
 * every CDN integrator.
 *
 * The fix, applied only to the CDN artifact because the CDN is the only
 * cross-origin case:
 *
 *  1. Try the direct module worker. Same-origin consumers are unaffected.
 *  2. On refusal, construct the worker from a SAME-ORIGIN blob whose entire body
 *     is `import "<the cdn url>";`. A blob worker's script URL is same-origin, so
 *     the constructor allows it, and its import is a CORS fetch the CDN permits.
 *     The 128 KB of worker stays a real, hashed, sha-pinned, cacheable CDN object
 *     — this is a one-line pointer, not the inlining that was rejected for
 *     exactly this CSP reason.
 *  3. If the host's CSP `worker-src` refuses blob: too, hand back a stub that
 *     reports failure the way a real worker would, so prepareScene's existing
 *     non-fatal fallback runs the same pure compiler on the main thread. That is
 *     where every CDN integrator is today, so step 3 is never a regression — it
 *     is the floor, and steps 1–2 are the upside.
 *
 * This is a rewrite of the built chunk rather than a change to
 * packages/core/src/view3d/prepareScene.ts because that file is a generated
 * mirror of the app (see RELEASING.md) and because the concern is genuinely
 * CDN-only.
 */
const HELPER = `
function __slSpawnWorker(url, options) {
  try {
    return new Worker(url, options);
  } catch (directError) {
    // Cross-origin script URL: refused by the constructor itself, not by CORS.
  }
  try {
    var href = String(url);
    var blobUrl = URL.createObjectURL(new Blob(
      ['import ' + JSON.stringify(href) + ';'],
      { type: 'text/javascript' }
    ));
    var worker = new Worker(blobUrl, options);
    // Revoke once the worker has actually reported something, rather than on a
    // timer: the caller assigns onmessage/onerror, which does not disturb these.
    var revoke = function () { URL.revokeObjectURL(blobUrl); };
    worker.addEventListener('message', revoke, { once: true });
    worker.addEventListener('error', revoke, { once: true });
    return worker;
  } catch (blobError) {
    // The host's CSP worker-src refuses blob:. Fall through.
  }
  // No worker is available. Report it the way a failing worker would, so the
  // caller's non-fatal main-thread fallback runs instead of an unhandled
  // rejection.
  return {
    onmessage: null,
    onerror: null,
    terminate: function () {},
    addEventListener: function () {},
    removeEventListener: function () {},
    postMessage: function () {
      var self = this;
      setTimeout(function () { if (self.onerror) self.onerror(new Event('error')); }, 0);
    },
  };
}
`;

export function crossOriginWorker(): Plugin {
  return {
    name: 'seatlayer-cross-origin-worker',
    // `post` so this sees the code AFTER Vite's own worker plugin has rewritten
    // `new URL('./scene.worker.ts', import.meta.url)` into the hashed asset URL.
    enforce: 'post',
    renderChunk(code) {
      if (!code.includes('new Worker(')) return null;
      return { code: `${HELPER}\n${code.replaceAll('new Worker(', '__slSpawnWorker(')}`, map: null };
    },
  };
}

/**
 * A Vite upgrade that changed how the worker is constructed would silently stop
 * the rewrite from matching, and the failure it prevents is invisible — 3D just
 * stops opening on the CDN. So `verify-cdn-build.mjs` asserts the shipped chunk
 * still contains the blob-shim machinery (`URL.createObjectURL(new Blob(`).
 *
 * The assertion lives in the gate rather than in a build hook for two reasons:
 * the gate reads the bytes that actually ship, and esbuild's minifier runs after
 * this plugin and renames `__slSpawnWorker`, so a name-based marker would not
 * survive to be checked anywhere. The strings the gate looks for are the ones
 * minification cannot remove, because they do work.
 */

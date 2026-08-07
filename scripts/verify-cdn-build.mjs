#!/usr/bin/env node
/**
 * Offline gate on the built CDN tree: lockstep versions, hashes, a real ESM
 * import, and the Worker's routing contract exercised against a fake R2.
 */
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import worker from '../cdn/src/worker.mjs';
import {
  engineSource,
  releaseAssets,
  releasePackages,
  releaseVersion,
  repoRoot,
  sha256,
  walkReleaseFiles,
  RELEASE_ENTRY_FILES,
} from './release-metadata.mjs';

const version = releaseVersion();
const releaseDir = resolve(repoRoot, `cdn/dist/seatlayer-js@${version}`);
const indexDir = resolve(repoRoot, 'cdn/dist/-');
const manifest = JSON.parse(readFileSync(resolve(releaseDir, 'release.json'), 'utf8'));
// The lazy chunks are DELIBERATE and enumerated — CDN bundles can't code-split,
// so each is its own build (cdn/vite.view3d.config.ts, cdn/vite.panorama.config.ts,
// cdn/vite.checkout.config.ts) that the widget loads by URL at the gesture
// needing it. Each also has a byte floor, because a chunk that quietly stops
// bundling its dependencies still produces a plausible-looking file.
const LAZY_CHUNKS = {
  // The 3D venue view (ogl + earcut bundled in), loaded at 3D-open time.
  'seatlayer-view3d.mjs': 200_000,
  // The view-from-seat panorama generator, loaded when a buyer asks for the view.
  'seatlayer-panorama.mjs': 15_000,
  // The hosted-checkout card, loaded when a buyer in a `checkout: 'hosted'`
  // picker presses the CTA.
  'seatlayer-checkout.mjs': 6_000,
};
// A CEILING, and only on the checkout chunk, because it is the one artifact
// whose whole justification is being small. The floors above catch a chunk that
// stopped bundling what it needs; this catches the opposite failure — a single
// value import from @seatlayer/core would pull a second copy of the renderer
// into an asset that is meant to be a few KB of payment UI, and the release
// would otherwise look entirely healthy.
const CHECKOUT_CEILING = 40_000;
const ARTIFACTS = { 'seatlayer.js': 500_000, 'seatlayer.mjs': 500_000, ...LAZY_CHUNKS };

// --- nothing ships unaccounted -------------------------------------------
// This used to be a flat deepEqual against six enumerated filenames. It could
// not survive the scene worker: `new Worker(new URL(…), { type: 'module' })`
// makes Vite emit assets/scene.worker-<hash>.js, and a hashed name cannot be
// written down in advance. The RULE is unchanged — every emitted byte must be
// declared and sha-pinned before it can ship — but a file now qualifies two
// ways: it is an enumerated entry file, or it is in release.json's `assets`
// map. Both halves are checked below, in both directions.
const emitted = walkReleaseFiles(releaseDir);
const assets = releaseAssets(releaseDir); // throws on anything outside assets/<name>.js
assert.deepEqual(
  emitted.filter((file) => !assets.includes(file)).sort(),
  ['release.json', ...Object.keys(ARTIFACTS)].sort(),
  'CDN releases must be self-contained; an unexpected top-level file was emitted',
);
assert.equal(manifest.schemaVersion, 3, 'release.json schema 3 carries the hashed-asset manifest');
assert.deepEqual(
  Object.keys(manifest.assets ?? {}).sort(),
  assets,
  'release.json must account for exactly the hashed assets the build emitted',
);
for (const path of assets) {
  const bytes = readFileSync(resolve(releaseDir, path));
  assert.equal(sha256(bytes), manifest.assets[path].sha256, `${path} sha256 does not match release.json`);
  assert.equal(bytes.byteLength, manifest.assets[path].bytes, `${path} size does not match release.json`);
  assert.ok(bytes.byteLength > 0, `${path} is empty`);
}
assert.deepEqual(Object.keys(manifest.files).sort(), [...RELEASE_ENTRY_FILES].sort());

// --- the scene worker must be REACHABLE, not merely present ---------------
// prepareVenue3D falls back to the main thread on any worker failure, silently,
// so a worker that 404s costs a frame budget and says nothing. Two things have
// to hold: the asset exists, and the chunk that starts it references it by a
// RELATIVE URL. With Vite's default `base: '/'` the rewrite is root-absolute
// (`/assets/…`), which resolves to cdn.seatlayer.io/assets/… — outside the
// pinned directory, where we publish nothing.
const view3d = readFileSync(resolve(releaseDir, 'seatlayer-view3d.mjs'), 'utf8');
const sceneWorker = assets.find((path) => path.includes('scene.worker'));
assert.ok(sceneWorker, 'the 3D chunk must emit a scene worker asset');
assert.ok(
  view3d.includes(`new URL("${sceneWorker}", import.meta.url)`),
  `seatlayer-view3d.mjs must reach ${sceneWorker} via a URL relative to import.meta.url; `
  + 'a root-absolute /assets/… rewrite 404s on the CDN and prepareVenue3D silently '
  + 'falls back to the main thread (check `base` in cdn/vite.view3d.config.ts)',
);
assert.ok(
  !/new URL\("\/assets\//.test(view3d),
  'seatlayer-view3d.mjs contains a root-absolute /assets/ URL, which the CDN does not serve',
);
// …and a correct URL is still not enough. The `Worker` constructor refuses a
// CROSS-ORIGIN script URL outright — CORS does not enter into it — and refuses
// it by throwing, which rejects prepareVenue3D instead of taking its
// main-thread fallback. cdn/crossOriginWorker.ts rewrites construction to try
// the direct worker, then a same-origin blob that imports this asset, then a
// stub that reports failure the way a worker would. esbuild minifies after that
// plugin and renames its helper, so the marker has to be machinery that does
// work rather than a name.
for (const marker of ['URL.createObjectURL(new Blob(', 'revokeObjectURL', '"import "']) {
  assert.ok(
    view3d.includes(marker),
    `seatlayer-view3d.mjs has lost the cross-origin worker shim (${marker}); the scene `
    + 'worker cannot start from the CDN without it — see cdn/crossOriginWorker.ts',
  );
}

assert.equal(manifest.version, version);
assert.equal(manifest.tag, `v${version}`);
assert.deepEqual(manifest.packages, Object.fromEntries(releasePackages().map((pkg) => [pkg.name, pkg.version])));
assert.deepEqual(manifest.source.engine, engineSource());
assert.match(manifest.source.commit, /^[0-9a-f]{40}$/);

for (const [name, floor] of Object.entries(ARTIFACTS)) {
  const releaseBytes = readFileSync(resolve(releaseDir, name));
  assert.ok(releaseBytes.byteLength > floor, `${name} unexpectedly small`);
  assert.equal(sha256(releaseBytes), manifest.files[name].sha256);
  assert.equal(releaseBytes.byteLength, manifest.files[name].bytes);
}

assert.ok(
  readFileSync(resolve(releaseDir, 'seatlayer-checkout.mjs')).byteLength < CHECKOUT_CEILING,
  `seatlayer-checkout.mjs is over ${CHECKOUT_CEILING} bytes — something now imports the engine `
  + 'from packages/js/src/hostedCheckout.ts, and every buyer who reaches checkout pays for it',
);

// The mutable channel must never be a byte copy — nothing but the version index
// may sit outside the pinned directory.
assert.deepEqual(
  readdirSync(resolve(repoRoot, 'cdn/dist')).filter((entry) => entry !== `seatlayer-js@${version}` && entry !== '-'),
  [],
  'CDN dist must contain only the pinned directory and the version index; alias byte-copies are forbidden',
);

const index = JSON.parse(readFileSync(resolve(indexDir, 'versions.json'), 'utf8'));
assert.equal(index.tags.latest, version, 'versions.json must tag the release being built as latest');
assert.ok(index.versions.includes(version), 'versions.json must list the release being built');
assert.deepEqual(index.versions, [...index.versions].sort((a, b) => {
  const l = a.split('.').map(Number); const r = b.split('.').map(Number);
  return (r[0] - l[0]) || (r[1] - l[1]) || (r[2] - l[2]);
}), 'versions.json must be newest-first');

const esm = await import(`${pathToFileURL(resolve(releaseDir, 'seatlayer.mjs')).href}?verify=${Date.now()}`);
for (const name of ['SeatingChart', 'SeatPicker', 'EmbeddedDesigner', 'SeatManager']) {
  assert.equal(typeof esm[name], 'function', `CDN ESM missing ${name}`);
}
// CDN-only superset: the headless review entry the Browser Rendering worker calls.
assert.equal(typeof esm.renderChartDocument, 'function', 'CDN ESM missing renderChartDocument');
assert.equal(esm.BUYER_RENDERER_CONTRACT_VERSION, 4, 'buyer renderer contract version changed; the review worker hard-validates this');
assert.equal(esm.version, version);

// --- IIFE global contract -----------------------------------------------
// Cloudflare Browser Rendering calls `window.seatlayer.renderChartDocument(...)`
// against this exact artifact, and older embeds still reference `window.seatmap`.
// Both are live consumers, so assert the real global rather than trusting config.
const { JSDOM } = await import('jsdom');
// `runScripts` is required for window.eval to evaluate INSIDE the jsdom realm;
// without it the bundle would run in this process's scope and set no globals.
const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  runScripts: 'outside-only',
  pretendToBeVisual: true,
});
dom.window.eval(readFileSync(resolve(releaseDir, 'seatlayer.js'), 'utf8'));
const globalApi = dom.window.seatlayer;
assert.ok(globalApi, 'IIFE must expose the `seatlayer` global');
assert.equal(dom.window.seatmap, globalApi, '`window.seatmap` back-compat alias must point at `window.seatlayer`');
assert.equal(typeof globalApi.renderChartDocument, 'function', 'window.seatlayer.renderChartDocument is a live Browser Rendering contract');
assert.equal(globalApi.BUYER_RENDERER_CONTRACT_VERSION, 4, 'the review worker hard-validates this contract version');
for (const name of ['SeatingChart', 'SeatPicker', 'EmbeddedDesigner', 'SeatManager']) {
  assert.equal(typeof globalApi[name], 'function', `CDN IIFE missing ${name}`);
}
dom.window.close();

// --- Worker routing contract --------------------------------------------
const releaseJson = readFileSync(resolve(releaseDir, 'release.json'));
const versionsJson = readFileSync(resolve(indexDir, 'versions.json'));
const fakeObject = (bytes, contentType = 'application/json; charset=utf-8') => ({
  body: new Blob([bytes]).stream(),
  size: bytes.byteLength,
  httpEtag: '"release-test"',
  httpMetadata: contentType ? { contentType } : {},
  writeHttpMetadata(headers) {
    if (this.httpMetadata.contentType) headers.set('Content-Type', this.httpMetadata.contentType);
  },
  async json() { return JSON.parse(bytes.toString('utf8')); },
});
const cache = new Map();
globalThis.caches = {
  default: {
    async match(request) { return cache.get(request.url)?.clone(); },
    async put(request, response) { cache.set(request.url, response.clone()); },
  },
};
const pending = [];
const ctx = { waitUntil(promise) { pending.push(promise); } };
// Only the canonical key, a LEGACY-only key, and the index exist. The legacy key
// proves the compatibility fallback; it is deliberately not present under the
// canonical prefix.
const legacyOnlyVersion = '0.17.0';
const store = {
  [`seatlayer-js@${version}/release.json`]: releaseJson,
  [`sdk/v${legacyOnlyVersion}/release.json`]: releaseJson,
  'sdk/v1/seatmap.js': releaseJson,
  '-/versions.json': versionsJson,
  // One key per emitted artifact, so the Worker's filename allowlist is checked
  // against what this release actually produces rather than against a list that
  // was true when it was written.
  ...Object.fromEntries(Object.keys(ARTIFACTS).map((name) => [`seatlayer-js@${version}/${name}`, releaseJson])),
  // Same idea for the hashed assets: keyed off what this build emitted, so a new
  // asset shape is checked against the Worker rather than assumed to route.
  ...Object.fromEntries(assets.map((path) => [`seatlayer-js@${version}/${path}`, releaseJson])),
};
// Assets are stored WITHOUT an object content type, so the Worker's extension
// mapping is what has to produce `text/javascript` — a module worker whose script
// arrives as anything else is refused by the browser before it runs a line.
const assetKeys = new Set(assets.map((path) => `seatlayer-js@${version}/${path}`));
const objectFor = (key) => (assetKeys.has(key) ? fakeObject(store[key], null) : fakeObject(store[key]));
const env = {
  SDK_RELEASES: {
    async get(key) { return store[key] ? objectFor(key) : null; },
    async head(key) { return store[key] ? objectFor(key) : null; },
  },
};
const fetchWorker = (path, init) => worker.fetch(new Request(`https://cdn.seatlayer.io${path}`, init), env, ctx);

// 1. Canonical pinned artifact.
const pinned = await fetchWorker(`/seatlayer-js@${version}/release.json`);
assert.equal(pinned.status, 200);
assert.equal(pinned.headers.get('access-control-allow-origin'), '*');
assert.equal(pinned.headers.get('cache-control'), 'public, s-maxage=31536000, max-age=3600, immutable');
assert.equal((await pinned.json()).version, version);

// 1b. EVERY emitted artifact must be on the Worker's filename allowlist. Adding
// a lazy chunk to the build without adding it to FILE_NAMES ships a release
// whose widget 404s the moment a buyer reaches for the feature it holds.
for (const name of Object.keys(ARTIFACTS)) {
  const served = await fetchWorker(`/seatlayer-js@${version}/${name}`);
  assert.equal(
    served.status,
    200,
    `the CDN Worker will not serve ${name} — add it to FILE_NAMES in cdn/src/worker.mjs`,
  );
}

// 1c. Hashed assets must route, carry CORS, and arrive as JavaScript. The scene
// worker is fetched cross-origin by `new Worker(url, { type: 'module' })` from a
// page on the organizer's domain; a module worker is a CORS request, so a
// missing Access-Control-Allow-Origin or a non-JS content type kills it — and
// prepareVenue3D swallows that into a main-thread fallback.
for (const path of assets) {
  const served = await fetchWorker(`/seatlayer-js@${version}/${path}`);
  assert.equal(served.status, 200, `the CDN Worker will not serve ${path}`);
  assert.equal(served.headers.get('access-control-allow-origin'), '*', `${path} must be CORS-readable`);
  assert.equal(served.headers.get('cross-origin-resource-policy'), 'cross-origin');
  assert.equal(
    served.headers.get('content-type'),
    'text/javascript; charset=utf-8',
    `${path} must be served as JavaScript or the module worker is refused before it runs`,
  );
  assert.equal(served.headers.get('cache-control'), 'public, s-maxage=31536000, max-age=3600, immutable');
}
// The mutable channel must NOT resolve hashed names: a hashed URL is only ever
// produced by the build that emitted it, so an alias-shaped one is a mistake.
assert.equal((await fetchWorker(`/seatlayer-js@0/${assets[0]}`)).status, 404);
// URL parsing already collapses a literal `../`, so the traversal that has to be
// refused explicitly is the percent-encoded one the Worker decodes itself.
assert.equal(
  (await fetchWorker(`/seatlayer-js@${version}/assets/%2e%2e%2fsecret.js`)).status,
  404,
  'the asset prefix must not open a traversal',
);
assert.equal(
  (await fetchWorker(`/seatlayer-js@${version}/assets/deep/nested.js`)).status,
  404,
  'assets are one flat directory',
);
assert.equal(
  (await fetchWorker(`/seatlayer-js@${version}/assets/secrets.env`)).status,
  404,
  'only .js/.mjs asset names resolve',
);

// 2. Pre-reshape versions resolve at the canonical URL via the legacy fallback.
const fallback = await fetchWorker(`/seatlayer-js@${legacyOnlyVersion}/release.json`);
assert.equal(fallback.status, 200, 'historical versions must resolve at the canonical URL');
assert.equal(fallback.headers.get('cache-control'), 'public, s-maxage=31536000, max-age=3600, immutable');

// 3. Major alias is a redirect to the pinned URL, never a copy.
const alias = await fetchWorker('/seatlayer-js@0/seatlayer.js');
assert.equal(alias.status, 302, 'the mutable channel must redirect, not serve bytes');
assert.equal(alias.headers.get('location'), `https://cdn.seatlayer.io/seatlayer-js@${version}/seatlayer.js`);
assert.equal(alias.headers.get('cache-control'), 'public, max-age=600, s-maxage=60');
assert.equal(alias.headers.get('x-seatlayer-version'), version);

const latest = await fetchWorker('/seatlayer-js@latest/seatlayer.mjs');
assert.equal(latest.status, 302);
assert.equal(latest.headers.get('location'), `https://cdn.seatlayer.io/seatlayer-js@${version}/seatlayer.mjs`);

// 4. Version index.
const served = await fetchWorker('/-/versions.json');
assert.equal(served.status, 200);
assert.equal(served.headers.get('cache-control'), 'public, max-age=60');
assert.equal((await served.json()).tags.latest, version);

// 5. Legacy shapes stay served (never emitted again, but permanently resolvable).
const legacy = await fetchWorker('/sdk/v1/seatmap.js');
assert.equal(legacy.status, 200, 'legacy /sdk/v1 objects must stay resolvable');
assert.equal(legacy.headers.get('cache-control'), 'public, max-age=300, must-revalidate');

await Promise.all(pending);

// 6. Rejections.
assert.equal((await fetchWorker('/private/file')).status, 404);
assert.equal((await fetchWorker(`/seatlayer-js@${version}/../secret`)).status, 404);
assert.equal((await fetchWorker(`/seatlayer-js@${version}/evil.js`)).status, 404, 'only known filenames are served');
assert.equal((await fetchWorker('/seatlayer-js@9/seatlayer.js')).status, 404, 'unpublished major must not resolve');
assert.equal((await fetchWorker(`/seatlayer-js@${version}/release.json`, { method: 'POST' })).status, 405);

console.log(`✓ CDN seatlayer-js@${version} is lockstep, hashed, importable, and Worker-routable`);
console.log('  canonical pinned + legacy fallback + redirect alias + versions.json all verified');

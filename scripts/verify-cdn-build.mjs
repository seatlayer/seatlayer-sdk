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
import { engineSource, releasePackages, releaseVersion, repoRoot, sha256 } from './release-metadata.mjs';

const version = releaseVersion();
const releaseDir = resolve(repoRoot, `cdn/dist/seatlayer-js@${version}`);
const indexDir = resolve(repoRoot, 'cdn/dist/-');
const manifest = JSON.parse(readFileSync(resolve(releaseDir, 'release.json'), 'utf8'));
assert.deepEqual(
  readdirSync(releaseDir).sort(),
  ['release.json', 'seatlayer.js', 'seatlayer.mjs'],
  'CDN releases must be self-contained; unexpected lazy chunks were emitted',
);

assert.equal(manifest.version, version);
assert.equal(manifest.tag, `v${version}`);
assert.deepEqual(manifest.packages, Object.fromEntries(releasePackages().map((pkg) => [pkg.name, pkg.version])));
assert.deepEqual(manifest.source.engine, engineSource());
assert.match(manifest.source.commit, /^[0-9a-f]{40}$/);

for (const name of ['seatlayer.js', 'seatlayer.mjs']) {
  const releaseBytes = readFileSync(resolve(releaseDir, name));
  assert.ok(releaseBytes.byteLength > 50_000, `${name} unexpectedly small`);
  assert.equal(sha256(releaseBytes), manifest.files[name].sha256);
  assert.equal(releaseBytes.byteLength, manifest.files[name].bytes);
}

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
const fakeObject = (bytes) => ({
  body: new Blob([bytes]).stream(),
  size: bytes.byteLength,
  httpEtag: '"release-test"',
  httpMetadata: { contentType: 'application/json; charset=utf-8' },
  writeHttpMetadata(headers) { headers.set('Content-Type', this.httpMetadata.contentType); },
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
};
const env = {
  SDK_RELEASES: {
    async get(key) { return store[key] ? fakeObject(store[key]) : null; },
    async head(key) { return store[key] ? fakeObject(store[key]) : null; },
  },
};
const fetchWorker = (path, init) => worker.fetch(new Request(`https://cdn.seatlayer.io${path}`, init), env, ctx);

// 1. Canonical pinned artifact.
const pinned = await fetchWorker(`/seatlayer-js@${version}/release.json`);
assert.equal(pinned.status, 200);
assert.equal(pinned.headers.get('access-control-allow-origin'), '*');
assert.equal(pinned.headers.get('cache-control'), 'public, s-maxage=31536000, max-age=3600, immutable');
assert.equal((await pinned.json()).version, version);

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

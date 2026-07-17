#!/usr/bin/env node
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import worker from '../cdn/src/worker.mjs';
import { engineSource, releasePackages, releaseVersion, repoRoot, sha256 } from './release-metadata.mjs';

const version = releaseVersion();
const releaseDir = resolve(repoRoot, `cdn/dist/sdk/v${version}`);
const aliasDir = resolve(repoRoot, 'cdn/dist/sdk/v1');
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

for (const [name, alias] of [['seatlayer.js', 'seatmap.js'], ['seatlayer.mjs', 'seatmap.mjs']]) {
  const releaseBytes = readFileSync(resolve(releaseDir, name));
  const aliasBytes = readFileSync(resolve(aliasDir, alias));
  assert.ok(releaseBytes.byteLength > 50_000, `${name} unexpectedly small`);
  assert.equal(sha256(releaseBytes), manifest.files[name].sha256);
  assert.equal(releaseBytes.byteLength, manifest.files[name].bytes);
  assert.deepEqual(aliasBytes, releaseBytes);
}
assert.deepEqual(
  JSON.parse(readFileSync(resolve(aliasDir, 'release.json'), 'utf8')),
  manifest,
);

const esm = await import(`${pathToFileURL(resolve(releaseDir, 'seatlayer.mjs')).href}?verify=${Date.now()}`);
for (const name of ['SeatingChart', 'SeatPicker', 'EmbeddedDesigner', 'SeatManager']) {
  assert.equal(typeof esm[name], 'function', `CDN ESM missing ${name}`);
}
assert.equal(esm.version, version);

const releaseJson = readFileSync(resolve(releaseDir, 'release.json'));
const fakeObject = () => ({
  body: new Blob([releaseJson]).stream(),
  size: releaseJson.byteLength,
  httpEtag: '"release-test"',
  httpMetadata: { contentType: 'application/json; charset=utf-8' },
  writeHttpMetadata(headers) { headers.set('Content-Type', this.httpMetadata.contentType); },
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
const env = {
  SDK_RELEASES: {
    async get(key) { return key === `sdk/v${version}/release.json` ? fakeObject() : null; },
    async head(key) { return key === `sdk/v${version}/release.json` ? fakeObject() : null; },
  },
};
const served = await worker.fetch(new Request(`https://cdn.seatlayer.io/sdk/v${version}/release.json`), env, ctx);
assert.equal(served.status, 200);
assert.equal(served.headers.get('access-control-allow-origin'), '*');
assert.equal(served.headers.get('cache-control'), 'public, max-age=31536000, immutable');
assert.equal((await served.json()).version, version);
await Promise.all(pending);
assert.equal((await worker.fetch(new Request('https://cdn.seatlayer.io/private/file'), env, ctx)).status, 404);
assert.equal((await worker.fetch(new Request(`https://cdn.seatlayer.io/sdk/v${version}/release.json`, {
  method: 'POST',
}), env, ctx)).status, 405);

console.log(`✓ CDN v${version} is lockstep, hashed, importable, and Worker-routable`);

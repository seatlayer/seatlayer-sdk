#!/usr/bin/env node
/**
 * Upload the CDN release to R2, in two gated stages.
 *
 *   immutable  the pinned artifacts at seatlayer-js@<x.y.z>/…
 *   index      the version index at -/versions.json
 *
 * `index` is the promotion step. Publishing versions.json with the new `latest`
 * is what moves the mutable `seatlayer-js@<major>` channel, because the Worker
 * resolves that channel by reading this file and issuing a 302. Nothing is ever
 * byte-copied to an alias path, so the alias cannot diverge from the pinned
 * artifact and cannot be served at a different cache age.
 *
 * Ordering matters: run `immutable` first (and verify it), then `index`. The
 * alias then flips to a version that is already provably live.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { releaseVersion, repoRoot, sha256 } from './release-metadata.mjs';

const mode = process.argv[2];
if (mode !== 'immutable' && mode !== 'index') {
  throw new Error('Usage: node scripts/upload-cdn.mjs <immutable|index>');
}
if (process.env.CDN_UPLOAD_CONFIRMED !== '1' && process.env.DRY_RUN !== '1') {
  throw new Error('Set CDN_UPLOAD_CONFIRMED=1 to upload release objects');
}

const version = releaseVersion();
const bucket = process.env.SEATLAYER_CDN_BUCKET || 'seatlayer-sdk-releases';
const origin = (process.env.CDN_ORIGIN || 'https://cdn.seatlayer.io').replace(/\/+$/, '');
const root = mode === 'immutable' ? `seatlayer-js@${version}` : '-';
const localRoot = resolve(repoRoot, 'cdn/dist', root);
const names = mode === 'immutable'
  ? ['seatlayer.js', 'seatlayer.mjs', 'release.json']
  : ['versions.json'];

// The Worker sets response Cache-Control explicitly; these are the object-level
// values, kept consistent so a direct-to-R2 read behaves the same way.
const cacheControl = mode === 'immutable'
  ? 'public, s-maxage=31536000, max-age=3600, immutable'
  : 'public, max-age=60';

function mime(name) {
  if (name.endsWith('.json')) return 'application/json; charset=utf-8';
  return 'text/javascript; charset=utf-8';
}

async function immutableAlreadyMatches(name, bytes) {
  const url = `${origin}/${root}/${name}?__seatlayer_verify=${Date.now()}`;
  const response = await fetch(url, { headers: { Accept: mime(name) } });
  if (response.status === 404) return false;
  const type = response.headers.get('content-type') || '';
  // Before the dedicated CDN Worker is installed, the dashboard SPA returns
  // index.html for unknown SDK paths. That is a miss, not an immutable object.
  if (response.ok && type.includes('text/html')) return false;
  if (!response.ok) throw new Error(`Cannot inspect existing immutable object ${url}: HTTP ${response.status}`);
  const remote = Buffer.from(await response.arrayBuffer());
  if (sha256(remote) !== sha256(bytes)) {
    throw new Error(`Refusing to overwrite immutable CDN object ${root}/${name} with different bytes`);
  }
  return true;
}

for (const name of names) {
  const file = resolve(localRoot, name);
  const bytes = readFileSync(file);
  if (process.env.DRY_RUN === '1') {
    console.log(`DRY RUN upload ${bucket}/${root}/${name}`);
    continue;
  }
  if (mode === 'immutable' && await immutableAlreadyMatches(name, bytes)) {
    console.log(`✓ immutable object already matches ${root}/${name}`);
    continue;
  }

  const args = [
    'exec', 'wrangler', 'r2', 'object', 'put', `${bucket}/${root}/${name}`,
    '--file', file,
    '--remote',
    '--content-type', mime(name),
    '--cache-control', cacheControl,
  ];
  const result = spawnSync('pnpm', args, { cwd: repoRoot, stdio: 'inherit' });
  if (result.status !== 0) throw new Error(`R2 upload failed for ${root}/${name}`);
  console.log(`✓ uploaded ${root}/${name}`);
}

#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { releaseVersion, repoRoot, sha256 } from './release-metadata.mjs';

const mode = process.argv[2] || 'full';
if (mode !== 'immutable' && mode !== 'full') throw new Error('Mode must be immutable or full');
const version = releaseVersion();
const origin = (process.env.CDN_ORIGIN || 'https://cdn.seatlayer.io').replace(/\/+$/, '');
const localManifest = JSON.parse(readFileSync(resolve(repoRoot, `cdn/dist/sdk/v${version}/release.json`), 'utf8'));

const wait = (ms) => new Promise((resolveWait) => setTimeout(resolveWait, ms));
async function eventually(label, check) {
  let last;
  for (let attempt = 1; attempt <= 20; attempt += 1) {
    try {
      await check();
      console.log(`✓ ${label}`);
      return;
    } catch (error) {
      last = error;
      if (attempt < 20) await wait(3_000);
    }
  }
  throw new Error(`${label} did not verify: ${last}`);
}

async function get(path) {
  const separator = path.includes('?') ? '&' : '?';
  const response = await fetch(`${origin}${path}${separator}__seatlayer_verify=${Date.now()}`, {
    headers: { 'Cache-Control': 'no-cache' },
  });
  if (!response.ok) throw new Error(`${path} returned HTTP ${response.status}`);
  if ((response.headers.get('content-type') || '').includes('text/html')) {
    throw new Error(`${path} returned HTML instead of an SDK artifact`);
  }
  return response;
}

async function verifyTree(root, aliases) {
  const manifestResponse = await get(`${root}/release.json`);
  const remoteManifest = await manifestResponse.json();
  if (JSON.stringify(remoteManifest) !== JSON.stringify(localManifest)) {
    throw new Error(`${root}/release.json differs from the local release manifest`);
  }
  for (const [remoteName, releaseName] of Object.entries(aliases)) {
    const bytes = Buffer.from(await (await get(`${root}/${remoteName}`)).arrayBuffer());
    if (sha256(bytes) !== localManifest.files[releaseName].sha256) {
      throw new Error(`${root}/${remoteName} sha256 mismatch`);
    }
  }
}

await eventually(`immutable CDN v${version}`, () => verifyTree(`/sdk/v${version}`, {
  'seatlayer.js': 'seatlayer.js',
  'seatlayer.mjs': 'seatlayer.mjs',
}));
if (mode === 'full') {
  await eventually(`mutable CDN v1 alias points to v${version}`, () => verifyTree('/sdk/v1', {
    'seatmap.js': 'seatlayer.js',
    'seatmap.mjs': 'seatlayer.mjs',
  }));
}

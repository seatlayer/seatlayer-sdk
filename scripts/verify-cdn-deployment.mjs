#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { releaseVersion, repoRoot, sha256 } from './release-metadata.mjs';

const mode = process.argv[2] || 'full';
if (mode !== 'immutable' && mode !== 'full') throw new Error('Mode must be immutable or full');
const version = releaseVersion();
const origin = (process.env.CDN_ORIGIN || 'https://cdn.seatlayer.io').replace(/\/+$/, '');
const localManifest = JSON.parse(readFileSync(resolve(repoRoot, `cdn/dist/seatlayer-js@${version}/release.json`), 'utf8'));

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

const pinnedRoot = `/seatlayer-js@${version}`;
const major = version.split('.')[0];

async function verifyPinned() {
  const remoteManifest = await (await get(`${pinnedRoot}/release.json`)).json();
  if (JSON.stringify(remoteManifest) !== JSON.stringify(localManifest)) {
    throw new Error(`${pinnedRoot}/release.json differs from the local release manifest`);
  }
  for (const name of ['seatlayer.js', 'seatlayer.mjs']) {
    const bytes = Buffer.from(await (await get(`${pinnedRoot}/${name}`)).arrayBuffer());
    if (sha256(bytes) !== localManifest.files[name].sha256) {
      throw new Error(`${pinnedRoot}/${name} sha256 mismatch`);
    }
  }
}

/**
 * The mutable channel must be a redirect, not bytes. Verifying the *redirect
 * target* (rather than comparing downloaded bytes) is the whole point of the
 * design: there is only one artifact, so there is nothing that can diverge.
 */
async function verifyAlias() {
  const index = await (await get('/-/versions.json')).json();
  if (index.tags?.latest !== version) {
    throw new Error(`/-/versions.json latest is ${index.tags?.latest}, expected ${version}`);
  }
  if (!index.versions?.includes(version)) {
    throw new Error(`/-/versions.json does not list ${version}`);
  }
  for (const name of ['seatlayer.js', 'seatlayer.mjs']) {
    const url = `${origin}/seatlayer-js@${major}/${name}?__seatlayer_verify=${Date.now()}`;
    const response = await fetch(url, { redirect: 'manual', headers: { 'Cache-Control': 'no-cache' } });
    if (response.status !== 302) {
      throw new Error(`seatlayer-js@${major}/${name} returned HTTP ${response.status}; the alias must be a 302, never a byte copy`);
    }
    const location = response.headers.get('location') || '';
    if (!location.endsWith(`/seatlayer-js@${version}/${name}`)) {
      throw new Error(`seatlayer-js@${major}/${name} redirects to ${location}, expected the pinned v${version} URL`);
    }
  }
}

await eventually(`immutable CDN seatlayer-js@${version}`, verifyPinned);
if (mode === 'full') {
  await eventually(`mutable seatlayer-js@${major} alias resolves to ${version}`, verifyAlias);
}

#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { repoRoot, sha256 } from './release-metadata.mjs';

if (process.env.CDN_UPLOAD_CONFIRMED !== '1' && process.env.DRY_RUN !== '1') {
  throw new Error('Set CDN_UPLOAD_CONFIRMED=1 to migrate legacy CDN objects');
}
const seatmapRepo = resolve(process.env.SEATMAP_REPO || resolve(repoRoot, '..', 'seatmap'));
const sdkRoot = resolve(seatmapRepo, 'public/sdk');
if (!existsSync(sdkRoot)) throw new Error(`Legacy SDK directory not found: ${sdkRoot}`);

const bucket = process.env.SEATLAYER_CDN_BUCKET || 'seatlayer-sdk-releases';
const origin = (process.env.CDN_ORIGIN || 'https://cdn.seatlayer.io').replace(/\/+$/, '');
const versions = readdirSync(sdkRoot, { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && /^v\d+\.\d+\.\d+$/.test(entry.name))
  .map((entry) => entry.name)
  .sort((left, right) => left.localeCompare(right, undefined, { numeric: true }));

for (const version of versions) {
  for (const name of ['seatlayer.js', 'seatlayer.mjs']) {
    const file = resolve(sdkRoot, version, name);
    if (!existsSync(file)) continue;
    const local = readFileSync(file);
    let uploadFile = file;
    let temporaryDirectory;
    if (process.env.DRY_RUN !== '1') {
      const response = await fetch(`${origin}/sdk/${version}/${name}?__seatlayer_verify=${Date.now()}`);
      if (!response.ok) throw new Error(`Cannot verify live legacy object sdk/${version}/${name}: HTTP ${response.status}`);
      const type = response.headers.get('content-type') || '';
      if (type.includes('text/html')) {
        console.warn(`! live sdk/${version}/${name} is currently an SPA fallback; restoring the committed artifact`);
      } else {
        const remote = Buffer.from(await response.arrayBuffer());
        if (sha256(remote) !== sha256(local)) {
          // A published version is immutable even when a later repository commit
          // accidentally reused its path. Preserve the bytes clients receive today.
          temporaryDirectory = mkdtempSync(resolve(tmpdir(), 'seatlayer-cdn-legacy-'));
          uploadFile = resolve(temporaryDirectory, name);
          writeFileSync(uploadFile, remote);
          console.warn(`! committed sdk/${version}/${name} differs from the published object; preserving the live artifact`);
        }
      }
    }
    const objectPath = `${bucket}/sdk/${version}/${name}`;
    if (process.env.DRY_RUN === '1') {
      console.log(`DRY RUN migrate ${objectPath}`);
      continue;
    }
    try {
      const result = spawnSync('pnpm', [
        'exec', 'wrangler', 'r2', 'object', 'put', objectPath,
        '--file', uploadFile,
        '--remote',
        '--content-type', 'text/javascript; charset=utf-8',
        '--cache-control', 'public, max-age=31536000, immutable',
      ], { cwd: repoRoot, stdio: 'inherit' });
      if (result.status !== 0) throw new Error(`Failed to migrate ${objectPath}`);
      console.log(`✓ migrated sdk/${version}/${name}`);
    } finally {
      if (temporaryDirectory) rmSync(temporaryDirectory, { recursive: true, force: true });
    }
  }
}

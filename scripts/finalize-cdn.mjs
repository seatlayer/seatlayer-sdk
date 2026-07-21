#!/usr/bin/env node
/**
 * Turn the raw vite output into the exact tree we upload to R2.
 *
 *   cdn/dist/seatlayer-js@<x.y.z>/{seatlayer.js,seatlayer.mjs,release.json}
 *   cdn/dist/-/versions.json
 *
 * There is deliberately NO alias directory. The mutable `seatlayer-js@<major>`
 * channel is a 302 served by the Worker off versions.json, not a byte copy — a
 * copied alias is a second artifact that can diverge from the pinned one and
 * cache at a different age. See cdn/src/worker.mjs.
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  engineSource,
  releasePackages,
  releaseVersion,
  repoRoot,
  sha256,
  sourceCommit,
} from './release-metadata.mjs';

const version = releaseVersion();
const releaseDir = resolve(repoRoot, `cdn/dist/seatlayer-js@${version}`);
const indexDir = resolve(repoRoot, 'cdn/dist/-');
const ledgerPath = resolve(repoRoot, 'cdn/versions.json');
const files = {};

for (const name of ['seatlayer.js', 'seatlayer.mjs']) {
  const bytes = readFileSync(resolve(releaseDir, name));
  files[name] = { sha256: sha256(bytes), bytes: bytes.byteLength };
}

const manifest = {
  schemaVersion: 2,
  version,
  tag: `v${version}`,
  source: {
    repository: 'seatlayer/seatlayer-sdk',
    commit: sourceCommit(),
    engine: engineSource(),
  },
  packages: Object.fromEntries(releasePackages().map((pkg) => [pkg.name, pkg.version])),
  files,
};

const json = `${JSON.stringify(manifest, null, 2)}\n`;
writeFileSync(resolve(releaseDir, 'release.json'), json);

// --- version index -------------------------------------------------------
// Shape mirrors what jsDelivr/cdnjs/npm return, so an agent that has seen any
// of those recognises this one without reading our docs.
function compareVersions(left, right) {
  const a = left.split('.').map(Number);
  const b = right.split('.').map(Number);
  for (let i = 0; i < 3; i += 1) if (a[i] !== b[i]) return a[i] - b[i];
  return 0;
}

const ledger = JSON.parse(readFileSync(ledgerPath, 'utf8'));
const published = Array.isArray(ledger.versions) ? ledger.versions : [];
const versions = [...new Set([...published, version])]
  .filter((candidate) => /^\d+\.\d+\.\d+$/.test(candidate))
  .sort(compareVersions)
  .reverse(); // newest first, like jsDelivr

const index = { name: 'seatlayer-js', tags: { latest: version }, versions };

rmSync(indexDir, { recursive: true, force: true });
mkdirSync(indexDir, { recursive: true });
writeFileSync(resolve(indexDir, 'versions.json'), `${JSON.stringify(index, null, 2)}\n`);

// Keep the committed ledger in step so the next release builds on this one even
// if it happens from a different machine.
if (!published.includes(version) || ledger.tags?.latest !== version) {
  writeFileSync(ledgerPath, `${JSON.stringify({ ...ledger, tags: { ...ledger.tags, latest: version }, versions }, null, 2)}\n`);
  console.log(`✓ recorded v${version} in cdn/versions.json (commit this)`);
}

console.log(`✓ finalized CDN seatlayer-js@${version} from ${manifest.source.commit}`);
for (const [name, meta] of Object.entries(files)) console.log(`  ${name} ${meta.bytes} bytes sha256:${meta.sha256}`);
console.log(`  versions.json → latest=${version}, ${versions.length} versions`);

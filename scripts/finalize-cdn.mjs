#!/usr/bin/env node
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
const releaseDir = resolve(repoRoot, `cdn/dist/sdk/v${version}`);
const aliasDir = resolve(repoRoot, 'cdn/dist/sdk/v1');
const files = {};

for (const name of ['seatlayer.js', 'seatlayer.mjs']) {
  const bytes = readFileSync(resolve(releaseDir, name));
  files[name] = { sha256: sha256(bytes), bytes: bytes.byteLength };
}

const manifest = {
  schemaVersion: 1,
  version,
  tag: `v${version}`,
  source: {
    repository: 'seatlayer/seatlayer-sdk',
    commit: sourceCommit(),
    engine: engineSource(),
  },
  packages: Object.fromEntries(releasePackages().map((pkg) => [pkg.name, pkg.version])),
  files,
  aliases: {
    'seatmap.js': 'seatlayer.js',
    'seatmap.mjs': 'seatlayer.mjs',
  },
};

rmSync(aliasDir, { recursive: true, force: true });
mkdirSync(aliasDir, { recursive: true });
copyFileSync(resolve(releaseDir, 'seatlayer.js'), resolve(aliasDir, 'seatmap.js'));
copyFileSync(resolve(releaseDir, 'seatlayer.mjs'), resolve(aliasDir, 'seatmap.mjs'));
const json = `${JSON.stringify(manifest, null, 2)}\n`;
writeFileSync(resolve(releaseDir, 'release.json'), json);
writeFileSync(resolve(aliasDir, 'release.json'), json);

console.log(`✓ finalized CDN v${version} from ${manifest.source.commit}`);
for (const [name, meta] of Object.entries(files)) console.log(`  ${name} ${meta.bytes} bytes sha256:${meta.sha256}`);

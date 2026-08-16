#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

if (process.env.RELEASE_PUBLISH_CONFIRMED !== '1') {
  throw new Error('Set RELEASE_PUBLISH_CONFIRMED=1 to publish public wrappers');
}
const packagePaths = ['packages/react/package.json', 'packages/vue/package.json', 'packages/angular/package.json'];
for (const path of packagePaths) {
  const pkg = JSON.parse(readFileSync(resolve(path), 'utf8'));
  const existing = spawnSync('npm', ['view', `${pkg.name}@${pkg.version}`, 'version', '--json'], {
    encoding: 'utf8',
  });
  if (existing.status === 0 && JSON.parse(existing.stdout || 'null') === pkg.version) {
    console.log(`✓ ${pkg.name}@${pkg.version} already exists`);
    continue;
  }
  const error = `${existing.stdout || ''}\n${existing.stderr || ''}`;
  if (existing.status !== 0 && !/E404|404 Not Found/.test(error)) {
    throw new Error(`npm lookup failed for ${pkg.name}@${pkg.version}: ${error.trim()}`);
  }
  const result = spawnSync('pnpm', [
    '--filter', pkg.name, 'publish', '--access', 'public', '--no-git-checks', '--provenance',
  ], { stdio: 'inherit' });
  if (result.status !== 0) throw new Error(`npm publish failed for ${pkg.name}@${pkg.version}`);
  console.log(`✓ published ${pkg.name}@${pkg.version}`);
}

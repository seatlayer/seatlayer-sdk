#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const packagePaths = [
  'packages/react/package.json',
  'packages/vue/package.json',
  'packages/angular/package.json',
];
const packages = packagePaths.map((path) => JSON.parse(readFileSync(resolve(path), 'utf8')));
const versions = new Set(packages.map((pkg) => pkg.version));
if (versions.size !== 1) throw new Error('All public wrappers must use one version');
const version = packages[0].version;
const requestedTag = process.env.RELEASE_TAG || process.argv.find((arg) => arg.startsWith('v'));
if (requestedTag && requestedTag !== `v${version}`) {
  throw new Error(`Release tag ${requestedTag} does not match wrapper version v${version}`);
}
for (const pkg of packages) {
  for (const runtime of ['@seatlayer/core', '@seatlayer/js']) {
    if (pkg.dependencies?.[runtime] !== version) {
      throw new Error(`${pkg.name} must pin ${runtime} to ${version}`);
    }
  }
  console.log(`✓ ${pkg.name}@${version} pins compiled runtime ${version}`);
}

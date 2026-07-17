#!/usr/bin/env node
import { readJson, releasePackages, releaseVersion } from './release-metadata.mjs';

const version = releaseVersion();
const requestedTag = process.env.RELEASE_TAG || process.argv.find((arg) => arg.startsWith('v'));
if (requestedTag && requestedTag !== `v${version}`) {
  throw new Error(`Release tag ${requestedTag} does not match package version v${version}`);
}

for (const pkg of releasePackages()) {
  console.log(`✓ ${pkg.name}@${pkg.version}`);
}

for (const [manifestPath, dependency] of [
  ['packages/js/package.json', '@seatlayer/core'],
  ['packages/react/package.json', '@seatlayer/js'],
]) {
  const manifest = readJson(manifestPath);
  if (manifest.dependencies?.[dependency] !== 'workspace:*') {
    throw new Error(`${manifest.name} must publish ${dependency} at the exact release version (use workspace:*)`);
  }
  console.log(`✓ ${manifest.name} pins ${dependency} to the exact release version`);
}
console.log(`✓ release version v${version}${requestedTag ? ' matches tag' : ''}`);

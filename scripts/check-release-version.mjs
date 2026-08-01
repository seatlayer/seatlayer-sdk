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

// Derived rather than hard-coded: every released package that depends on
// another released package must pin it with `workspace:*`, so pnpm rewrites it
// to the exact version at publish time. A hand-maintained list here silently
// stopped covering new packages the moment one was added.
const released = new Set(releasePackages().map((pkg) => pkg.name));

for (const { path: manifestPath } of releasePackages()) {
  const manifest = readJson(manifestPath);
  const internal = Object.keys(manifest.dependencies ?? {}).filter((name) => released.has(name));

  for (const dependency of internal) {
    if (manifest.dependencies[dependency] !== 'workspace:*') {
      throw new Error(
        `${manifest.name} must publish ${dependency} at the exact release version (use workspace:*, got "${manifest.dependencies[dependency]}")`,
      );
    }
    console.log(`✓ ${manifest.name} pins ${dependency} to the exact release version`);
  }
}
console.log(`✓ release version v${version}${requestedTag ? ' matches tag' : ''}`);

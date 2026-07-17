#!/usr/bin/env node
import { releasePackages, releaseVersion } from './release-metadata.mjs';

const version = releaseVersion();
const requestedTag = process.env.RELEASE_TAG || process.argv.find((arg) => arg.startsWith('v'));
if (requestedTag && requestedTag !== `v${version}`) {
  throw new Error(`Release tag ${requestedTag} does not match package version v${version}`);
}

for (const pkg of releasePackages()) {
  console.log(`✓ ${pkg.name}@${pkg.version}`);
}
console.log(`✓ release version v${version}${requestedTag ? ' matches tag' : ''}`);

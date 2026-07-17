import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const packageFiles = [
  'packages/core/package.json',
  'packages/js/package.json',
  'packages/react/package.json',
];

export function readJson(path) {
  return JSON.parse(readFileSync(resolve(repoRoot, path), 'utf8'));
}

export function releasePackages() {
  return packageFiles.map((path) => {
    const manifest = readJson(path);
    return { path, name: manifest.name, version: manifest.version };
  });
}

export function releaseVersion() {
  const packages = releasePackages();
  const versions = new Set(packages.map((pkg) => pkg.version));
  if (versions.size !== 1) {
    throw new Error(`SeatLayer packages must use one version: ${packages.map((pkg) => `${pkg.name}=${pkg.version}`).join(', ')}`);
  }
  return packages[0].version;
}

export function sourceCommit() {
  return process.env.SEATLAYER_RELEASE_COMMIT
    || process.env.GITHUB_SHA
    || execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' }).trim();
}

export function engineSource() {
  const source = readJson('packages/core/engine-source.json');
  if (typeof source.repository !== 'string' || !/^[0-9a-f]{40}$/.test(source.commit)) {
    throw new Error('packages/core/engine-source.json must contain a repository and full commit SHA');
  }
  return source;
}

export function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

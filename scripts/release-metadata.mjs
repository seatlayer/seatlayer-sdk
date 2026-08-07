import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * The ENUMERATED entry files of a CDN release: the artifacts an integrator or
 * the widget names directly. Every one is hand-declared here, in the Worker's
 * FILE_NAMES allowlist, and in verify-cdn-build's size floors — adding one is a
 * deliberate act in four places.
 *
 * Everything else a build emits is a hashed ASSET (see releaseAssets): named by
 * the bundler, never referenced by hand, and accounted for by release.json
 * instead of by enumeration. Today that is one file — the 3D scene worker, which
 * Vite emits because `new Worker(new URL(…), { type: 'module' })` cannot be
 * inlined without becoming a blob worker that host-site CSP can refuse.
 */
export const RELEASE_ENTRY_FILES = [
  'seatlayer.js',
  'seatlayer.mjs',
  'seatlayer-view3d.mjs',
  'seatlayer-panorama.mjs',
  'seatlayer-checkout.mjs',
];

/** The manifest itself, which is emitted last and therefore never self-hashed. */
export const RELEASE_MANIFEST_FILE = 'release.json';

/**
 * Hashed assets live under exactly this prefix, and their names are constrained
 * so the CDN Worker can serve them by PATTERN (it cannot enumerate a manifest on
 * the hot path) without that pattern becoming an open read of the bucket.
 */
export const RELEASE_ASSET_DIR = 'assets';
export const RELEASE_ASSET_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*\.m?js$/;

/**
 * The exact object names upload-cdn.mjs writes for a mode, given release.json.
 *
 * Pure and separate from the uploader so the manifest WALK — the part a tag
 * exercises for the first time — is covered by cdn/test/uploadPlan.test.ts
 * rather than only by a live release. Assets come from the manifest, never from
 * a directory listing: the manifest is what verify-cdn-build sha-pinned, so the
 * uploader can only ship bytes that were verified.
 */
export function uploadPlan(mode, manifest) {
  if (mode === 'index') return ['versions.json'];
  if (mode !== 'immutable') throw new Error(`Unknown upload mode: ${mode}`);
  const assets = Object.keys(manifest?.assets ?? {}).sort();
  for (const path of assets) {
    const [prefix, name, ...rest] = path.split('/');
    if (prefix !== RELEASE_ASSET_DIR || rest.length || !RELEASE_ASSET_NAME.test(name ?? '')) {
      throw new Error(`release.json lists an asset this uploader will not write: ${path}`);
    }
  }
  // Entry files and assets first, the manifest LAST: release.json is what
  // verify-cdn-deployment reads to decide a release is live, so it must never
  // land before the bytes it describes.
  return [...RELEASE_ENTRY_FILES, ...assets, RELEASE_MANIFEST_FILE];
}

/** Every file under `dir`, as sorted forward-slash paths relative to it. */
export function walkReleaseFiles(dir) {
  const out = [];
  const visit = (relative) => {
    for (const entry of readdirSync(resolve(dir, relative), { withFileTypes: true })) {
      const next = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) visit(next);
      else out.push(next);
    }
  };
  visit('');
  return out.sort();
}

/**
 * The hashed assets in a built release directory: everything that is not an
 * enumerated entry file or the manifest. Returns sorted `assets/<name>` paths.
 * Throws on anything outside the asset prefix, so an unexpected emit is a build
 * failure rather than a file that quietly never gets uploaded.
 */
export function releaseAssets(dir) {
  const known = new Set([...RELEASE_ENTRY_FILES, RELEASE_MANIFEST_FILE]);
  const assets = walkReleaseFiles(dir).filter((file) => !known.has(file));
  for (const file of assets) {
    const [prefix, name, ...rest] = file.split('/');
    if (prefix !== RELEASE_ASSET_DIR || rest.length || !RELEASE_ASSET_NAME.test(name ?? '')) {
      throw new Error(
        `CDN release emitted ${file}, which is neither an enumerated entry file nor a `
        + `hashed asset at ${RELEASE_ASSET_DIR}/<name>.js — nothing else may ship`,
      );
    }
  }
  return assets;
}
export const packageFiles = [
  'packages/core/package.json',
  'packages/js/package.json',
  'packages/react/package.json',
  'packages/vue/package.json',
  'packages/angular/package.json',
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
  if (source.visibility !== 'private' || !/^[0-9a-f]{40}$/.test(source.commit)) {
    throw new Error('packages/core/engine-source.json must identify private visibility and a full commit SHA');
  }
  return source;
}

export function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

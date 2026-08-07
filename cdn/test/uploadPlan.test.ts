import { describe, expect, it } from 'vitest';
// @ts-expect-error — release tooling is plain ESM with no types; that is deliberate.
import { uploadPlan } from '../../scripts/release-metadata.mjs';

/**
 * The manifest walk in scripts/upload-cdn.mjs is the one part of the release
 * chain that a tag exercises for the first time — nothing before the tag writes
 * to R2. So the walk is a pure function and it is tested here: a hashed asset
 * that release.json accounts for but the uploader skips would ship a 3D chunk
 * whose scene worker 404s, and prepareVenue3D hides that behind a silent
 * main-thread fallback.
 */
const manifest = {
  files: { 'seatlayer.js': { sha256: 'a', bytes: 1 } },
  assets: { 'assets/scene.worker-DM50HIYm.js': { sha256: 'b', bytes: 2 } },
};

describe('uploadPlan', () => {
  it('walks the manifest assets alongside the enumerated entry files', () => {
    expect(uploadPlan('immutable', manifest)).toEqual([
      'seatlayer.js',
      'seatlayer.mjs',
      'seatlayer-view3d.mjs',
      'seatlayer-panorama.mjs',
      'seatlayer-checkout.mjs',
      'assets/scene.worker-DM50HIYm.js',
      'release.json',
    ]);
  });

  it('writes release.json last, after the bytes it describes', () => {
    const plan = uploadPlan('immutable', manifest);
    expect(plan[plan.length - 1]).toBe('release.json');
  });

  it('ships the entry files even when a release emits no assets', () => {
    expect(uploadPlan('immutable', { files: {}, assets: {} })).toEqual([
      'seatlayer.js',
      'seatlayer.mjs',
      'seatlayer-view3d.mjs',
      'seatlayer-panorama.mjs',
      'seatlayer-checkout.mjs',
      'release.json',
    ]);
  });

  it('orders multiple assets deterministically', () => {
    const plan = uploadPlan('immutable', {
      assets: { 'assets/z-2.js': {}, 'assets/a-1.js': {} },
    });
    expect(plan.slice(5, 7)).toEqual(['assets/a-1.js', 'assets/z-2.js']);
  });

  it('promotes only the version index in index mode', () => {
    expect(uploadPlan('index', null)).toEqual(['versions.json']);
  });

  // The uploader turns each name into an R2 key by concatenation, so a manifest
  // path that escaped the assets/ prefix would write outside the release.
  it.each([
    'assets/../../secret.js',
    '../secret.js',
    'assets/nested/deep.js',
    'assets/secrets.env',
    'seatlayer.js',
  ])('refuses to write %s', (path) => {
    expect(() => uploadPlan('immutable', { assets: { [path]: {} } })).toThrow(/will not write/);
  });

  it('rejects an unknown mode rather than uploading nothing', () => {
    expect(() => uploadPlan('promote', manifest)).toThrow(/Unknown upload mode/);
  });
});

#!/usr/bin/env node
/**
 * Sync the shared rendering engine from the main SeatLayer app into
 * @seatlayer/core. The main app (seatmap/src) is the SINGLE SOURCE OF TRUTH for
 * the engine; the files under packages/core/src/{core,engine,picker} are a
 * generated mirror and must never be hand-edited. See RELEASING.md.
 *
 * The directory structure under packages/core/src mirrors the app's src/ exactly,
 * so imports stay byte-identical and no path rewriting is ever needed.
 *
 * Usage:
 *   node scripts/sync-core.mjs            copy app → core   (assumes ../seatmap)
 *   node scripts/sync-core.mjs --check    fail (exit 1) if core differs from app
 *   SEATMAP_REPO=/path/to/seatmap node scripts/sync-core.mjs
 */
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const CHECK = process.argv.includes('--check');
const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');
const appRepo = process.env.SEATMAP_REPO
  ? resolve(process.env.SEATMAP_REPO)
  : resolve(repoRoot, '..', 'seatmap');
const sourceRecord = join(repoRoot, 'packages/core/engine-source.json');

function appGit(...args) {
  return execFileSync('git', ['-C', appRepo, ...args], { encoding: 'utf8' }).trim();
}

// app src path -> core package path (structure preserved)
const FILES = [
  ['src/core/types.ts', 'packages/core/src/core/types.ts'],
  // Geometry and rendering rules are transitive dependencies of layout and
  // SeatmapRenderer. Keep them in the mirror manifest so a successful sync is
  // also a buildable dependency closure.
  ['src/core/complexGeometry.ts', 'packages/core/src/core/complexGeometry.ts'],
  ['src/core/sectionPath.ts', 'packages/core/src/core/sectionPath.ts'],
  ['src/core/chartRenderRules.ts', 'packages/core/src/core/chartRenderRules.ts'],
  ['src/core/layout.ts', 'packages/core/src/core/layout.ts'],
  ['src/core/bestAvailable.ts', 'packages/core/src/core/bestAvailable.ts'],
  ['src/core/ga.ts', 'packages/core/src/core/ga.ts'],
  ['src/core/sections.ts', 'packages/core/src/core/sections.ts'],
  // Orphan-seat (stranded single) detection — imported by PickerController for
  // the non-blocking `onHint` selection advice.
  ['src/core/orphans.ts', 'packages/core/src/core/orphans.ts'],
  ['src/engine/SeatmapRenderer.ts', 'packages/core/src/engine/SeatmapRenderer.ts'],
  ['src/picker/PickerController.ts', 'packages/core/src/picker/PickerController.ts'],
  // View-from-seat panorama generator — pure canvas geometry (no deps), used by
  // the SDK SeatPicker's 360° seat-view modal. Byte-mirrored from the app.
  ['src/view/generatePanorama.ts', 'packages/core/src/view/generatePanorama.ts'],
  // i18n + money: imported by the engine (`t()`, formatMoney) and surfaced to the
  // SDKs (loadLocale / setStringOverrides for the widget `locale`/`messages` options).
  ['src/i18n/index.ts', 'packages/core/src/i18n/index.ts'],
  ['src/i18n/bundles.ts', 'packages/core/src/i18n/bundles.ts'],
  ['src/i18n/locales/en.ts', 'packages/core/src/i18n/locales/en.ts'],
  ['src/i18n/locales/es.ts', 'packages/core/src/i18n/locales/es.ts'],
  ['src/i18n/locales/de.ts', 'packages/core/src/i18n/locales/de.ts'],
  ['src/i18n/locales/fr.ts', 'packages/core/src/i18n/locales/fr.ts'],
  ['src/lib/money.ts', 'packages/core/src/lib/money.ts'],
];

if (!existsSync(appRepo)) {
  const msg = `Main app repo not found at ${appRepo}. Set SEATMAP_REPO to override.`;
  // In --check mode this is a soft skip (e.g. CI without the private app repo);
  // the guard only enforces when the app is actually available locally.
  if (CHECK) {
    console.log(`ⓘ sync check skipped — ${msg}`);
    process.exit(0);
  }
  console.error(`✘ ${msg}`);
  process.exit(1);
}

if (CHECK) {
  if (!existsSync(sourceRecord)) {
    console.error(`✘ Missing engine provenance: ${sourceRecord}`);
    process.exit(1);
  }
  const drifted = [];
  for (const [from, to] of FILES) {
    const src = join(appRepo, from);
    const dest = join(repoRoot, to);
    if (!existsSync(src)) {
      console.error(`✘ Missing source: ${src}`);
      process.exit(1);
    }
    if (!existsSync(dest) || readFileSync(src, 'utf8') !== readFileSync(dest, 'utf8')) {
      drifted.push(from);
    }
  }
  if (drifted.length) {
    console.error('✘ @seatlayer/core is OUT OF SYNC with the app engine:');
    drifted.forEach((f) => console.error(`    ${f}`));
    console.error('\n  Run `pnpm sync:core` from a CLEAN, committed app state, then rebuild.');
    console.error('  Do NOT sync while the app has uncommitted engine WIP. See RELEASING.md.');
    process.exit(1);
  }
  console.log(`✓ @seatlayer/core is in sync with ${appRepo}`);
  process.exit(0);
}

const dirty = appGit('status', '--porcelain');
if (dirty) {
  console.error('✘ Refusing to sync from a dirty SeatLayer app worktree.');
  console.error('  Commit the complete engine change first, then run pnpm sync:core.');
  process.exit(1);
}
const appCommit = appGit('rev-parse', 'HEAD');

let copied = 0;
for (const [from, to] of FILES) {
  const src = join(appRepo, from);
  const dest = join(repoRoot, to);
  if (!existsSync(src)) {
    console.error(`✘ Missing source: ${src}`);
    process.exit(1);
  }
  mkdirSync(dirname(dest), { recursive: true });
  copyFileSync(src, dest);
  console.log(`  ${from} → ${to}`);
  copied++;
}
writeFileSync(sourceRecord, `${JSON.stringify({
  repository: 'paiteq/seatmap',
  commit: appCommit,
}, null, 2)}\n`);
console.log(`✓ Synced ${copied} engine files from ${appRepo}`);
console.log(`✓ Recorded engine source commit ${appCommit}`);

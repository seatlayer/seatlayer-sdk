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
import { copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const CHECK = process.argv.includes('--check');
const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');
const appRepo = process.env.SEATMAP_REPO
  ? resolve(process.env.SEATMAP_REPO)
  : resolve(repoRoot, '..', 'seatmap');

// app src path -> core package path (structure preserved)
const FILES = [
  ['src/core/types.ts', 'packages/core/src/core/types.ts'],
  ['src/core/layout.ts', 'packages/core/src/core/layout.ts'],
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
console.log(`✓ Synced ${copied} engine files from ${appRepo}`);

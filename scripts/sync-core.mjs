#!/usr/bin/env node
/**
 * Sync the shared rendering engine from the main SeatLayer app into
 * @seatlayer/core. This is the temporary bridge until the main app migrates to
 * consume @seatlayer/core directly (at which point this script is deleted).
 *
 * The directory structure under packages/core/src mirrors the app's src/ exactly,
 * so imports stay byte-identical and no path rewriting is ever needed.
 *
 * Usage:  node scripts/sync-core.mjs            (assumes ../seatmap)
 *         SEATMAP_REPO=/path/to/seatmap node scripts/sync-core.mjs
 */
import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');
const appRepo = process.env.SEATMAP_REPO
  ? resolve(process.env.SEATMAP_REPO)
  : resolve(repoRoot, '..', 'seatmap');

// app src path -> core package path (structure preserved)
const FILES = [
  ['src/core/types.ts', 'packages/core/src/core/types.ts'],
  ['src/core/layout.ts', 'packages/core/src/core/layout.ts'],
  ['src/engine/SeatmapRenderer.ts', 'packages/core/src/engine/SeatmapRenderer.ts'],
  ['src/picker/PickerController.ts', 'packages/core/src/picker/PickerController.ts'],
];

if (!existsSync(appRepo)) {
  console.error(`✘ Main app repo not found at ${appRepo}. Set SEATMAP_REPO to override.`);
  process.exit(1);
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

#!/usr/bin/env node
/**
 * sync-widget.mjs — vendor the SDK-owned buyer widget chrome INTO the main app.
 *
 * Direction is the REVERSE of sync-core: the app owns the engine (app → sdk),
 * while the SDK owns the SeatPicker widget chrome (sdk → app). Each file has
 * exactly one owner; this script keeps the app's vendored copy byte-identical
 * except for a single deterministic import rewrite:
 *
 *     from '@seatlayer/core'  →  from './core'
 *
 * The app provides `src/picker/widget/core.ts`, a hand-written barrel that
 * re-exports the same names from the app's own engine modules (which are the
 * source the SDK's @seatlayer/core is mirrored from — so both trees compile
 * the identical widget against the identical engine).
 *
 * Usage: `pnpm sync:widget` after committing widget changes here, then commit
 * the vendored copy in the app. `--check` verifies the app copy matches.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const CHECK = process.argv.includes('--check');
const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');
const appRepo = process.env.SEATMAP_REPO
  ? resolve(process.env.SEATMAP_REPO)
  : resolve(repoRoot, '..', '..', 'seatmap');
const sourceRecord = join(appRepo, 'src/picker/widget/widget-source.json');

// sdk source -> app vendored path. `core.ts` is app-owned and NOT in this list.
const FILES = [
  ['packages/js/src/SeatPicker.ts', 'src/picker/widget/SeatPicker.ts'],
  ['packages/js/src/api.ts', 'src/picker/widget/api.ts'],
  ['packages/js/src/SeatingChart.ts', 'src/picker/widget/SeatingChart.ts'],
];

// Two deterministic import rewrites for the app's vendored copy:
//   '@seatlayer/core/view3d' → '../../view3d'  (the app owns the view3d source;
//        matches both the `import type … from` and the lazy `import(...)` forms)
//   from '@seatlayer/core'    → from './core'   (the hand-written engine barrel)
// The view3d rewrite MUST run first — its specifier is a superset of the general
// one, and its closing quote sits after `/view3d` so the general rule never
// matches it, but ordering keeps the intent obvious.
const rewrite = (text) => text
  .replaceAll("'@seatlayer/core/view3d'", "'../../view3d'")
  .replaceAll("from '@seatlayer/core'", "from './core'");

function sdkGit(...args) {
  return execFileSync('git', ['-C', repoRoot, ...args], { encoding: 'utf8' }).trim();
}

if (!existsSync(appRepo)) {
  const msg = `Main app repo not found at ${appRepo}. Set SEATMAP_REPO to override.`;
  if (CHECK) {
    console.log(`ⓘ widget sync check skipped — ${msg}`);
    process.exit(0);
  }
  console.error(`✘ ${msg}`);
  process.exit(1);
}

if (CHECK) {
  const drifted = [];
  for (const [from, to] of FILES) {
    const src = join(repoRoot, from);
    const dest = join(appRepo, to);
    if (!existsSync(dest) || rewrite(readFileSync(src, 'utf8')) !== readFileSync(dest, 'utf8')) {
      drifted.push(to);
    }
  }
  if (drifted.length) {
    console.error('✘ The app\'s vendored widget is OUT OF SYNC with packages/js:');
    drifted.forEach((f) => console.error(`    ${f}`));
    console.error('\n  Run `pnpm sync:widget` from a CLEAN, committed SDK state.');
    process.exit(1);
  }
  console.log(`✓ App vendored widget is in sync with ${repoRoot}`);
  process.exit(0);
}

const dirty = sdkGit('status', '--porcelain');
if (dirty) {
  console.error('✘ Refusing to sync from a dirty SDK worktree.');
  console.error('  Commit the complete widget change first, then run pnpm sync:widget.');
  process.exit(1);
}
const sdkCommit = sdkGit('rev-parse', 'HEAD');

let copied = 0;
for (const [from, to] of FILES) {
  const src = join(repoRoot, from);
  const dest = join(appRepo, to);
  if (!existsSync(src)) {
    console.error(`✘ Missing source: ${src}`);
    process.exit(1);
  }
  mkdirSync(dirname(dest), { recursive: true });
  writeFileSync(dest, rewrite(readFileSync(src, 'utf8')));
  console.log(`  ${from} → ${to}`);
  copied++;
}
writeFileSync(sourceRecord, `${JSON.stringify({
  repository: 'seatlayer/seatlayer-sdk',
  commit: sdkCommit,
}, null, 2)}\n`);
console.log(`✓ Vendored ${copied} widget files into ${appRepo}`);
console.log(`✓ Recorded widget source commit ${sdkCommit}`);

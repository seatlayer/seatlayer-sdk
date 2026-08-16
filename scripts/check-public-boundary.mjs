import { readdirSync } from 'node:fs';
import { join, relative } from 'node:path';

const skippedDirectories = new Set(['.git', 'node_modules', 'dist', 'coverage']);
const files = [];

function walk(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory() && skippedDirectories.has(entry.name)) continue;
    const absolute = join(directory, entry.name);
    if (entry.isDirectory()) walk(absolute);
    else files.push(relative(process.cwd(), absolute));
  }
}

walk(process.cwd());

const forbidden = [
  /^packages\/core\//,
  /^packages\/js\/src\//,
  /^cdn\//,
  /(?:^|\/)src\/view3d\//,
  /(?:^|\/)src\/engine\//,
  /(?:^|\/)src\/designer\//,
  /(?:^|\/)engine-source\.json$/,
  /\.js\.map$/,
  /\.cjs\.map$/,
  /\.mjs\.map$/,
];

const violations = files.filter((file) => forbidden.some((rule) => rule.test(file)));
if (violations.length) {
  console.error('Private runtime files crossed the public SDK boundary:');
  for (const file of violations) console.error(`  ${file}`);
  process.exit(1);
}

console.log(`Public boundary verified (${files.length} files).`);

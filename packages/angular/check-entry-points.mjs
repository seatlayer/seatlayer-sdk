/**
 * ng-packagr generates `dist/package.json` with entry points relative to dist/.
 * We publish from the package root, so the root manifest mirrors them with a
 * `./dist/` prefix — and a mismatch would ship a package whose `import` resolves
 * to nothing, which npm will happily accept and a consumer discovers at build
 * time. So the two are compared on every build.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const read = (path) => JSON.parse(readFileSync(resolve(here, path), 'utf8'));

const source = read('package.json');
const generated = read('dist/package.json');

const expected = {
  module: `./dist/${generated.module}`,
  types: `./dist/${generated.typings}`,
  importPath: `./dist/${generated.exports['.'].default.replace(/^\.\//, '')}`,
  typesPath: `./dist/${generated.exports['.'].types.replace(/^\.\//, '')}`,
};

const problems = [];
if (source.module !== expected.module) {
  problems.push(`module: manifest "${source.module}" vs generated "${expected.module}"`);
}
if (source.types !== expected.types) {
  problems.push(`types: manifest "${source.types}" vs generated "${expected.types}"`);
}
if (source.exports['.'].default !== expected.importPath) {
  problems.push(`exports["."].default: "${source.exports['.'].default}" vs "${expected.importPath}"`);
}
if (source.exports['.'].types !== expected.typesPath) {
  problems.push(`exports["."].types: "${source.exports['.'].types}" vs "${expected.typesPath}"`);
}

if (problems.length) {
  console.error('\n@seatlayer/angular entry points drifted from ng-packagr output:\n');
  for (const problem of problems) console.error(`  ${problem}`);
  console.error('\nUpdate packages/angular/package.json to match dist/package.json.\n');
  process.exit(1);
}

console.log('entry points match ng-packagr output');

#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { releasePackages, releaseVersion, repoRoot } from './release-metadata.mjs';

if (process.env.RELEASE_PUBLISH_CONFIRMED !== '1' && process.env.DRY_RUN !== '1') {
  throw new Error('Set RELEASE_PUBLISH_CONFIRMED=1 to publish npm packages');
}
if (process.env.DRY_RUN !== '1' && !process.env.NODE_AUTH_TOKEN) {
  throw new Error('NODE_AUTH_TOKEN is required to publish npm packages');
}

const version = releaseVersion();
function npmVersion(name) {
  const result = spawnSync('npm', ['view', `${name}@${version}`, 'version', '--json'], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
  if (result.status === 0) return JSON.parse(result.stdout || 'null');
  const error = `${result.stdout || ''}\n${result.stderr || ''}`;
  if (/E404|404 Not Found/.test(error)) return null;
  throw new Error(`npm lookup failed for ${name}@${version}: ${error.trim()}`);
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: repoRoot, encoding: 'utf8', ...options });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed: ${(result.stderr || result.stdout || '').trim()}`);
  }
  return result;
}

function filesUnder(root, prefix = '') {
  const result = [];
  for (const name of readdirSync(join(root, prefix))) {
    const relative = join(prefix, name);
    const stat = statSync(join(root, relative));
    if (stat.isDirectory()) result.push(...filesUnder(root, relative));
    else result.push(relative);
  }
  return result.sort();
}

function verifyExistingPackage(pkg) {
  const temp = mkdtempSync(join(tmpdir(), 'seatlayer-npm-verify-'));
  try {
    const localTarDir = join(temp, 'local-tar');
    const remoteTarDir = join(temp, 'remote-tar');
    const localDir = join(temp, 'local');
    const remoteDir = join(temp, 'remote');
    for (const dir of [localTarDir, remoteTarDir, localDir, remoteDir]) mkdirSync(dir);
    run('pnpm', ['--filter', pkg.name, 'pack', '--pack-destination', localTarDir]);
    run('npm', ['pack', `${pkg.name}@${version}`, '--silent'], { cwd: remoteTarDir });
    const localTarName = readdirSync(localTarDir).find((name) => name.endsWith('.tgz'));
    const remoteTarName = readdirSync(remoteTarDir).find((name) => name.endsWith('.tgz'));
    if (!localTarName || !remoteTarName) throw new Error(`Could not pack ${pkg.name}@${version}`);
    const localTar = join(localTarDir, localTarName);
    const remoteTar = join(remoteTarDir, remoteTarName);
    run('tar', ['-xzf', localTar, '-C', localDir]);
    run('tar', ['-xzf', remoteTar, '-C', remoteDir]);
    const localRoot = join(localDir, 'package');
    const remoteRoot = join(remoteDir, 'package');
    const localFiles = filesUnder(localRoot);
    const remoteFiles = filesUnder(remoteRoot);
    if (JSON.stringify(localFiles) !== JSON.stringify(remoteFiles)) {
      throw new Error(`Published ${pkg.name}@${version} file list differs from this release`);
    }
    for (const file of localFiles) {
      if (!readFileSync(join(localRoot, file)).equals(readFileSync(join(remoteRoot, file)))) {
        throw new Error(`Published ${pkg.name}@${version} differs at ${file}`);
      }
    }
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

for (const pkg of releasePackages()) {
  const existing = npmVersion(pkg.name);
  if (existing === version) {
    verifyExistingPackage(pkg);
    console.log(`✓ ${pkg.name}@${version} already published with the exact release payload`);
    continue;
  }
  const args = [
    '--filter', pkg.name, 'publish', '--access', 'public', '--no-git-checks', '--provenance',
  ];
  if (process.env.DRY_RUN === '1') {
    console.log(`DRY RUN pnpm ${args.join(' ')}`);
    continue;
  }
  const result = spawnSync('pnpm', args, { cwd: repoRoot, stdio: 'inherit' });
  if (result.status !== 0) throw new Error(`npm publish failed for ${pkg.name}@${version}`);
  if (npmVersion(pkg.name) !== version) throw new Error(`npm did not expose ${pkg.name}@${version} after publish`);
  console.log(`✓ published ${pkg.name}@${version}`);
}

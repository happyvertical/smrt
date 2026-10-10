#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const standalone = new Set(['ocr', 'pdf', 'spider']);

function sectionEntries(text, section) {
  let inside = false;
  const entries = [];
  for (const line of text.split('\n')) {
    if (line === `${section}:`) {
      inside = true;
      continue;
    }
    if (inside && /^[^\s#]/.test(line)) break;
    if (!inside || !/^  ['"]?@happyvertical\//.test(line)) continue;
    const match = line.match(/^  (['"])(@happyvertical\/[^'"]+)\1:\s*(.+?)\s*$/);
    if (!match) throw new Error(`Unsupported SDK entry: ${line}`);
    entries.push([match[2], match[3].replace(/^(['"])(.*)\1$/, '$2')]);
  }
  return entries;
}

function containedFile(root, path) {
  const target = resolve(root, path);
  const rel = relative(root, target);
  if (!rel || rel.startsWith('../') || isAbsolute(rel)) {
    throw new Error(`Archive path must stay inside repository: ${path}`);
  }
  if (realpathSync(target) !== target || !lstatSync(target).isFile()) {
    throw new Error(`Archive/provenance must be a regular file without symlinks: ${path}`);
  }
  return target;
}

/** Verify immutable archive bytes, identity, source provenance and pnpm lock agreement. */
function archiveVersion(root, name, spec, catalogRange, lock) {
  const path = spec.slice(5);
  if (isAbsolute(path) || path.split('/').includes('..') || !path.endsWith('.tgz')) {
    throw new Error(`Unsupported SDK archive path: ${spec}`);
  }
  const archive = containedFile(root, path);
  if (lstatSync(archive).size > 64 * 1024 * 1024) throw new Error('SDK archive exceeds 64 MiB');
  const bytes = readFileSync(archive);
  const provenancePath = containedFile(root, relative(root, resolve(dirname(archive), 'manifest.json')));
  const provenance = JSON.parse(readFileSync(provenancePath, 'utf8'));
  if (provenance.repository !== 'https://github.com/happyvertical/sdk' ||
      !/^[a-f0-9]{40}$/.test(provenance.revision ?? '')) {
    throw new Error('SDK archive requires an exact source repository and commit revision');
  }
  const records = provenance.artifacts?.filter((entry) => entry.file === basename(archive));
  if (records?.length !== 1 || records[0].sha256 !== createHash('sha256').update(bytes).digest('hex')) {
    throw new Error(`SDK archive SHA256 provenance mismatch: ${name}`);
  }
  const entries = execFileSync('tar', ['-tzf', archive], { encoding: 'utf8', maxBuffer: 1024 * 1024, timeout: 10000 }).trim().split('\n');
  if (entries.filter((entry) => entry === 'package/package.json').length !== 1 ||
      entries.some((entry) => !entry.startsWith('package/') || entry.split('/').includes('..'))) {
    throw new Error('SDK archive must contain exactly one package/package.json and contained package paths');
  }
  const pkg = JSON.parse(execFileSync('tar', ['-xOzf', archive, 'package/package.json'], { encoding: 'utf8', maxBuffer: 1024 * 1024, timeout: 10000 }));
  const version = catalogRange.match(/^[~^]?(\d+\.\d+\.\d+(?:-[\da-zA-Z.-]+)?)$/)?.[1];
  if (!version || pkg.name !== name || pkg.version !== version) {
    throw new Error(`SDK archive package identity/version must match ${name}@${catalogRange}`);
  }
  const packageSection = lock.split(/^packages:\s*$/m)[1]?.split(/^[^\s#]/m)[0] ?? '';
  const lines = packageSection.split('\n');
  const indexes = lines.flatMap((line, index) =>
    line === `  '${name}@${spec}':` || line === `  "${name}@${spec}":` ? [index] : [],
  );
  if (indexes.length !== 1) throw new Error(`SDK archive requires one pnpm lock package entry: ${name}`);
  const [index] = indexes;
  let end = index + 1;
  while (end < lines.length && !/^  \S/.test(lines[end])) end++;
  const entry = lines.slice(index + 1, end).join('\n');
  const integrity = entry.match(/\bintegrity:\s*['"]?([^\s,'"}]+)/)?.[1];
  const tarball = entry.match(/\btarball:\s*['"]?([^\s,'"}]+)/)?.[1];
  const lockedVersion = entry.match(/^    version:\s*['"]?([^\s'"]+)/m)?.[1];
  if (integrity !== `sha512-${createHash('sha512').update(bytes).digest('base64')}` ||
      tarball !== spec || lockedVersion !== version) {
    throw new Error(`SDK archive pnpm lock integrity/version mismatch: ${name}`);
  }
  return catalogRange;
}

/** Preserve strict registry equality; archive pins must prove equivalent SDK versions. */
export function checkSdkVersions(directory = process.cwd()) {
  const root = realpathSync(directory);
  const workspace = readFileSync(resolve(root, 'pnpm-workspace.yaml'), 'utf8');
  const catalog = sectionEntries(workspace, 'catalog').filter(([name]) => !standalone.has(name.split('/')[1]));
  const versions = new Set(catalog.map(([, version]) => version));
  if (versions.size !== 1 || !catalog.length) throw new Error('SDK catalog versions must all match');
  const [catalogRange] = versions;
  const overrides = sectionEntries(workspace, 'overrides').filter(([name]) => !name.startsWith('@happyvertical/smrt-') && !standalone.has(name.split('/')[1]));
  const lock = overrides.some(([, spec]) => spec.startsWith('file:')) ? readFileSync(resolve(root, 'pnpm-lock.yaml'), 'utf8') : '';
  for (const [name, spec] of overrides) {
    const version = spec.startsWith('file:') ? archiveVersion(root, name, spec, catalogRange, lock) : spec;
    if (version !== catalogRange) throw new Error(`SDK override version mismatch: ${name}@${spec} (catalog ${catalogRange})`);
  }
  return catalogRange;
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  try {
    console.log(`OK: All SDK versions aligned at ${checkSdkVersions()}; archive provenance verified where present.`);
  } catch (error) {
    console.error(`ERROR: ${error.message}`);
    process.exitCode = 1;
  }
}

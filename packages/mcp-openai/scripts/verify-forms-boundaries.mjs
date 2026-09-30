import { execFileSync } from 'node:child_process';
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
const directory = mkdtempSync(join(tmpdir(), 'smrt-forms-pack-'));
execFileSync('pnpm', ['pack', '--pack-destination', directory], {
  stdio: 'pipe',
});
const tarball = readdirSync(directory).find((n) => n.endsWith('.tgz'));
execFileSync('tar', ['-xzf', join(directory, tarball), '-C', directory]);
const packed = join(directory, 'package');
const pkg = JSON.parse(readFileSync(join(packed, 'package.json'), 'utf8'));
for (const subpath of ['./forms', './forms/view']) {
  const entry = join(packed, pkg.exports[subpath].import);
  const result = await build({
    entryPoints: [entry],
    bundle: true,
    platform: 'browser',
    write: false,
    metafile: true,
    nodePaths: [resolve('node_modules')],
  });
  if (
    Object.keys(result.metafile.inputs).some((name) =>
      /smrt-app-mcp|smrt-core|smrt-jobs|node:|modelcontextprotocol/.test(name),
    )
  )
    throw new Error('Server code leaked into forms browser entry');
}
symlinkSync(resolve('node_modules'), join(packed, 'node_modules'), 'dir');
for (const subpath of ['./forms', './forms/view', './forms/server']) {
  const entry = pathToFileURL(join(packed, pkg.exports[subpath].import)).href;
  execFileSync(
    process.execPath,
    ['--input-type=module', '-e', `await import(${JSON.stringify(entry)})`],
    { cwd: directory, stdio: 'pipe' },
  );
}
console.log(
  'Packed forms/view browser isolation and forms/server Node load verified. Synthetic package at ' +
    directory,
);

const probe = join(packed, 'native-mrtr.mts');
writeFileSync(
  probe,
  `import type { InputRequest } from '@modelcontextprotocol/server';
const request: InputRequest = {
// @ts-expect-error SDK-v2 2.0.0 public MRTR excludes the pinned OpenAI custom method
method: 'openai/elicitation/create', params: { mode: 'form', message: 'Synthetic', requestedSchema: {type:'object',properties:{}} } };
void request;
`,
);
execFileSync(
  'pnpm',
  [
    'exec',
    'tsc',
    '--ignoreConfig',
    '--noEmit',
    '--skipLibCheck',
    '--target',
    'ES2023',
    '--module',
    'NodeNext',
    '--moduleResolution',
    'NodeNext',
    probe,
  ],
  { stdio: 'pipe' },
);
console.log(
  'SDK v2 public MRTR exclusion verified by expected compile-time rejection.',
);

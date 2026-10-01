import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { build } from 'esbuild';
import { pathToFileURL } from 'node:url';
const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
if (Object.keys({ ...pkg.dependencies, ...pkg.peerDependencies }).some(name => name === '@modelcontextprotocol/sdk' || name.includes('openai'))) throw new Error('Forbidden helper dependency');
const directory = mkdtempSync(join(tmpdir(), 'smrt-openai-pack-'));
try {
  execFileSync('pnpm', ['pack', '--pack-destination', directory], { stdio: 'pipe' });
  const tarball = readdirSync(directory).find(name => name.endsWith('.tgz'));
  execFileSync('tar', ['-xzf', join(directory, tarball), '-C', directory]);
  const packed = join(directory, 'package');
  // Packed entrypoints resolve installed dependencies explicitly; no source aliases.
  const result = await build({ entryPoints: [join(packed, 'dist/client.js')], bundle: true, platform: 'browser', write: false, metafile: true, nodePaths: [resolve('node_modules')] });
  if (Object.keys(result.metafile.inputs).some(name => /smrt-app-mcp|smrt-core|node:/.test(name))) throw new Error('Server dependency leaked into browser');
  await build({ entryPoints: [join(packed, 'dist/index.js')], bundle: true, platform: 'node', write: false, packages: 'external', nodePaths: [resolve('node_modules')] });
  symlinkSync(resolve('node_modules'), join(packed, 'node_modules'), 'dir');
  const entry = pathToFileURL(join(packed, 'dist/index.js')).href;
  const client = pathToFileURL(join(packed, 'dist/client.js')).href;
  execFileSync(process.execPath, ['--input-type=module', '-e', `await import(${JSON.stringify(entry)}); await import(${JSON.stringify(client)});`], { cwd: directory, stdio: 'pipe' });
  const declarations = readdirSync(join(packed,'dist')).filter(name => name.endsWith('.d.ts')).map(name => readFileSync(join(packed,'dist',name),'utf8')).join('\n');
  if (/modelcontextprotocol\/sdk|@openai/.test(declarations)) throw new Error('Forbidden SDK public type');
  console.log('Packed browser bundle and Node entrypoints verified; no SDK v1/OpenAI helper or server browser imports.');
} finally { rmSync(directory, { recursive: true, force: true }); }

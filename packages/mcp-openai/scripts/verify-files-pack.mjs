import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
const directory = mkdtempSync(join(tmpdir(), 'smrt-files-pack-'));
try {
  execFileSync('pnpm', ['pack', '--pack-destination', directory], { stdio: 'pipe' });
  const tarball = readdirSync(directory).find(name => name.endsWith('.tgz'));
  execFileSync('tar', ['-xzf', join(directory, tarball), '-C', directory]);
  const packed=join(directory,'package');
  const manifest=JSON.parse(readFileSync(join(packed,'package.json'),'utf8'));
  for(const subpath of ['./files','./files/server']) if(!manifest.exports[subpath])throw new Error('Missing files export');
  const browser=await build({ entryPoints:[join(packed,'dist/files.js')],bundle:true,platform:'browser',write:false,metafile:true,nodePaths:[resolve('node_modules')] });
  if(Object.keys(browser.metafile.inputs).some(name=>/smrt-app-mcp|smrt-core|node:|modelcontextprotocol\/sdk/.test(name)))throw new Error('Server or v1 dependency in browser');
  symlinkSync(resolve('node_modules'),join(packed,'node_modules'),'dir');
  const files=pathToFileURL(join(packed,'dist/files.js')).href;
  const server=pathToFileURL(join(packed,'dist/files-server.js')).href;
  execFileSync(process.execPath,['--input-type=module','-e',`await import(${JSON.stringify(files)}); await import(${JSON.stringify(server)});`],{cwd:directory,stdio:'pipe'});
  console.log('Packed files browser bundle and plain Node files/server exports verified');
} finally { rmSync(directory,{recursive:true,force:true}); }

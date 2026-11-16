#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const workspaceRoot = fileURLToPath(new URL('../', import.meta.url));
const require = createRequire(import.meta.url);

export function runSvelteCheck(args, label = 'svelte-check-workspace') {
  const packageDirectory = process.cwd();
  let bin;
  try {
    const manifest = require.resolve('svelte-check/package.json', {
      paths: [packageDirectory],
    });
    bin = path.join(path.dirname(manifest), 'bin', 'svelte-check');
  } catch {
    console.error(
      `[${label}] Could not resolve svelte-check from ${packageDirectory}`,
    );
    process.exitCode = 2;
    return;
  }

  const forwarded = [...args];
  const projectIndex = forwarded.indexOf('--tsconfig') + 1;
  let wrapper;
  if (projectIndex && forwarded[projectIndex] && forwarded.includes('--config')) {
    const project = path.resolve(packageDirectory, forwarded[projectIndex]);
    const relative = path.relative(workspaceRoot, project);
    if (!path.isAbsolute(relative) && !relative.startsWith(`..${path.sep}`)) {
      // Svelte Check scopes an explicit config to the TS project's directory.
      // Keep the package's project inputs while covering every sibling source
      // file under that scope, so looking up a component cannot load Vite.
      wrapper = path.join(workspaceRoot, `.svelte-check-${randomUUID()}.json`);
      const extendsPath = `./${relative.split(path.sep).join('/')}`;
      const config = { extends: extendsPath };
      const { options } = ts.getParsedCommandLineOfConfigFile(
        project,
        {},
        {
          ...ts.sys,
          onUnRecoverableConfigFileDiagnostic(diagnostic) {
            throw new Error(
              ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'),
            );
          },
        },
      );
      if (!options.typeRoots) {
        // Moving the config would shift ambient lookup to the root. Keep the
        // package search order, including explicit types shipped by packages.
        const roots = ts.getEffectiveTypeRoots(options, ts.sys);
        config.compilerOptions = {
          typeRoots: options.types?.length
            ? roots.flatMap((root) => [root, path.dirname(root)])
            : roots,
        };
      }
      writeFileSync(wrapper, JSON.stringify(config), { flag: 'wx' });
      forwarded[projectIndex] = wrapper;
    }
  }
  const cleanup = () => {
    if (wrapper) rmSync(wrapper, { force: true });
  };
  const child = spawn(process.execPath, [bin, ...forwarded], { stdio: 'inherit' });
  child.on('exit', (code, signal) => {
    cleanup();
    if (signal) process.kill(process.pid, signal);
    else process.exitCode = code ?? 0;
  });
  child.on('error', (error) => {
    cleanup();
    console.error(`[${label}] Failed to launch svelte-check: ${error.message}`);
    process.exitCode = 2;
  });
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  runSvelteCheck(process.argv.slice(2));
}

#!/usr/bin/env node
// Web launcher spawned by `smrt app start` (cwd = application root).
//
// The file name and the `--smrt-instance=<32 hex>` argument are the process
// identity `smrt app stop` verifies before signalling a recorded pid, so a
// recycled pid is never terminated. Ported from the template's
// `scripts/smrt-web.mjs`.

import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const instance = process.argv
  .find((value) => value.startsWith('--smrt-instance='))
  ?.slice('--smrt-instance='.length);
if (!instance || !/^[a-f0-9]{32}$/.test(instance)) {
  throw new Error('A valid application process identity is required.');
}

await import(pathToFileURL(resolve(process.cwd(), 'build', 'index.js')).href);

#!/usr/bin/env node

const instance = process.argv
  .find((value) => value.startsWith('--smrt-instance='))
  ?.slice('--smrt-instance='.length);
if (!instance || !/^[a-f0-9]{32}$/.test(instance)) {
  throw new Error('A valid application process identity is required.');
}

await import('../build/index.js');

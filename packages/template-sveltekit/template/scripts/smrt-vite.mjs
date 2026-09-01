import { existsSync, readFileSync, writeSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

function fail(message) {
  writeSync(2, `s-m-r-t Vite launcher: ${message}\n`);
  process.exit(1);
}

let packagePath;
try {
  packagePath = fileURLToPath(import.meta.resolve('vite/package.json'));
} catch (error) {
  const detail = error instanceof Error ? `: ${error.message}` : '';
  fail(
    `Could not resolve the installed Vite package${detail}. Verify the generated app dependencies and Vite compatibility.`,
  );
}
const packageRoot = dirname(packagePath);
let metadata;
try {
  metadata = JSON.parse(readFileSync(packagePath, 'utf8'));
} catch {
  fail('The installed Vite package metadata is invalid; reinstall dependencies.');
}
const declaredBin =
  typeof metadata.bin === 'string' ? metadata.bin : metadata.bin?.vite;
if (typeof declaredBin !== 'string' || declaredBin === '') {
  fail('The installed Vite package does not declare its CLI.');
}
const entry = resolve(packageRoot, declaredBin);
const relativeEntry = relative(packageRoot, entry);
if (
  relativeEntry === '' ||
  relativeEntry.startsWith('..') ||
  isAbsolute(relativeEntry)
) {
  fail('The installed Vite package declares an unsafe CLI path.');
}
if (!existsSync(entry)) {
  fail('The installed Vite package CLI is missing; reinstall dependencies.');
}

process.argv = [process.execPath, entry, ...process.argv.slice(2)];
await import(pathToFileURL(entry).href);

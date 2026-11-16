#!/usr/bin/env node
import { randomUUID } from 'node:crypto';
import { mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const [baseConfig, outputConfig] = process.argv.slice(2);
if (!baseConfig || !outputConfig) {
  throw new Error(
    'Usage: write-source-typecheck-config.mjs <base config> <output config>',
  );
}

const outputFile = resolve(outputConfig);
const outputDirectory = dirname(outputFile);
function relativeToOutput(file) {
  const path = relative(outputDirectory, file).split(sep).join('/');
  return path.startsWith('../') ? path : `./${path}`;
}

function rebasedPaths(configFile) {
  const parsed = ts.getParsedCommandLineOfConfigFile(
    resolve(configFile),
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
  const { paths = {}, pathsBasePath } = parsed.options;
  return Object.fromEntries(
    Object.entries(paths).map(([specifier, targets]) => [
      specifier,
      targets.map((target) => relativeToOutput(resolve(pathsBasePath, target))),
    ]),
  );
}

const workspaceConfig = fileURLToPath(
  new URL('../tsconfig.workspace-source-paths.json', import.meta.url),
);
const config = {
  extends: relativeToOutput(resolve(baseConfig)),
  compilerOptions: {
    noEmit: true,
    // TypeScript replaces paths on extension. Keep local aliases and retain
    // everything else (including Kit's generated rootDirs) through extends.
    paths: { ...rebasedPaths(baseConfig), ...rebasedPaths(workspaceConfig) },
  },
};

mkdirSync(outputDirectory, { recursive: true });
const temporaryFile = `${outputFile}.${randomUUID()}`;
try {
  writeFileSync(temporaryFile, `${JSON.stringify(config, null, 2)}\n`);
  renameSync(temporaryFile, outputFile);
} finally {
  rmSync(temporaryFile, { force: true });
}

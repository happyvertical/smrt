import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const SERVER_NAME = 'smrt-dev-mcp';

function readPackageVersion(): string {
  try {
    const packageRoot = dirname(fileURLToPath(import.meta.url));
    const packageJsonPath = join(packageRoot, '..', 'package.json');
    const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf-8')) as {
      version?: unknown;
    };
    return typeof packageJson.version === 'string'
      ? packageJson.version
      : '0.0.0';
  } catch {
    return '0.0.0';
  }
}

export const SERVER_VERSION = readPackageVersion();

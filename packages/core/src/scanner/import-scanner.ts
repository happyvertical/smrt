import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

interface ImportScannerOptions {
  missingBuildInstruction: string;
}

async function importScannerModule(filePath: string) {
  return import(/* @vite-ignore */ pathToFileURL(filePath).href);
}

export async function importScanner({
  missingBuildInstruction,
}: ImportScannerOptions): Promise<
  typeof import('@happyvertical/smrt-scanner')
> {
  try {
    return await import('@happyvertical/smrt-scanner');
  } catch (error) {
    if (
      !(error instanceof Error) ||
      !error.message.includes('@happyvertical/smrt-scanner')
    ) {
      throw error;
    }

    let current = process.cwd();

    while (true) {
      if (existsSync(join(current, 'pnpm-workspace.yaml'))) {
        const scannerDist = join(current, 'packages/scanner/dist/index.js');
        if (existsSync(scannerDist)) {
          return importScannerModule(scannerDist);
        }

        const scannerSrc = join(current, 'packages/scanner/src/index.ts');
        if (existsSync(scannerSrc)) {
          return importScannerModule(scannerSrc);
        }

        throw new Error(
          'Failed to load @happyvertical/smrt-scanner: could not find ' +
            `${scannerDist} or ${scannerSrc}. ` +
            missingBuildInstruction,
        );
      }

      const parent = dirname(current);
      if (parent === current) {
        break;
      }
      current = parent;
    }

    throw error;
  }
}

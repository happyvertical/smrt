import { importWorkspaceModule } from '../utils/import-workspace-module.js';
import type { ScannerModule } from '../utils/scanner-module.js';

interface ImportScannerOptions {
  missingBuildInstruction: string;
}

export async function importScanner({
  missingBuildInstruction,
}: ImportScannerOptions): Promise<ScannerModule> {
  try {
    return await importWorkspaceModule<ScannerModule>({
      packageName: '@happyvertical/smrt-scanner',
      distEntry: 'packages/scanner/dist/index.js',
      sourceEntry: 'packages/scanner/src/index.ts',
      purpose: 'scanner loading',
    });
  } catch (error) {
    throw new Error(
      `Failed to load @happyvertical/smrt-scanner. ${missingBuildInstruction}`,
      { cause: error },
    );
  }
}

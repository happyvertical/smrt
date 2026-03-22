import type { SmartObjectManifest } from '../scanner/types.js';

export interface OxcScannerLike {
  scanAndResolve(): Promise<{
    results: {
      typeAliases: Record<string, string>;
      errors: Array<{
        filePath: string;
        message: string;
        line?: number;
      }>;
    };
    resolved: unknown[];
  }>;
}

export interface OxcScannerConstructor {
  new (options: {
    cwd: string;
    include?: string[];
    exclude?: string[];
    baseClasses?: string[];
    includePrivateMethods?: boolean;
    includeStaticMethods?: boolean;
    followImports?: boolean;
  }): OxcScannerLike;
}

export interface ManifestAdapterLike {
  toManifest(
    resolved: unknown[],
    options: {
      packageName?: string;
      packageVersion?: string;
      typeAliases: Record<string, string>;
    },
  ): SmartObjectManifest;
}

export interface ScannerModule {
  OxcScanner: OxcScannerConstructor;
  ManifestAdapter: new () => ManifestAdapterLike;
}

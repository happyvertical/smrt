import type {
  CapabilityClassification,
  DomainKnowledgePlaybookStep,
} from '@happyvertical/smrt-types';
import type { SmartObjectManifest } from '../scanner/types.js';

/**
 * The scanner's declared agent surface (#2591), mirrored structurally like the
 * rest of this module.
 *
 * `@happyvertical/smrt-scanner` cannot import `@happyvertical/smrt-types` —
 * core depends on the scanner, so the reverse edge would close a cycle — which
 * is why the scanner owns its own copy of this vocabulary and core reconciles
 * the two at exactly one place (`toKnowledgeAgentSurface`).
 */
export interface ScannerAgentSurface {
  intents: Array<{
    kind: 'intent';
    id: string;
    description: string;
    capability: CapabilityClassification;
    target: Record<string, unknown>;
    hasInputSchema: boolean;
    /** Always exactly `['browser']`; see `DomainKnowledgeViewIntent.planes`. */
    planes: ['browser'];
    filePath: string;
  }>;
  playbooks: Array<{
    kind: 'playbook';
    key: string;
    title: string;
    description: string;
    steps: DomainKnowledgePlaybookStep[];
    planes: Array<'browser' | 'server'>;
    planesDeclared: boolean;
    onStepFailure: 'abort' | 'continue';
    enabled: boolean;
    filePath: string;
  }>;
  diagnostics: Array<{
    code: string;
    helper: 'defineIntent' | 'definePlaybook';
    message: string;
    filePath: string;
    line?: number;
    column?: number;
  }>;
}

export interface OxcScannerLike {
  scanAndResolve(): Promise<{
    results: {
      typeAliases: Record<string, string>;
      errors: Array<{
        filePath: string;
        message: string;
        line?: number;
        severity: 'error' | 'warning';
      }>;
      agentSurface?: ScannerAgentSurface;
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
    followSymbolicLinks?: boolean;
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
  discoverSourceFiles(options: {
    cwd: string;
    include: string[];
    exclude: string[];
    followSymbolicLinks?: boolean;
  }): Promise<string[]>;
  /**
   * Report an emitted intent whose derived WebMCP tool name a generated model
   * tool or a fixed UI tool also claims (#2725).
   *
   * The scanner owns the rule because it owns the tool-name derivation; core
   * owns the INPUT because only core resolves the exposure policy. Names are
   * passed rather than re-derived, so the scanner never becomes a second place
   * that decides what a generated tool is called.
   */
  checkAgentSurfaceToolNames(
    surface: ScannerAgentSurface,
    options: {
      generatedToolNames?: ReadonlyArray<{
        name: string;
        declaredBy?: string;
      }>;
      uiToolPrefixes?: readonly string[];
    },
  ): ScannerAgentSurface['diagnostics'];
}

export declare const SMRT_PACKAGES: string[];
export declare const RESET_RECIPE: string;

export interface ResetFinding {
  line: number;
  kind: 'rule' | 'import';
  selector: string;
  detail: string;
}

export interface ProjectResetFinding extends ResetFinding {
  file: string;
}

export declare function stripCssComments(css: string): string;
export declare function findUnlayeredResets(css: string): ResetFinding[];
export declare function unwrapSvelteGlobal(body: string): string;
export declare function findUnlayeredResetsInSvelte(source: string): ResetFinding[];
export declare function listCascadeSources(root: string): string[];
export declare function dependsOnSmrtUi(packageJson: Record<string, any> | null | undefined): boolean;
export declare function scanProjectForUnlayeredResets(
  root: string,
  options?: { packageJson?: Record<string, any> | null; requireSmrtDependency?: boolean },
): { applies: boolean; filesScanned: number; findings: ProjectResetFinding[] };

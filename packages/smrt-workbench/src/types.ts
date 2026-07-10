export type WorkbenchComponentType = (...args: any[]) => any;
export type WorkbenchComponentModule =
  | WorkbenchComponentType
  | {
      default: WorkbenchComponentType;
    };

export type WorkbenchComponentLoader = () => Promise<WorkbenchComponentModule>;

export type SmrtWorkbenchScopeMode = 'workspace' | 'package' | 'consumer';

export interface SmrtWorkbenchRouteDefinition {
  id: string;
  title: string;
  description?: string;
  defaultPath?: string;
  component?: WorkbenchComponentType;
  loadComponent?: WorkbenchComponentLoader;
  props?: Record<string, unknown>;
  tags?: string[];
  nav?: {
    label?: string;
    description?: string;
    icon?: string;
    order?: number;
    group?: string;
  };
}

export interface SmrtWorkbenchRouteModule {
  packageName: string;
  displayName?: string;
  description?: string;
  routes: Record<string, SmrtWorkbenchRouteDefinition>;
}

export interface SmrtWorkbenchRecommendedCommand {
  id: string;
  label: string;
  command: string;
  description?: string;
}

export interface SmrtWorkbenchModule {
  packageName: string;
  displayName?: string;
  description?: string;
  routeModule?: SmrtWorkbenchRouteModule;
  routeModules?: SmrtWorkbenchRouteModule[];
  recommendedCommands?: SmrtWorkbenchRecommendedCommand[];
  docs?: WorkbenchDocumentSummary[];
  examples?: WorkbenchExampleSummary[];
}

export type SmrtWorkbenchModuleExport =
  | SmrtWorkbenchModule
  | SmrtWorkbenchModule[]
  | {
      modules: SmrtWorkbenchModule[];
    };

export interface ResolvedWorkbenchRouteEntry
  extends SmrtWorkbenchRouteDefinition {
  packageName: string;
  moduleDisplayName: string;
  routeKey: string;
  qualifiedId: string;
  defaultPath: string;
}

export interface ResolvedWorkbenchModule
  extends Omit<
    SmrtWorkbenchModule,
    'displayName' | 'routeModule' | 'routeModules'
  > {
  displayName: string;
  routeModules: SmrtWorkbenchRouteModule[];
  routes: ResolvedWorkbenchRouteEntry[];
}

export interface WorkbenchScopeResolution {
  mode: SmrtWorkbenchScopeMode;
  cwd: string;
  projectRoot: string;
  workspaceRoot?: string;
  packageName?: string;
  packageDir?: string;
}

export interface WorkbenchDocumentSummary {
  kind: 'readme' | 'agents' | 'changelog' | 'generated' | 'docs' | 'other';
  title: string;
  path: string;
  content?: string;
  truncated?: boolean;
}

export interface WorkbenchExampleSummary {
  id: string;
  title: string;
  path?: string;
  language?: string;
  code?: string;
  source: 'file' | 'readme' | 'playground';
}

export interface WorkbenchKnowledgeSummary {
  manifestPath?: string;
  knowledgePath?: string;
  objectCount: number;
  relationshipCount: number;
  promptCount: number;
  mcpToolCount: number;
  surfaceCount: number;
  tags: string[];
  risks: string[];
  objectNames: string[];
}

export interface WorkbenchApiObjectFieldSummary {
  name: string;
  type?: string;
  required?: boolean;
  related?: string;
  description?: string;
}

export interface WorkbenchApiObjectSummary {
  name: string;
  className?: string;
  qualifiedName?: string;
  collection?: string;
  sourcePath?: string;
  typedocPath?: string;
  description?: string;
  fields: WorkbenchApiObjectFieldSummary[];
}

export type WorkbenchApiParameterLocation =
  | 'path'
  | 'query'
  | 'body'
  | 'option'
  | 'argument'
  | 'input';

export interface WorkbenchApiParameterSummary {
  name: string;
  type?: string;
  required?: boolean;
  location: WorkbenchApiParameterLocation;
  description?: string;
  defaultValue?: string;
}

export interface WorkbenchRestEndpointSummary {
  objectName: string;
  action: string;
  method: string;
  path: string;
  description: string;
  parameters: WorkbenchApiParameterSummary[];
}

export interface WorkbenchCliCommandSummary {
  objectName: string;
  action: string;
  command: string;
  description: string;
  parameters: WorkbenchApiParameterSummary[];
}

export interface WorkbenchMcpToolSummary {
  objectName: string;
  action: string;
  toolName: string;
  description: string;
  parameters: WorkbenchApiParameterSummary[];
}

export interface WorkbenchApiSummary {
  objectNames: string[];
  objects: WorkbenchApiObjectSummary[];
  restEndpoints: WorkbenchRestEndpointSummary[];
  cliCommands: WorkbenchCliCommandSummary[];
  mcpTools: WorkbenchMcpToolSummary[];
  endpointCount: number;
  routeFiles: string[];
}

export interface WorkbenchPackageSummary {
  name: string;
  version?: string;
  description?: string;
  source: 'workspace' | 'package' | 'app';
  directory?: string;
  relativeDirectory?: string;
  scripts: Record<string, string>;
  dependencies: Record<string, string>;
  devDependencies: Record<string, string>;
  peerDependencies: Record<string, string>;
  smrtDependencies: string[];
  sdkDependencies: string[];
  exportKeys: string[];
  docs: WorkbenchDocumentSummary[];
  examples: WorkbenchExampleSummary[];
  knowledge: WorkbenchKnowledgeSummary;
  api: WorkbenchApiSummary;
  migrations: string[];
  routeModuleCount: number;
  routeCount: number;
  playgroundEntryCount: number;
  recommendedCommands: SmrtWorkbenchRecommendedCommand[];
}

export interface SmrtWorkbenchProject {
  generatedAt: string;
  scope: WorkbenchScopeResolution;
  packages: WorkbenchPackageSummary[];
}

export interface DiscoveredWorkbenchTarget {
  packageName?: string;
  source: 'workspace' | 'package' | 'app';
  sourcePath?: string;
  runtimePath?: string;
  importSpecifier?: string;
}

export interface SmrtWorkbenchVitePluginOptions {
  mode?: 'auto' | 'workspace' | 'consumer';
  projectRoot?: string;
  workspaceRoot?: string;
  cwd?: string;
  packageName?: string;
  packagesPattern?: string;
  localWorkbenchPath?: string;
  localPlaygroundPath?: string;
}

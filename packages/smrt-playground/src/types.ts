export type PlaygroundComponentType = (...args: any[]) => any;
export type PlaygroundComponentModule =
  | PlaygroundComponentType
  | {
      default: PlaygroundComponentType;
    };
export type PlaygroundComponentLoader =
  () => Promise<PlaygroundComponentModule>;

export interface PlaygroundModuleMeta {
  name: string;
  displayName: string;
  description?: string;
  uiSlots?: Record<string, unknown>;
  models?: string[];
  collections?: string[];
}

export type SmrtPlaygroundMode = 'mock' | 'live';

export interface SmrtPlaygroundModeConfig {
  label?: string;
  description?: string;
  props?: Record<string, unknown>;
}

export interface SmrtPlaygroundEntry {
  id: string;
  title: string;
  description?: string;
  component?: PlaygroundComponentType;
  loadComponent?: PlaygroundComponentLoader;
  slotId?: string;
  order?: number;
  props?: Record<string, unknown>;
  tags?: string[];
  modes?: Partial<Record<SmrtPlaygroundMode, SmrtPlaygroundModeConfig | true>>;
}

export interface SmrtPlaygroundModule {
  packageName: string;
  displayName?: string;
  description?: string;
  moduleMeta?: PlaygroundModuleMeta;
  entries: SmrtPlaygroundEntry[];
}

export type SmrtPlaygroundModuleExport =
  | SmrtPlaygroundModule
  | SmrtPlaygroundModule[]
  | {
      modules: SmrtPlaygroundModule[];
    };

export interface ResolvedSmrtPlaygroundEntry
  extends Omit<SmrtPlaygroundEntry, 'modes'> {
  packageName: string;
  displayName: string;
  qualifiedId: string;
  availableModes: SmrtPlaygroundMode[];
  modes: Partial<Record<SmrtPlaygroundMode, SmrtPlaygroundModeConfig>>;
}

export interface ResolvedSmrtPlaygroundModule
  extends Omit<SmrtPlaygroundModule, 'displayName' | 'entries'> {
  displayName: string;
  entries: ResolvedSmrtPlaygroundEntry[];
}

export interface DiscoveredWorkspacePlayground {
  packageName: string;
  packageDir: string;
  sourcePath: string;
  runtimePath: string | null;
}

export interface DiscoveredInstalledPlayground {
  packageName: string;
  importSpecifier: string;
}

export interface DiscoveredPlaygroundTarget {
  packageName?: string;
  source: 'workspace' | 'package' | 'app';
  sourcePath?: string;
  runtimePath?: string;
  importSpecifier?: string;
}

export interface SmrtPlaygroundVitePluginOptions {
  mode?: 'auto' | 'workspace' | 'consumer';
  workspaceRoot?: string;
  packagesPattern?: string;
  localPlaygroundPath?: string;
}

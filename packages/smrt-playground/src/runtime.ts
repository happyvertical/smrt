import type {
  ResolvedSmrtPlaygroundEntry,
  ResolvedSmrtPlaygroundModule,
  SmrtPlaygroundMode,
  SmrtPlaygroundModeConfig,
  SmrtPlaygroundModule,
  SmrtPlaygroundModuleExport,
} from './types.js';
import { displayNameForSmrtPackage } from './utils.js';

function normalizeModeConfig(
  value: SmrtPlaygroundModeConfig | true | undefined,
): SmrtPlaygroundModeConfig | undefined {
  if (!value) {
    return undefined;
  }
  return value === true ? {} : value;
}

export function qualifyPlaygroundEntryId(
  packageName: string,
  entryId: string,
): string {
  return `${packageName}:${entryId}`;
}

export function coercePlaygroundModules(
  input: SmrtPlaygroundModuleExport | null | undefined,
): SmrtPlaygroundModule[] {
  if (!input) {
    return [];
  }

  if (Array.isArray(input)) {
    return input.filter(Boolean);
  }

  if ('modules' in input && Array.isArray(input.modules)) {
    return input.modules.filter(Boolean);
  }

  return [input as SmrtPlaygroundModule];
}

export function normalizePlaygroundModule(
  module: SmrtPlaygroundModule,
): ResolvedSmrtPlaygroundModule {
  const displayName =
    module.displayName ||
    module.moduleMeta?.displayName ||
    displayNameForSmrtPackage(module.packageName);

  const entries: ResolvedSmrtPlaygroundEntry[] = [...(module.entries || [])]
    .map((entry) => {
      const modes = {
        mock: normalizeModeConfig(entry.modes?.mock),
        live: normalizeModeConfig(entry.modes?.live),
      };
      const availableModes = (['mock', 'live'] as SmrtPlaygroundMode[]).filter(
        (mode) => Boolean(modes[mode]),
      );

      if (availableModes.length === 0) {
        modes.mock = {};
        availableModes.push('mock');
      }

      return {
        ...entry,
        displayName,
        packageName: module.packageName,
        qualifiedId: qualifyPlaygroundEntryId(module.packageName, entry.id),
        availableModes,
        modes,
      };
    })
    .sort((left, right) => {
      const orderDiff = (left.order ?? 999) - (right.order ?? 999);
      return orderDiff !== 0
        ? orderDiff
        : left.title.localeCompare(right.title);
    });

  return {
    ...module,
    displayName,
    entries,
  };
}

export function mergePlaygroundModules(
  modules: SmrtPlaygroundModule[],
): ResolvedSmrtPlaygroundModule[] {
  // Later modules intentionally override earlier ones so app-local entries can
  // replace installed package previews by packageName + entry id.
  const mergedByPackage = new Map<
    string,
    {
      module: ResolvedSmrtPlaygroundModule;
      entries: Map<string, ResolvedSmrtPlaygroundEntry>;
    }
  >();

  for (const inputModule of modules) {
    const module = normalizePlaygroundModule(inputModule);
    const existing = mergedByPackage.get(module.packageName);

    if (!existing) {
      mergedByPackage.set(module.packageName, {
        module: { ...module, entries: [] },
        entries: new Map(
          module.entries.map((entry) => [entry.qualifiedId, entry]),
        ),
      });
      continue;
    }

    existing.module = {
      ...existing.module,
      ...module,
      entries: [],
      displayName: module.displayName || existing.module.displayName,
      moduleMeta: module.moduleMeta || existing.module.moduleMeta,
    };

    for (const entry of module.entries) {
      existing.entries.set(entry.qualifiedId, entry);
    }
  }

  return [...mergedByPackage.values()]
    .map(({ module, entries }) => ({
      ...module,
      entries: [...entries.values()].sort((left, right) => {
        const orderDiff = (left.order ?? 999) - (right.order ?? 999);
        return orderDiff !== 0
          ? orderDiff
          : left.title.localeCompare(right.title);
      }),
    }))
    .sort((left, right) => left.displayName.localeCompare(right.displayName));
}

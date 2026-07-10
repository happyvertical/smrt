import type {
  ResolvedWorkbenchModule,
  ResolvedWorkbenchRouteEntry,
  SmrtWorkbenchModule,
  SmrtWorkbenchModuleExport,
  SmrtWorkbenchRouteModule,
} from './types.js';
import { displayNameForSmrtPackage } from './utils.js';

export type {
  ResolvedWorkbenchModule,
  ResolvedWorkbenchRouteEntry,
  SmrtWorkbenchModule,
  SmrtWorkbenchModuleExport,
  SmrtWorkbenchRouteDefinition,
  SmrtWorkbenchRouteModule,
} from './types.js';

export function defineWorkbenchModule(
  module: SmrtWorkbenchModule,
): SmrtWorkbenchModule {
  return module;
}

export function coerceWorkbenchModules(
  input: SmrtWorkbenchModuleExport | null | undefined,
): SmrtWorkbenchModule[] {
  if (!input) {
    return [];
  }

  if (Array.isArray(input)) {
    return input.filter(Boolean);
  }

  if ('modules' in input && Array.isArray(input.modules)) {
    return input.modules.filter(Boolean);
  }

  return [input as SmrtWorkbenchModule];
}

function collectRouteModules(
  module: SmrtWorkbenchModule,
): SmrtWorkbenchRouteModule[] {
  return [
    ...(module.routeModule ? [module.routeModule] : []),
    ...(module.routeModules || []),
  ].filter(Boolean);
}

export function qualifyWorkbenchRouteId(
  packageName: string,
  routeId: string,
): string {
  return `${packageName}:${routeId}`;
}

export function normalizeWorkbenchModule(
  module: SmrtWorkbenchModule,
): ResolvedWorkbenchModule {
  const displayName =
    module.displayName || displayNameForSmrtPackage(module.packageName);
  const routeModules = collectRouteModules(module);
  const routes: ResolvedWorkbenchRouteEntry[] = routeModules
    .flatMap((routeModule) => {
      const moduleDisplayName = routeModule.displayName || displayName;

      return Object.entries(routeModule.routes || {}).map(
        ([routeKey, route]) => {
          const routeId = route.id || routeKey;
          return {
            ...route,
            packageName: routeModule.packageName || module.packageName,
            moduleDisplayName,
            routeKey,
            qualifiedId: qualifyWorkbenchRouteId(
              routeModule.packageName || module.packageName,
              routeId,
            ),
            defaultPath: route.defaultPath || `/${routeId}`,
          };
        },
      );
    })
    .sort((left, right) => {
      const leftOrder = left.nav?.order ?? 999;
      const rightOrder = right.nav?.order ?? 999;
      const orderDiff = leftOrder - rightOrder;
      return orderDiff !== 0
        ? orderDiff
        : left.title.localeCompare(right.title);
    });

  return {
    ...module,
    displayName,
    routeModules,
    routes,
  };
}

export function mergeWorkbenchModules(
  modules: SmrtWorkbenchModule[],
): ResolvedWorkbenchModule[] {
  const byPackage = new Map<string, SmrtWorkbenchModule>();

  for (const module of modules) {
    const existing = byPackage.get(module.packageName);
    if (!existing) {
      byPackage.set(module.packageName, { ...module });
      continue;
    }

    byPackage.set(module.packageName, {
      ...existing,
      ...module,
      routeModule: undefined,
      routeModules: [
        ...(existing.routeModules || []),
        ...(existing.routeModule ? [existing.routeModule] : []),
        ...(module.routeModules || []),
        ...(module.routeModule ? [module.routeModule] : []),
      ],
      recommendedCommands: [
        ...(existing.recommendedCommands || []),
        ...(module.recommendedCommands || []),
      ],
      docs: [...(existing.docs || []), ...(module.docs || [])],
      examples: [...(existing.examples || []), ...(module.examples || [])],
    });
  }

  return [...byPackage.values()]
    .map((module) => normalizeWorkbenchModule(module))
    .sort((left, right) => left.displayName.localeCompare(right.displayName));
}

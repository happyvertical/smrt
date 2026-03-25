import {
  getClassName,
  isQualifiedName,
  ObjectRegistry,
} from '@happyvertical/smrt-core';

export type StiDiscriminatorUpgradeResult =
  | {
      action: 'skip';
      reason: 'already-current' | 'ambiguous' | 'unregistered' | 'unqualified';
    }
  | {
      action: 'upgrade';
      className: string;
      currentQualifiedName: string;
      sourceKind: 'simple' | 'stale-qualified';
    };

export function resolveStiDiscriminatorUpgrade(
  metaType: string,
): StiDiscriminatorUpgradeResult {
  const className = isQualifiedName(metaType)
    ? getClassName(metaType)
    : metaType;
  const matches = ObjectRegistry.findClassesByName(className);

  if (matches.length === 0) {
    return { action: 'skip', reason: 'unregistered' };
  }

  if (matches.length > 1) {
    return { action: 'skip', reason: 'ambiguous' };
  }

  const registeredClass = matches[0];
  const currentQualifiedName = registeredClass.qualifiedName;

  if (!currentQualifiedName) {
    return { action: 'skip', reason: 'unqualified' };
  }

  if (metaType === currentQualifiedName) {
    return { action: 'skip', reason: 'already-current' };
  }

  return {
    action: 'upgrade',
    className,
    currentQualifiedName,
    sourceKind: isQualifiedName(metaType) ? 'stale-qualified' : 'simple',
  };
}

import type { RegisteredClass } from './types';

export interface CollectionRegistrationLookup {
  findClass: (name: string) => RegisteredClass | undefined;
  findClassInPackage?: (
    packageName: string,
    className: string,
  ) => RegisteredClass | undefined;
  getInheritanceChain: (className: string) => string[];
}

export function isSmrtCollectionExtendsName(
  extendsName: string | undefined,
): boolean {
  return (
    extendsName === 'SmrtCollection' ||
    extendsName?.endsWith(':SmrtCollection') === true
  );
}

export function resolveRelatedRegistration(
  className: string,
  origin: RegisteredClass,
  lookup: CollectionRegistrationLookup,
): RegisteredClass | undefined {
  if (className.includes(':')) {
    return lookup.findClass(className);
  }

  if (origin.packageName && lookup.findClassInPackage) {
    return (
      lookup.findClassInPackage(origin.packageName, className) ||
      lookup.findClass(className)
    );
  }

  return lookup.findClass(className);
}

export function getCollectionChainRegistrations(
  className: string,
  registered: RegisteredClass,
  lookup: CollectionRegistrationLookup,
): RegisteredClass[] {
  const lookupName = registered.qualifiedName || registered.name || className;
  const chain = lookup.getInheritanceChain(lookupName);
  const registrations: RegisteredClass[] = [];

  for (const chainName of chain) {
    const chainEntry = resolveRelatedRegistration(
      chainName,
      registered,
      lookup,
    );
    if (chainEntry) {
      registrations.push(chainEntry);
    }
  }

  return registrations;
}

export function isCollectionRegistration(
  className: string,
  registered: RegisteredClass,
  lookup: CollectionRegistrationLookup,
): boolean {
  if (isSmrtCollectionExtendsName(registered.extends)) {
    return true;
  }

  return getCollectionChainRegistrations(className, registered, lookup).some(
    (chainEntry) => isSmrtCollectionExtendsName(chainEntry.extends),
  );
}

function getStaticItemClassName(
  registered: RegisteredClass,
): string | undefined {
  const itemClass = (
    registered.constructor as unknown as {
      _itemClass?: { name?: string };
    }
  )._itemClass;
  return itemClass?.name;
}

function getCollectionItemNameCandidates(className: string): string[] {
  const candidates: string[] = [];
  const simpleName = className.includes(':')
    ? className.slice(className.lastIndexOf(':') + 1)
    : className;

  const addCandidate = (candidate: string): void => {
    if (
      candidate &&
      candidate !== simpleName &&
      !candidates.includes(candidate)
    ) {
      candidates.push(candidate);
    }
  };

  if (simpleName.endsWith('Collection')) {
    addCandidate(simpleName.slice(0, -'Collection'.length));
  }

  if (simpleName.endsWith('ies')) {
    addCandidate(`${simpleName.slice(0, -3)}y`);
  } else if (simpleName.endsWith('s')) {
    addCandidate(simpleName.slice(0, -1));
  }

  return candidates;
}

function inferCollectionItemClassName(
  className: string,
  registered: RegisteredClass,
  lookup: CollectionRegistrationLookup,
): string | undefined {
  const lookupName = registered.name || className;

  for (const candidate of getCollectionItemNameCandidates(lookupName)) {
    const candidateRegistration = resolveRelatedRegistration(
      candidate,
      registered,
      lookup,
    );
    if (candidateRegistration) {
      return candidate;
    }
  }

  return undefined;
}

export function resolveCollectionItemClassName(
  className: string,
  registered: RegisteredClass,
  lookup: CollectionRegistrationLookup,
): string | undefined {
  const staticItemClassName = getStaticItemClassName(registered);
  if (staticItemClassName) {
    return staticItemClassName;
  }

  if (registered.extendsTypeArg) {
    return registered.extendsTypeArg;
  }

  const inferredItemClassName = inferCollectionItemClassName(
    className,
    registered,
    lookup,
  );
  if (inferredItemClassName) {
    return inferredItemClassName;
  }

  const chain = getCollectionChainRegistrations(
    className,
    registered,
    lookup,
  ).reverse();

  for (const chainEntry of chain) {
    if (chainEntry === registered) {
      continue;
    }
    if (chainEntry.extendsTypeArg) {
      return chainEntry.extendsTypeArg;
    }
  }

  return undefined;
}

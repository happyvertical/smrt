/**
 * Inheritance Resolver
 *
 * Resolves class inheritance chains using in-memory class map.
 * Handles STI (Single Table Inheritance) detection and field merging.
 */

import type {
  ExternalManifest,
  RawClassDefinition,
  RawFieldDefinition,
  ResolvedClassDefinition,
} from './types.js';

/**
 * Framework base classes that are always recognized
 */
const FRAMEWORK_BASE_CLASSES = new Set([
  'SmrtObject',
  'SmrtClass',
  'SmrtCollection',
]);

/**
 * Inheritance resolver for SMRT classes
 */
export class InheritanceResolver {
  /** Map of className -> RawClassDefinition */
  private classMap: Map<string, RawClassDefinition> = new Map();

  /** External package manifests for cross-package resolution */
  private externalManifests: Map<string, ExternalManifest> = new Map();

  /** Known base classes (user-provided) */
  private knownBaseClasses: Set<string>;

  /** Cache of resolved inheritance chains */
  private chainCache: Map<string, string[]> = new Map();

  constructor(
    options: {
      baseClasses?: string[];
      externalManifests?: Map<string, ExternalManifest>;
    } = {},
  ) {
    this.knownBaseClasses = new Set([
      ...FRAMEWORK_BASE_CLASSES,
      ...(options.baseClasses || []),
    ]);
    this.externalManifests = options.externalManifests || new Map();
  }

  /**
   * Add classes from scan results
   */
  addClasses(classes: RawClassDefinition[]): void {
    for (const classDef of classes) {
      this.classMap.set(classDef.className, classDef);
    }
    // Clear cache when classes are added
    this.chainCache.clear();
  }

  /**
   * Add external manifest for cross-package resolution
   */
  addExternalManifest(manifest: ExternalManifest): void {
    this.externalManifests.set(manifest.packageName, manifest);
    this.chainCache.clear();
  }

  /**
   * Resolve all classes and return resolved definitions
   */
  resolveAll(): ResolvedClassDefinition[] {
    const resolved: ResolvedClassDefinition[] = [];

    for (const classDef of this.classMap.values()) {
      // Only process @smrt() decorated classes
      if (!classDef.hasSmartDecorator) continue;

      const resolvedClass = this.resolve(classDef);
      resolved.push(resolvedClass);
    }

    return resolved;
  }

  /**
   * Resolve a single class definition
   */
  resolve(classDef: RawClassDefinition): ResolvedClassDefinition {
    const inheritanceChain = this.resolveInheritanceChain(classDef.className);
    const stiBase = this.findSTIBase(inheritanceChain);
    const effectiveTableStrategy = this.determineTableStrategy(
      classDef,
      inheritanceChain,
    );
    const isFrameworkBase = this.knownBaseClasses.has(classDef.className);
    const isSTI = effectiveTableStrategy === 'sti';

    // Merge fields for STI classes
    const allFields = isSTI
      ? this.mergeFieldsForSTI(inheritanceChain)
      : classDef.fields;

    return {
      ...classDef,
      inheritanceChain,
      stiBase,
      effectiveTableStrategy,
      isSTI,
      isFrameworkBase,
      allFields,
      packageName: null, // Will be set by manifest adapter
    };
  }

  /**
   * Resolve inheritance chain from base to this class
   * Returns: ['SmrtObject', 'Content', 'Article'] for class Article extends Content
   */
  resolveInheritanceChain(className: string): string[] {
    // Check cache
    const cached = this.chainCache.get(className);
    if (cached) return cached;

    const chain: string[] = [];
    const visited = new Set<string>();
    let current: string | null = className;

    while (current && !visited.has(current)) {
      visited.add(current);
      chain.unshift(current);

      // Check if this is a framework base class
      if (this.knownBaseClasses.has(current)) {
        break;
      }

      // Find parent class
      const classDef = this.findClassDefinition(current);
      current = classDef?.extendsClause || null;
    }

    // Cache result
    this.chainCache.set(className, chain);

    return chain;
  }

  /**
   * Find class definition by name
   * Searches: local classes -> external manifests -> framework bases
   */
  findClassDefinition(className: string): RawClassDefinition | null {
    // 1. Check local classes
    const local = this.classMap.get(className);
    if (local) return local;

    // 2. Check external manifests
    for (const manifest of this.externalManifests.values()) {
      const external = manifest.classes.get(className);
      if (external) return external;
    }

    // 3. Check if it's a known base class
    if (this.knownBaseClasses.has(className)) {
      // Return a minimal definition for framework bases
      return {
        className,
        filePath: '',
        extendsClause: null,
        extendsTypeArg: null,
        decoratorConfig: null,
        hasSmartDecorator: false,
        fields: [],
        methods: [],
        startLine: 0,
        endLine: 0,
      };
    }

    return null;
  }

  /**
   * Find the STI base class in an inheritance chain
   * Returns the first class with tableStrategy: 'sti'
   */
  findSTIBase(chain: string[]): string | null {
    for (const className of chain) {
      const classDef = this.findClassDefinition(className);
      if (classDef?.decoratorConfig?.tableStrategy === 'sti') {
        return className;
      }
    }
    return null;
  }

  /**
   * Determine effective table strategy for a class
   * STI is inherited from ancestors
   */
  determineTableStrategy(
    classDef: RawClassDefinition,
    chain: string[],
  ): 'sti' | 'cti' {
    // Check if this class explicitly declares a strategy
    if (classDef.decoratorConfig?.tableStrategy) {
      return classDef.decoratorConfig.tableStrategy;
    }

    // Check ancestors for STI
    for (const className of chain) {
      if (className === classDef.className) continue;

      const ancestorDef = this.findClassDefinition(className);
      if (ancestorDef?.decoratorConfig?.tableStrategy === 'sti') {
        return 'sti';
      }
    }

    return 'cti';
  }

  /**
   * Merge fields from all classes in STI hierarchy
   * Base class fields come first, then descendants
   */
  mergeFieldsForSTI(chain: string[]): RawFieldDefinition[] {
    const allFields: RawFieldDefinition[] = [];
    const seenNames = new Set<string>();

    for (const className of chain) {
      const classDef = this.findClassDefinition(className);
      if (!classDef) continue;

      for (const field of classDef.fields) {
        // Skip if already seen (child overrides parent)
        if (seenNames.has(field.name)) continue;

        seenNames.add(field.name);
        allFields.push(field);
      }
    }

    return allFields;
  }

  /**
   * Get all descendants of a class (for STI schema generation)
   */
  getDescendants(className: string): string[] {
    const descendants: string[] = [];

    for (const [name, classDef] of this.classMap) {
      if (name === className) continue;

      const chain = this.resolveInheritanceChain(name);
      if (chain.includes(className)) {
        descendants.push(name);
      }
    }

    return descendants;
  }

  /**
   * Check if a class is part of an STI hierarchy
   */
  isSTIClass(className: string): boolean {
    const chain = this.resolveInheritanceChain(className);
    return this.findSTIBase(chain) !== null;
  }

  /**
   * Get statistics about resolved classes
   */
  getStats(): {
    totalClasses: number;
    smrtClasses: number;
    stiClasses: number;
    maxInheritanceDepth: number;
  } {
    let smrtClasses = 0;
    let stiClasses = 0;
    let maxInheritanceDepth = 0;

    for (const classDef of this.classMap.values()) {
      if (classDef.hasSmartDecorator) {
        smrtClasses++;

        const chain = this.resolveInheritanceChain(classDef.className);
        maxInheritanceDepth = Math.max(maxInheritanceDepth, chain.length);

        if (this.findSTIBase(chain)) {
          stiClasses++;
        }
      }
    }

    return {
      totalClasses: this.classMap.size,
      smrtClasses,
      stiClasses,
      maxInheritanceDepth,
    };
  }
}

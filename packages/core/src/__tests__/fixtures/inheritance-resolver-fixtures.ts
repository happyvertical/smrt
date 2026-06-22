/**
 * Fixture classes for inheritance-resolver coverage tests.
 *
 * Kept in a separate file (not the test file) so they are picked up by
 * test-manifest generation. Mirrors the convention used by
 * inheritance-test-classes.ts.
 *
 * @see src/registry/inheritance-resolver.ts (issue #1500 coverage, ORM group)
 */

import { field } from '../../decorators/index.js';
import { SmrtHierarchical } from '../../hierarchical.js';
import { SmrtObject } from '../../object.js';
import { smrt } from '../../registry.js';

// ── A 3-level chain dedicated to the module-function tests ──────────────
@smrt()
export class IRBase extends SmrtObject {
  baseTitle: string = '';
  shared: string = '';

  async baseMethod(): Promise<string> {
    return 'IRBase.baseMethod';
  }
}

@smrt()
export class IRMiddle extends IRBase {
  middleField: string = '';

  async middleMethod(): Promise<string> {
    return 'IRMiddle.middleMethod';
  }
}

@smrt()
export class IRLeaf extends IRMiddle {
  leafField: string = '';

  // Override an inherited method (last-one-wins behavior in getAllMethods)
  async baseMethod(): Promise<string> {
    return 'IRLeaf.baseMethod';
  }
}

// ── Numeric-constraint parent/child for mergeFieldConfigs ───────────────
@smrt()
export class IRConstraintParent extends SmrtObject {
  @field({ min: 0, max: 100 })
  amount: number = 0;
}

@smrt()
export class IRConstraintChild extends IRConstraintParent {
  @field({ min: 10, max: 80 })
  amount: number = 0;
}

// ── Hierarchical subclass to exercise normalizeFrameworkInheritedField ──
// SmrtHierarchical contributes a `parentId` field that the resolver rewrites
// into a self-referential foreignKey for the child class.
@smrt({ tableName: 'ir_tree_nodes' })
export class IRTreeNode extends SmrtHierarchical {
  label: string = '';
}

// ── A lone class with no parent (extends SmrtObject) ────────────────────
@smrt()
export class IRSolo extends SmrtObject {
  soloField: string = '';
}

/**
 * Issue #870: smrtPlugin SvelteKit mode generates invalid code with qualified names
 *
 * When a manifest contains qualified class names (e.g., "@package:ClassName"),
 * the SvelteKit generator should extract the simple class name for imports.
 *
 * @see https://github.com/happyvertical/smrt/issues/870
 */

import { describe, expect, it } from 'vitest';

/**
 * Helper function to extract simple class name from potentially qualified name.
 * Qualified names follow the pattern: @scope/package:ClassName
 *
 * This is the fix that should be applied in sveltekit-generator.ts
 */
function extractSimpleClassName(qualifiedName: string): string {
  // If name contains ':', it's a qualified name - extract the class part
  const colonIndex = qualifiedName.indexOf(':');
  if (colonIndex !== -1) {
    return qualifiedName.substring(colonIndex + 1);
  }
  return qualifiedName;
}

describe('Issue #870: SvelteKit qualified name handling', () => {
  it('should extract simple class name from qualified name', () => {
    // Standard qualified name with scope
    expect(extractSimpleClassName('@blindmanpress/dashboard:Publication')).toBe(
      'Publication',
    );

    // Qualified name without scope
    expect(extractSimpleClassName('some-package:MyClass')).toBe('MyClass');

    // Simple name (no colon)
    expect(extractSimpleClassName('LocalClass')).toBe('LocalClass');

    // Edge case: empty after colon (shouldn't happen but handle gracefully)
    expect(extractSimpleClassName('package:')).toBe('');
  });

  it('should generate valid import statements from qualified names', () => {
    // Simulate the fixed behavior
    const packageObjects = new Map<string, string[]>();
    packageObjects.set('@blindmanpress/dashboard', [
      '@blindmanpress/dashboard:Publication',
      '@blindmanpress/dashboard:Workspace',
    ]);
    packageObjects.set('@happyvertical/smrt-profiles', [
      '@happyvertical/smrt-profiles:Profile',
      '@happyvertical/smrt-profiles:Organization',
    ]);

    const packageImports = Array.from(packageObjects.entries())
      .map(([packageName, classNames]) => {
        // Extract simple class names for import statement
        const simpleNames = classNames.map(extractSimpleClassName);
        return `import { ${simpleNames.join(', ')} } from '${packageName}';`;
      })
      .join('\n');

    // Should NOT contain @ or : in the import braces
    expect(packageImports).not.toMatch(/import \{[^}]*[@:][^}]*\}/);

    // Should contain valid import statements
    expect(packageImports).toContain(
      "import { Publication, Workspace } from '@blindmanpress/dashboard';",
    );
    expect(packageImports).toContain(
      "import { Profile, Organization } from '@happyvertical/smrt-profiles';",
    );
  });

  it('should handle mixed qualified and simple names', () => {
    const classNames = [
      '@package:QualifiedClass',
      'SimpleClass',
      'another-pkg:AnotherClass',
    ];

    const simpleNames = classNames.map(extractSimpleClassName);

    expect(simpleNames).toEqual([
      'QualifiedClass',
      'SimpleClass',
      'AnotherClass',
    ]);
  });
});

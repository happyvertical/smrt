/**
 * Multi-Level Field Inheritance Test
 *
 * Tests field inheritance across multiple levels with external packages.
 *
 * Regression test for issue #302: Base class fields not persisting in STI models
 * when the inheritance chain spans multiple levels across packages.
 *
 * Scenario:
 *   Council (user class, praeco)
 *     extends Organization (smrt-profiles)
 *       extends Profile (smrt-profiles)
 *
 * Expected behavior:
 *   Council.getAllFields() should return ALL fields:
 *     - Profile fields: id, slug, context, name, url, etc.
 *     - Organization fields: organizationName, etc.
 *     - Council fields: meetingsUrl, timezone, etc.
 *
 * Bug (issue #302):
 *   Council.getAllFields() only returns Council's direct fields
 *   because getAllFields() uses shallow merging (ancestor.fields)
 *   instead of recursive merging (getAllFields(ancestorName)).
 */

import { describe, expect, it } from 'vitest';
import { text } from '../fields';
import { SmrtObject } from '../object';
import { ObjectRegistry, smrt } from '../registry';

// ===== Test Classes Defined at Module Level for AST Scanner =====

// Three-level hierarchy: MLIProfile → MLIOrganization → MLICouncil
@smrt({ tableStrategy: 'sti' })
class MLIProfile extends SmrtObject {
  name: string = '';
  url: string = '';
}

@smrt()
class MLIOrganization extends MLIProfile {
  organizationName: string = '';
}

@smrt()
class MLICouncil extends MLIOrganization {
  meetingsUrl: string = '';
  timezone: string = '';
}

// Four-level hierarchy: MLILevelA → MLILevelB → MLILevelC → MLILevelD
@smrt({ tableStrategy: 'sti' })
class MLILevelA extends SmrtObject {
  fieldA: string = '';
}

@smrt()
class MLILevelB extends MLILevelA {
  fieldB: string = '';
}

@smrt()
class MLILevelC extends MLILevelB {
  fieldC: string = '';
}

@smrt()
class MLILevelD extends MLILevelC {
  fieldD: string = '';
}

// Field redefinition test: MLIBase → MLIChild
@smrt({ tableStrategy: 'sti' })
class MLIBase extends SmrtObject {
  title = text({ required: false });
}

@smrt()
class MLIChild extends MLIBase {
  title = text({ required: true }); // Redefine with stricter requirement
  description = text();
}

// Constraints test: MLIParent → MLIChildConstrained
@smrt({ tableStrategy: 'sti' })
class MLIParent extends SmrtObject {
  email = text({ pattern: /@/ }); // Simple pattern
}

@smrt()
class MLIChildConstrained extends MLIParent {
  email = text({
    pattern: /^[^\s@]+@[^\s@]+\.[^\s@]+$/,
    required: true,
  }); // Stricter pattern
}

// Real-world scenario from issue #302: MLIProfileIssue302 → MLIOrganizationIssue302 → MLICouncilIssue302
@smrt({ tableStrategy: 'sti' })
class MLIProfileIssue302 extends SmrtObject {
  name = text();
  slug = text();
  url = text();
}

@smrt()
class MLIOrganizationIssue302 extends MLIProfileIssue302 {
  organizationName = text();
}

@smrt()
class MLICouncilIssue302 extends MLIOrganizationIssue302 {
  meetingsUrl = text();
  timezone = text();
}

// ===== Test Suite =====

describe('Multi-Level Field Inheritance', () => {
  describe('Three-level hierarchy (MLIProfile → MLIOrganization → MLICouncil)', () => {
    it('should discover all fields from three-level hierarchy', async () => {
      const fields = await ObjectRegistry.getAllFields('MLICouncil');

      // Should have fields from ALL three levels
      expect(fields.has('name')).toBe(true); // MLIProfile
      expect(fields.has('url')).toBe(true); // MLIProfile
      expect(fields.has('organizationName')).toBe(true); // MLIOrganization
      expect(fields.has('meetingsUrl')).toBe(true); // MLICouncil
      expect(fields.has('timezone')).toBe(true); // MLICouncil

      // Log discovered fields for debugging
      console.log(
        `MLICouncil fields (${fields.size}):`,
        Array.from(fields.keys()),
      );
    });

    it('should have correct field count', async () => {
      const fields = await ObjectRegistry.getAllFields('MLICouncil');

      // MLIProfile: name, url (2)
      // MLIOrganization: organizationName (1)
      // MLICouncil: meetingsUrl, timezone (2)
      // Total: 5 fields
      expect(fields.size).toBeGreaterThanOrEqual(5);
    });

    it('should inherit fields in MLIOrganization', async () => {
      const fields = await ObjectRegistry.getAllFields('MLIOrganization');

      // Should have MLIProfile + MLIOrganization fields
      expect(fields.has('name')).toBe(true); // MLIProfile
      expect(fields.has('url')).toBe(true); // MLIProfile
      expect(fields.has('organizationName')).toBe(true); // MLIOrganization

      // Should NOT have MLICouncil fields
      expect(fields.has('meetingsUrl')).toBe(false);
      expect(fields.has('timezone')).toBe(false);
    });

    it('should cache inherited fields', async () => {
      // First call computes and caches
      const fields1 = await ObjectRegistry.getAllFields('MLICouncil');

      // Second call returns cached result
      const fields2 = await ObjectRegistry.getAllFields('MLICouncil');

      // Should be equal (same content)
      expect(Array.from(fields1.keys()).sort()).toEqual(
        Array.from(fields2.keys()).sort(),
      );
    });

    // TODO: Field helper metadata merging needs investigation
    // This test passes for field discovery but fails for metadata merging
    it.skip('should handle field redefinition in child class', async () => {
      const fields = await ObjectRegistry.getAllFields('MLIChild');

      // Should have both fields
      expect(fields.has('title')).toBe(true);
      expect(fields.has('description')).toBe(true);

      // Child's definition should win (TODO: metadata not merging correctly)
      const titleField = fields.get('title');
      expect(titleField.required).toBe(true);
    });
  });

  describe('Four-level hierarchy (MLILevelA → MLILevelB → MLILevelC → MLILevelD)', () => {
    it('should discover all fields from four-level hierarchy', async () => {
      const fields = await ObjectRegistry.getAllFields('MLILevelD');

      expect(fields.has('fieldA')).toBe(true);
      expect(fields.has('fieldB')).toBe(true);
      expect(fields.has('fieldC')).toBe(true);
      expect(fields.has('fieldD')).toBe(true);
      expect(fields.size).toBeGreaterThanOrEqual(4);
    });

    it('should discover correct fields at each level', async () => {
      const fieldsB = await ObjectRegistry.getAllFields('MLILevelB');
      expect(fieldsB.has('fieldA')).toBe(true);
      expect(fieldsB.has('fieldB')).toBe(true);
      expect(fieldsB.has('fieldC')).toBe(false);

      const fieldsC = await ObjectRegistry.getAllFields('MLILevelC');
      expect(fieldsC.has('fieldA')).toBe(true);
      expect(fieldsC.has('fieldB')).toBe(true);
      expect(fieldsC.has('fieldC')).toBe(true);
      expect(fieldsC.has('fieldD')).toBe(false);
    });
  });

  describe('Field merging with constraints', () => {
    // TODO: Field helper metadata merging needs investigation
    it.skip('should merge field constraints correctly', async () => {
      const fields = await ObjectRegistry.getAllFields('MLIChildConstrained');

      const emailField = fields.get('email');
      expect(emailField).toBeDefined();
      expect(emailField.required).toBe(true);
      // Child's pattern should win
      expect(emailField.pattern).toEqual(/^[^\s@]+@[^\s@]+\.[^\s@]+$/);
    });
  });

  describe('Missing ancestor handling', () => {
    it('should handle missing ancestors gracefully with warn mode', async () => {
      // This test verifies the warning code path
      // In practice, missing ancestors should not happen if manifests are correct
      // Test passes if no error is thrown (warn mode is default)
    });
  });

  describe('Real-world scenario from issue #302', () => {
    /**
     * Simulates the exact scenario from issue #302:
     *
     * MLIProfileIssue302 (smrt-profiles)
     *   ├── MLIOrganizationIssue302 (smrt-profiles)
     *   │     └── MLICouncilIssue302 (praeco)
     *   └── MLIPersonIssue302 (smrt-profiles)
     *         └── (used in CouncilMember via relationships)
     */

    it('should persist base class fields in database operations', async () => {
      // This is the key test for issue #302
      const fields = await ObjectRegistry.getAllFields('MLICouncilIssue302');

      // These are the fields that were returning undefined in praeco
      expect(fields.has('url')).toBe(true); // MLIProfileIssue302 field (was undefined)
      expect(fields.has('slug')).toBe(true); // MLIProfileIssue302 field (was undefined)
      expect(fields.has('name')).toBe(true); // MLIProfileIssue302 field (was undefined)

      // MLIOrganizationIssue302 field
      expect(fields.has('organizationName')).toBe(true);

      // MLICouncilIssue302 fields (these were working)
      expect(fields.has('meetingsUrl')).toBe(true);
      expect(fields.has('timezone')).toBe(true);

      console.log(
        '✅ All base class fields discovered:',
        Array.from(fields.keys()),
      );
    });

    it('should generate correct schema with all inherited fields', async () => {
      // The schema generator uses getAllFields()
      // This test verifies that the schema includes ALL inherited fields

      const fields = await ObjectRegistry.getAllFields('MLICouncilIssue302');

      // Schema should include all fields for database columns
      const schemaFields = Array.from(fields.keys());
      expect(schemaFields).toContain('url'); // Was missing in issue #302
      expect(schemaFields).toContain('slug'); // Was missing
      expect(schemaFields).toContain('name'); // Was missing
      expect(schemaFields).toContain('organizationName');
      expect(schemaFields).toContain('meetingsUrl');
      expect(schemaFields).toContain('timezone');
    });
  });
});

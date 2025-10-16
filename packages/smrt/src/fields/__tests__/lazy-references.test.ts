/**
 * Tests for lazy string-based references in foreignKey, oneToMany, and manyToMany
 *
 * Ensures that the field functions support string references to avoid circular
 * dependency issues during module initialization.
 */

import { describe, it, expect } from 'vitest';
import { foreignKey, oneToMany, manyToMany } from '../index';

describe('Lazy String References', () => {
  describe('foreignKey', () => {
    it('should accept string reference', () => {
      const field = foreignKey('Customer', { required: true });

      expect(field.type).toBe('foreignKey');
      expect(field.options.related).toBe('Customer');
      expect(field.options.required).toBe(true);
    });

    it('should accept lazy function reference', () => {
      class Customer {}
      const field = foreignKey(() => Customer, { required: true });

      expect(field.type).toBe('foreignKey');
      expect(field.options.related).toBe('Customer');
      expect(field.options.required).toBe(true);
    });

    it('should accept direct class reference (legacy)', () => {
      class Customer {
        static name = 'Customer';
      }
      const field = foreignKey(Customer, { required: true });

      expect(field.type).toBe('foreignKey');
      expect(field.options.related).toBe('Customer');
      expect(field.options.required).toBe(true);
    });

    it('should handle onDelete option', () => {
      const field = foreignKey('Product', { onDelete: 'cascade' });

      expect(field.options.onDelete).toBe('cascade');
    });

    it('should not store relatedClass for string references', () => {
      const field = foreignKey('Customer');

      expect((field as any).relatedClass).toBeUndefined();
    });

    it('should store relatedClass for direct class references', () => {
      class Customer {}
      const field = foreignKey(Customer);

      expect((field as any).relatedClass).toBe(Customer);
    });
  });

  describe('oneToMany', () => {
    it('should accept string reference', () => {
      const field = oneToMany('Order');

      expect(field.type).toBe('oneToMany');
      expect(field.options.related).toBe('Order');
    });

    it('should accept lazy function reference', () => {
      class Order {}
      const field = oneToMany(() => Order);

      expect(field.type).toBe('oneToMany');
      expect(field.options.related).toBe('Order');
    });

    it('should accept direct class reference (legacy)', () => {
      class Order {
        static name = 'Order';
      }
      const field = oneToMany(Order);

      expect(field.type).toBe('oneToMany');
      expect(field.options.related).toBe('Order');
    });

    it('should handle onDelete option', () => {
      const field = oneToMany('Order', { onDelete: 'cascade' });

      expect(field.options.onDelete).toBe('cascade');
    });
  });

  describe('manyToMany', () => {
    it('should accept string reference', () => {
      const field = manyToMany('Tag');

      expect(field.type).toBe('manyToMany');
      expect(field.options.related).toBe('Tag');
    });

    it('should accept lazy function reference', () => {
      class Tag {}
      const field = manyToMany(() => Tag);

      expect(field.type).toBe('manyToMany');
      expect(field.options.related).toBe('Tag');
    });

    it('should accept direct class reference (legacy)', () => {
      class Tag {
        static name = 'Tag';
      }
      const field = manyToMany(Tag);

      expect(field.type).toBe('manyToMany');
      expect(field.options.related).toBe('Tag');
    });

    it('should handle onDelete option', () => {
      const field = manyToMany('Category', { onDelete: 'cascade' });

      expect(field.options.onDelete).toBe('cascade');
    });
  });

  describe('Circular Dependency Prevention', () => {
    it('should allow mutually referencing classes with string references', () => {
      // Simulates the circular dependency scenario from Issue #142
      // Before fix: foreignKey(Profile) would fail if Profile isn't loaded yet
      // After fix: foreignKey('Profile') works regardless of load order

      const profileField = foreignKey('Profile', { required: true });
      const metadataField = foreignKey('ProfileMetadata', { required: true });

      expect(profileField.options.related).toBe('Profile');
      expect(metadataField.options.related).toBe('ProfileMetadata');
    });

    it('should allow self-referencing relationships', () => {
      // Self-referencing like: parentId = foreignKey('Category')
      const parentField = foreignKey('Category');

      expect(parentField.options.related).toBe('Category');
    });

    it('should work in complex relationship graphs', () => {
      // Complex scenario: A -> B -> C -> A
      const aToB = foreignKey('ModelB');
      const bToC = foreignKey('ModelC');
      const cToA = foreignKey('ModelA');

      expect(aToB.options.related).toBe('ModelB');
      expect(bToC.options.related).toBe('ModelC');
      expect(cToA.options.related).toBe('ModelA');
    });
  });

  describe('Type Consistency', () => {
    it('should return Field instances for all reference types', () => {
      const stringRef = foreignKey('Customer');
      const functionRef = foreignKey(() => class Customer {});
      class Customer {}
      const classRef = foreignKey(Customer);

      expect(stringRef.constructor.name).toBe('Field');
      expect(functionRef.constructor.name).toBe('Field');
      expect(classRef.constructor.name).toBe('Field');
    });

    it('should preserve all options regardless of reference type', () => {
      const options = {
        required: true,
        onDelete: 'cascade' as const,
      };

      const stringRef = foreignKey('Customer', options);
      const functionRef = foreignKey(() => class Customer {}, options);
      class Customer {}
      const classRef = foreignKey(Customer, options);

      expect(stringRef.options.required).toBe(true);
      expect(stringRef.options.onDelete).toBe('cascade');

      expect(functionRef.options.required).toBe(true);
      expect(functionRef.options.onDelete).toBe('cascade');

      expect(classRef.options.required).toBe(true);
      expect(classRef.options.onDelete).toBe('cascade');
    });
  });
});

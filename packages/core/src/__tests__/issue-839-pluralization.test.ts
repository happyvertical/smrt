/**
 * Tests for Issue #839: Table name pluralization fix
 *
 * Verifies that classnameToTablename() and related functions
 * produce correct English plurals using the pluralize library.
 *
 * @see https://github.com/happyvertical/smrt/issues/839
 */

import { describe, expect, it } from 'vitest';
import {
  classnameToTablename,
  generateTableRenameMigrations,
  legacyClassnameToTablename,
  pluralize,
  tableNameFromClass,
} from '../utils.js';

describe('Issue #839: Table name pluralization', () => {
  describe('pluralize()', () => {
    it('should handle consonant + y → ies', () => {
      expect(pluralize('currency')).toBe('currencies');
      expect(pluralize('entry')).toBe('entries');
      expect(pluralize('category')).toBe('categories');
      expect(pluralize('company')).toBe('companies');
      expect(pluralize('property')).toBe('properties');
      expect(pluralize('activity')).toBe('activities');
    });

    it('should handle vowel + y → ys (keep y)', () => {
      expect(pluralize('key')).toBe('keys');
      expect(pluralize('day')).toBe('days');
      expect(pluralize('way')).toBe('ways');
      expect(pluralize('monkey')).toBe('monkeys');
      expect(pluralize('attorney')).toBe('attorneys');
    });

    it('should handle words ending in ch → ches', () => {
      expect(pluralize('batch')).toBe('batches');
      expect(pluralize('match')).toBe('matches');
      expect(pluralize('watch')).toBe('watches');
      expect(pluralize('branch')).toBe('branches');
    });

    it('should handle words ending in sh → shes', () => {
      expect(pluralize('flash')).toBe('flashes');
      expect(pluralize('wish')).toBe('wishes');
      expect(pluralize('crash')).toBe('crashes');
    });

    it('should handle words ending in x → xes', () => {
      expect(pluralize('box')).toBe('boxes');
      expect(pluralize('index')).toBe('indices'); // pluralize library uses Latin plural
      expect(pluralize('tax')).toBe('taxes');
    });

    it('should handle words ending in s → ses', () => {
      expect(pluralize('class')).toBe('classes');
      expect(pluralize('address')).toBe('addresses');
      expect(pluralize('status')).toBe('statuses');
    });

    it('should handle words ending in z → zes (with doubling)', () => {
      // pluralize library correctly handles consonant doubling
      expect(pluralize('quiz')).toBe('quizzes');
      expect(pluralize('buzz')).toBe('buzzes');
      expect(pluralize('fizz')).toBe('fizzes');
    });

    it('should handle regular words → s', () => {
      expect(pluralize('product')).toBe('products');
      expect(pluralize('user')).toBe('users');
      expect(pluralize('account')).toBe('accounts');
      expect(pluralize('document')).toBe('documents');
    });

    it('should handle irregular plurals', () => {
      expect(pluralize('person')).toBe('people');
      expect(pluralize('child')).toBe('children');
      expect(pluralize('man')).toBe('men');
      expect(pluralize('woman')).toBe('women');
      expect(pluralize('foot')).toBe('feet');
      expect(pluralize('tooth')).toBe('teeth');
      expect(pluralize('mouse')).toBe('mice');
    });

    it('should handle snake_case by only pluralizing last word', () => {
      expect(pluralize('journal_entry')).toBe('journal_entries');
      expect(pluralize('statement_batch')).toBe('statement_batches');
      expect(pluralize('expense_category')).toBe('expense_categories');
      expect(pluralize('api_key')).toBe('api_keys');
    });
  });

  describe('classnameToTablename()', () => {
    it('should correctly pluralize class names ending in y', () => {
      expect(classnameToTablename('Currency')).toBe('currencies');
      expect(classnameToTablename('JournalEntry')).toBe('journal_entries');
      expect(classnameToTablename('ExpenseCategory')).toBe(
        'expense_categories',
      );
      expect(classnameToTablename('Activity')).toBe('activities');
    });

    it('should correctly pluralize class names ending in ch/sh/x/s', () => {
      expect(classnameToTablename('StatementBatch')).toBe('statement_batches');
      expect(classnameToTablename('PaymentMatch')).toBe('payment_matches');
      expect(classnameToTablename('TaxBox')).toBe('tax_boxes');
      expect(classnameToTablename('UserAddress')).toBe('user_addresses');
    });

    it('should handle vowel + y correctly (keep y)', () => {
      expect(classnameToTablename('ApiKey')).toBe('api_keys');
      expect(classnameToTablename('HolidayDay')).toBe('holiday_days');
      expect(classnameToTablename('Attorney')).toBe('attorneys');
    });

    it('should handle regular class names', () => {
      expect(classnameToTablename('Product')).toBe('products');
      expect(classnameToTablename('User')).toBe('users');
      expect(classnameToTablename('Document')).toBe('documents');
      expect(classnameToTablename('Account')).toBe('accounts');
    });

    it('should convert PascalCase to snake_case', () => {
      expect(classnameToTablename('UserAccount')).toBe('user_accounts');
      expect(classnameToTablename('JournalEntry')).toBe('journal_entries');
      expect(classnameToTablename('StatementBatch')).toBe('statement_batches');
    });

    it('should handle irregular plurals', () => {
      expect(classnameToTablename('Person')).toBe('people');
      expect(classnameToTablename('ContactPerson')).toBe('contact_people');
      expect(classnameToTablename('SalesPerson')).toBe('sales_people');
      expect(classnameToTablename('Child')).toBe('children');
    });
  });

  describe('legacyClassnameToTablename()', () => {
    it('should reproduce the old buggy behavior for migration', () => {
      // These show the BUG - 'y' words got 's' added, not converted to 'ies'
      expect(legacyClassnameToTablename('Currency')).toBe('currencys');
      expect(legacyClassnameToTablename('JournalEntry')).toBe('journal_entrys');
      expect(legacyClassnameToTablename('ExpenseCategory')).toBe(
        'expense_categorys',
      );

      // 'ch' words also got wrong treatment
      expect(legacyClassnameToTablename('StatementBatch')).toBe(
        'statement_batchs',
      );
    });

    it('should match new behavior for unaffected words', () => {
      // Regular words were not affected by the bug
      expect(legacyClassnameToTablename('Product')).toBe('products');
      expect(legacyClassnameToTablename('User')).toBe('users');
    });
  });

  describe('generateTableRenameMigrations()', () => {
    it('should generate rename migrations for affected tables', () => {
      const migrations = generateTableRenameMigrations([
        'Currency',
        'JournalEntry',
        'StatementBatch',
      ]);

      expect(migrations).toContain(
        'ALTER TABLE currencys RENAME TO currencies;',
      );
      expect(migrations).toContain(
        'ALTER TABLE journal_entrys RENAME TO journal_entries;',
      );
      expect(migrations).toContain(
        'ALTER TABLE statement_batchs RENAME TO statement_batches;',
      );
    });

    it('should NOT generate migrations for unaffected tables', () => {
      const migrations = generateTableRenameMigrations([
        'Product',
        'User',
        'Account',
      ]);

      expect(migrations).toHaveLength(0);
    });

    it('should handle mixed affected and unaffected tables', () => {
      const migrations = generateTableRenameMigrations([
        'Product',
        'Currency',
        'User',
        'JournalEntry',
      ]);

      expect(migrations).toHaveLength(2);
      expect(migrations).toContain(
        'ALTER TABLE currencys RENAME TO currencies;',
      );
      expect(migrations).toContain(
        'ALTER TABLE journal_entrys RENAME TO journal_entries;',
      );
    });
  });

  describe('tableNameFromClass()', () => {
    it('should use SMRT_TABLE_NAME if available', () => {
      class TestClass {
        static SMRT_TABLE_NAME = 'custom_table_name';
      }

      expect(tableNameFromClass(TestClass)).toBe('custom_table_name');
    });

    it('should fallback to correct pluralization when no SMRT_TABLE_NAME', () => {
      // Create classes without SMRT_TABLE_NAME to test fallback
      // Use class syntax to preserve the name property correctly
      class Currency {}
      class JournalEntry {}
      class StatementBatch {}

      expect(tableNameFromClass(Currency)).toBe('currencies');
      expect(tableNameFromClass(JournalEntry)).toBe('journal_entries');
      expect(tableNameFromClass(StatementBatch)).toBe('statement_batches');
    });
  });
});

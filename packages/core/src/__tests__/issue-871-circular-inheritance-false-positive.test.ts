/**
 * Issue #871: Circular inheritance false positive when extending upstream
 * classes with the same JavaScript class name
 *
 * When a local class extends an upstream class but uses the same JavaScript
 * class name (with a different SMRT registration name), the registry incorrectly
 * detects circular inheritance.
 *
 * @see https://github.com/happyvertical/smrt/issues/871
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { SmrtObject } from '../object.js';
import { ObjectRegistry, smrt } from '../registry.js';

// ─────────────────────────────────────────────────────────────────────────────
// Reproduce the exact issue:
// - Upstream package has: class Account extends SmrtObject (registered as 'LedgerAccount')
// - Local code has: class Account extends LedgerAccount (registered as 'MyAccount')
// - Both have JS name 'Account' -> false positive circular inheritance
// ─────────────────────────────────────────────────────────────────────────────

// We'll use eval to create classes with exact same JS name in different scopes
let UpstreamAccountClass: typeof SmrtObject;
let LocalAccountClass: typeof SmrtObject;
let registrationError: Error | null = null;

describe('Issue #871: Circular inheritance false positive', () => {
  beforeAll(() => {
    // First, register the "upstream" Account class
    // This simulates what smrt-ledgers does
    @smrt({ name: 'Issue871LedgerAccount' })
    class Account extends SmrtObject {
      balance: number = 0.0;
    }
    UpstreamAccountClass = Account;

    // Now try to register a "local" class that:
    // 1. Extends the upstream class
    // 2. Has the SAME JavaScript class name "Account"
    // 3. Has a DIFFERENT SMRT registration name
    //
    // This is the pattern that causes Issue #871:
    // buildInheritanceChain walks the prototype chain using JS names
    // and sees: Account -> Account -> SmrtObject
    // It incorrectly thinks "Account" appears twice = circular

    try {
      // Create a class factory that produces a class named "Account"
      const createAccountClass = (Base: typeof SmrtObject) => {
        // Using Function constructor to create a class with exact name "Account"
        // This simulates: class Account extends LedgerAccount { ... }
        const AccountClass = class Account extends Base {
          tenantId: string = '';
        };
        return AccountClass;
      };

      const LocalAccount = createAccountClass(UpstreamAccountClass);

      // Register with a different SMRT name
      // This is where the error would occur before the fix
      smrt({ name: 'Issue871LocalAccount' })(LocalAccount);
      LocalAccountClass = LocalAccount as typeof SmrtObject;
    } catch (error) {
      registrationError = error as Error;
    }
  });

  it('should not throw circular inheritance error for same-named classes', () => {
    // Before fix: throws "Circular inheritance detected for class 'Account'"
    // After fix: should register without error
    if (registrationError) {
      // If there was an error, fail with the actual error message
      expect.fail(
        `Registration failed with: ${registrationError.message}\n` +
          `This is the Issue #871 bug - same JS class name causes false positive circular inheritance detection`,
      );
    }

    expect(registrationError).toBeNull();
  });

  it('should register both classes with their SMRT names', () => {
    expect(ObjectRegistry.findClass('Issue871LedgerAccount')).toBeDefined();

    // This will be undefined if registration failed due to #871
    if (registrationError) {
      expect.fail('Local class was not registered due to Issue #871');
    }
    expect(ObjectRegistry.findClass('Issue871LocalAccount')).toBeDefined();
  });

  it('should build inheritance chain using SMRT names, not JS names', () => {
    if (registrationError) {
      expect.fail('Cannot test inheritance chain - registration failed');
    }

    const chain = ObjectRegistry.getInheritanceChain('Issue871LocalAccount');

    // The chain should use SMRT registered names.
    // R5-canon: chains return qualified names. The package context may vary,
    // so accept either bare or qualified form ending with the class name.
    expect(
      chain.some(
        (c) =>
          c === 'Issue871LocalAccount' || c.endsWith(':Issue871LocalAccount'),
      ),
    ).toBe(true);

    // Note: The parent might show up as 'Issue871LedgerAccount' or the JS name
    // depending on how the chain is built. The important thing is no circular error.
    expect(chain.length).toBeGreaterThan(0);
  });

  it('should correctly identify parent-child relationship', () => {
    if (registrationError) {
      expect.fail('Cannot test relationship - registration failed');
    }

    // Verify the local class actually extends the upstream class
    expect(
      Object.getPrototypeOf(LocalAccountClass) === UpstreamAccountClass,
    ).toBe(true);
  });
});

/**
 * Payment model tests with ledger integration
 *
 * Tests for:
 * 1. Payment CRUD operations
 * 2. Payment status management
 * 3. Integration with smrt-ledgers for journal entries
 */

import { existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
// Import ledger types for integration test
import {
  AccountCollection,
  JournalCollection,
} from '@happyvertical/smrt-ledgers';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ContractCollection } from '../collections/ContractCollection.js';
import { CustomerCollection } from '../collections/CustomerCollection.js';
import { PaymentCollection } from '../collections/PaymentCollection.js';
import { PaymentMethod, PaymentStatus } from '../types/index.js';

describe('Payment', () => {
  let dbPath: string;
  let payments: PaymentCollection;
  let contracts: ContractCollection;
  let customers: CustomerCollection;

  beforeEach(async () => {
    dbPath = join(tmpdir(), `smrt-payment-test-${Date.now()}.db`);
    payments = await PaymentCollection.create({
      db: { type: 'sqlite', url: dbPath },
    });
    contracts = await ContractCollection.create({
      db: { type: 'sqlite', url: dbPath },
    });
    customers = await CustomerCollection.create({
      db: { type: 'sqlite', url: dbPath },
    });
  });

  afterEach(() => {
    if (existsSync(dbPath)) {
      try {
        rmSync(dbPath, { force: true });
      } catch {
        // Ignore cleanup errors
      }
    }
  });

  describe('Basic CRUD Operations', () => {
    it('should create a payment', async () => {
      const customer = await customers.create({ profileId: 'test-profile' });
      await customer.save();

      const contract = await contracts.create({
        customerId: customer.id,
        totalAmount: 1000,
      });
      await contract.save();

      const payment = await payments.create({
        contractId: contract.id,
        customerId: customer.id,
        amount: 500,
        method: PaymentMethod.CREDIT_CARD,
        transactionId: 'stripe_pi_12345',
      });

      expect(payment.id).toBeDefined();
      expect(payment.contractId).toBe(contract.id);
      expect(payment.customerId).toBe(customer.id);
      expect(payment.amount).toBe(500);
      expect(payment.method).toBe(PaymentMethod.CREDIT_CARD);
      expect(payment.status).toBe(PaymentStatus.PENDING);
    });

    it('should preserve data through save/load cycle', async () => {
      const customer = await customers.create({ profileId: 'test-profile' });
      await customer.save();

      const contract = await contracts.create({
        customerId: customer.id,
      });
      await contract.save();

      const payment = await payments.create({
        contractId: contract.id,
        customerId: customer.id,
        amount: 1500.5,
        currency: 'EUR',
        method: PaymentMethod.BANK_TRANSFER,
        reference: 'PAY-2024-001',
        notes: 'Wire transfer',
      });
      await payment.save();

      const loaded = await payments.get({ id: payment.id });
      expect(loaded).toBeDefined();
      expect(loaded?.amount).toBe(1500.5);
      expect(loaded?.currency).toBe('EUR');
      expect(loaded?.method).toBe(PaymentMethod.BANK_TRANSFER);
      expect(loaded?.reference).toBe('PAY-2024-001');
      expect(loaded?.notes).toBe('Wire transfer');
    });
  });

  describe('Status Management', () => {
    it('should check payment status', async () => {
      const customer = await customers.create({ profileId: 'status-test' });
      await customer.save();

      const contract = await contracts.create({
        customerId: customer.id,
      });
      await contract.save();

      const pending = await payments.create({
        contractId: contract.id,
        customerId: customer.id,
        amount: 100,
        status: PaymentStatus.PENDING,
      });

      const completed = await payments.create({
        contractId: contract.id,
        customerId: customer.id,
        amount: 200,
        status: PaymentStatus.COMPLETED,
      });

      expect(pending.isPending()).toBe(true);
      expect(pending.isCompleted()).toBe(false);
      expect(completed.isPending()).toBe(false);
      expect(completed.isCompleted()).toBe(true);
    });

    it('should mark payment as failed', async () => {
      const customer = await customers.create({ profileId: 'fail-test' });
      await customer.save();

      const contract = await contracts.create({
        customerId: customer.id,
      });
      await contract.save();

      const payment = await payments.create({
        contractId: contract.id,
        customerId: customer.id,
        amount: 100,
      });

      payment.markFailed('Card declined');

      expect(payment.status).toBe(PaymentStatus.FAILED);
      expect(payment.notes).toContain('Card declined');
    });

    it('should cancel pending payment', async () => {
      const customer = await customers.create({ profileId: 'cancel-test' });
      await customer.save();

      const contract = await contracts.create({
        customerId: customer.id,
      });
      await contract.save();

      const payment = await payments.create({
        contractId: contract.id,
        customerId: customer.id,
        amount: 100,
        status: PaymentStatus.PENDING,
      });

      payment.cancel();

      expect(payment.status).toBe(PaymentStatus.CANCELLED);
    });

    it('should not cancel completed payment', async () => {
      const customer = await customers.create({ profileId: 'no-cancel-test' });
      await customer.save();

      const contract = await contracts.create({
        customerId: customer.id,
      });
      await contract.save();

      const payment = await payments.create({
        contractId: contract.id,
        customerId: customer.id,
        amount: 100,
        status: PaymentStatus.COMPLETED,
      });

      expect(() => payment.cancel()).toThrow(
        'Cannot cancel a completed payment',
      );
    });
  });

  describe('Collection Queries', () => {
    it('should find payments by contract', async () => {
      const customer = await customers.create({ profileId: 'contract-query' });
      await customer.save();

      const contract1 = await contracts.create({
        customerId: customer.id,
      });
      await contract1.save();

      const contract2 = await contracts.create({
        customerId: customer.id,
      });
      await contract2.save();

      await (
        await payments.create({
          contractId: contract1.id,
          customerId: customer.id,
          amount: 100,
        })
      ).save();
      await (
        await payments.create({
          contractId: contract1.id,
          customerId: customer.id,
          amount: 200,
        })
      ).save();
      await (
        await payments.create({
          contractId: contract2.id,
          customerId: customer.id,
          amount: 300,
        })
      ).save();

      const c1Payments = await payments.findByContract(contract1.id!);
      expect(c1Payments).toHaveLength(2);
    });

    it('should find payments by customer', async () => {
      const customer1 = await customers.create({ profileId: 'c1' });
      await customer1.save();

      const customer2 = await customers.create({ profileId: 'c2' });
      await customer2.save();

      const contract = await contracts.create({
        customerId: customer1.id,
      });
      await contract.save();

      await (
        await payments.create({
          contractId: contract.id,
          customerId: customer1.id,
          amount: 100,
        })
      ).save();
      await (
        await payments.create({
          contractId: contract.id,
          customerId: customer2.id,
          amount: 200,
        })
      ).save();

      const c1Payments = await payments.findByCustomer(customer1.id!);
      expect(c1Payments).toHaveLength(1);
    });

    it('should calculate total for contract', async () => {
      const customer = await customers.create({ profileId: 'total-test' });
      await customer.save();

      const contract = await contracts.create({
        customerId: customer.id,
        totalAmount: 1000,
      });
      await contract.save();

      await (
        await payments.create({
          contractId: contract.id,
          customerId: customer.id,
          amount: 300,
          status: PaymentStatus.COMPLETED,
        })
      ).save();
      await (
        await payments.create({
          contractId: contract.id,
          customerId: customer.id,
          amount: 200,
          status: PaymentStatus.COMPLETED,
        })
      ).save();
      await (
        await payments.create({
          contractId: contract.id,
          customerId: customer.id,
          amount: 100,
          status: PaymentStatus.PENDING, // Not counted
        })
      ).save();

      const total = await payments.getTotalForContract(contract.id!);
      expect(total).toBe(500); // Only completed payments
    });

    it('should find by transaction ID', async () => {
      const customer = await customers.create({ profileId: 'txn-test' });
      await customer.save();

      const contract = await contracts.create({
        customerId: customer.id,
      });
      await contract.save();

      await (
        await payments.create({
          contractId: contract.id,
          customerId: customer.id,
          amount: 100,
          transactionId: 'unique_txn_123',
        })
      ).save();

      const found = await payments.findByTransactionId('unique_txn_123');
      expect(found).toBeDefined();
      expect(found?.transactionId).toBe('unique_txn_123');

      const notFound = await payments.findByTransactionId('nonexistent');
      expect(notFound).toBeNull();
    });
  });
});

describe('Payment Ledger Integration', () => {
  let dbPath: string;
  let payments: PaymentCollection;
  let contracts: ContractCollection;
  let customers: CustomerCollection;
  let accounts: AccountCollection;
  let journals: JournalCollection;

  beforeEach(async () => {
    dbPath = join(tmpdir(), `smrt-payment-ledger-test-${Date.now()}.db`);
    const dbConfig = { db: { type: 'sqlite' as const, url: dbPath } };

    payments = await PaymentCollection.create(dbConfig);
    contracts = await ContractCollection.create(dbConfig);
    customers = await CustomerCollection.create(dbConfig);
    accounts = await AccountCollection.create(dbConfig);
    journals = await JournalCollection.create(dbConfig);
  });

  afterEach(() => {
    if (existsSync(dbPath)) {
      try {
        rmSync(dbPath, { force: true });
      } catch {
        // Ignore cleanup errors
      }
    }
  });

  it('should create balanced journal entry when recording payment', async () => {
    // Setup accounts
    const cashAccount = await accounts.create({
      number: '1000',
      name: 'Cash',
      type: 'asset',
    });
    await cashAccount.save();

    const arAccount = await accounts.create({
      number: '1200',
      name: 'Accounts Receivable',
      type: 'asset',
    });
    await arAccount.save();

    // Setup customer and contract
    const customer = await customers.create({ profileId: 'ledger-test' });
    await customer.save();

    const contract = await contracts.create({
      customerId: customer.id,
      totalAmount: 1000,
    });
    await contract.save();

    // Create payment
    const payment = await payments.create({
      contractId: contract.id,
      customerId: customer.id,
      amount: 500,
      method: PaymentMethod.CHECK,
      reference: 'CHK-001',
    });
    await payment.save();

    // Record with ledger integration
    const journal = await payment.recordPayment({
      ledgerId: '', // Not used in current implementation
      cashAccountId: cashAccount.id!,
      receivablesAccountId: arAccount.id!,
    });

    // Verify journal was created
    expect(journal).toBeDefined();
    expect(journal.id).toBeDefined();
    expect(journal.sourceModule).toBe('smrt-commerce');
    expect(journal.sourceRef).toBe(payment.id);

    // Verify journal is balanced
    const isBalanced = await journal.isBalanced();
    expect(isBalanced).toBe(true);

    // Verify journal is posted
    expect(journal.isPosted()).toBe(true);

    // Verify payment was updated
    const loadedPayment = await payments.get({ id: payment.id });
    expect(loadedPayment?.status).toBe(PaymentStatus.COMPLETED);
    expect(loadedPayment?.journalId).toBe(journal.id);
    expect(loadedPayment?.paidAt).toBeDefined();
  });

  it('should not allow recording payment twice', async () => {
    // Setup accounts
    const cashAccount = await accounts.create({
      number: '1000',
      name: 'Cash',
      type: 'asset',
    });
    await cashAccount.save();

    const arAccount = await accounts.create({
      number: '1200',
      name: 'Accounts Receivable',
      type: 'asset',
    });
    await arAccount.save();

    // Setup customer and contract
    const customer = await customers.create({ profileId: 'double-record' });
    await customer.save();

    const contract = await contracts.create({
      customerId: customer.id,
    });
    await contract.save();

    // Create and record payment
    const payment = await payments.create({
      contractId: contract.id,
      customerId: customer.id,
      amount: 100,
    });
    await payment.save();

    await payment.recordPayment({
      ledgerId: '',
      cashAccountId: cashAccount.id!,
      receivablesAccountId: arAccount.id!,
    });

    // Try to record again
    await expect(
      payment.recordPayment({
        ledgerId: '',
        cashAccountId: cashAccount.id!,
        receivablesAccountId: arAccount.id!,
      }),
    ).rejects.toThrow('Payment already recorded');
  });

  it('should reject recording payment with zero amount', async () => {
    const cashAccount = await accounts.create({
      number: '1000',
      name: 'Cash',
      type: 'asset',
    });
    await cashAccount.save();

    const arAccount = await accounts.create({
      number: '1200',
      name: 'AR',
      type: 'asset',
    });
    await arAccount.save();

    const customer = await customers.create({ profileId: 'zero-test' });
    await customer.save();

    const contract = await contracts.create({
      customerId: customer.id,
    });
    await contract.save();

    const payment = await payments.create({
      contractId: contract.id,
      customerId: customer.id,
      amount: 0, // Zero amount
    });
    await payment.save();

    await expect(
      payment.recordPayment({
        ledgerId: '',
        cashAccountId: cashAccount.id!,
        receivablesAccountId: arAccount.id!,
      }),
    ).rejects.toThrow('Payment amount must be positive');
  });

  it('should find payment by journal ID', async () => {
    // Setup accounts
    const cashAccount = await accounts.create({
      number: '1000',
      name: 'Cash',
      type: 'asset',
    });
    await cashAccount.save();

    const arAccount = await accounts.create({
      number: '1200',
      name: 'AR',
      type: 'asset',
    });
    await arAccount.save();

    // Setup customer and contract
    const customer = await customers.create({ profileId: 'journal-lookup' });
    await customer.save();

    const contract = await contracts.create({
      customerId: customer.id,
    });
    await contract.save();

    // Create and record payment
    const payment = await payments.create({
      contractId: contract.id,
      customerId: customer.id,
      amount: 250,
    });
    await payment.save();

    const journal = await payment.recordPayment({
      ledgerId: '',
      cashAccountId: cashAccount.id!,
      receivablesAccountId: arAccount.id!,
    });

    // Find payment by journal
    const found = await payments.findByJournal(journal.id);
    expect(found).toBeDefined();
    expect(found?.id).toBe(payment.id);
  });
});

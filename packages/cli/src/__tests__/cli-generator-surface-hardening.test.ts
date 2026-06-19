/**
 * Regression tests for the consolidated generator-surface hardening (C3),
 * CLI portion:
 *
 *  - `cli.include` is EXHAUSTIVE for custom commands: when an include list is
 *    present it is the COMPLETE allowlist, so a custom (non-CRUD) command is
 *    generated ONLY if named. `include: ['list', 'get']` emits NO custom
 *    commands; `include: ['list', 'get', 'someMethod']` emits someMethod.
 *    With no include list, custom methods are auto-exposed (default).
 *  - `applyWritablePolicy` strips framework/server-managed + `readonly` fields
 *    and intersects with `api.writable` on every create/update input path,
 *    including `--from-file` (resolving both `fromFile` and `from-file` keys).
 *
 * Follows the existing mock-registry pattern in
 * `cli-generator-boolean-options.test.ts`.
 */

import { ObjectRegistry } from '@happyvertical/smrt-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CLIGenerator } from '../cli-generator.js';

// Mock the dynamic `node:fs/promises` import used by handleCreate/handleUpdate
// so the --from-file path reads controlled content (ESM namespaces can't be
// spied directly).
const readFileMock = vi.fn();
vi.mock('node:fs/promises', () => ({
  readFile: (...args: any[]) => readFileMock(...args),
}));

describe('CLI Generator - C3 surface hardening', () => {
  let cli: CLIGenerator;

  beforeEach(() => {
    cli = new CLIGenerator({ prompt: false });
    (ObjectRegistry as any)._classes = new Map();
    (ObjectRegistry as any)._methods = new Map();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    readFileMock.mockReset();
    (ObjectRegistry as any)._classes = new Map();
    (ObjectRegistry as any)._methods = new Map();
  });

  const customMethods = () =>
    new Map<string, any>([
      [
        'recordPayment',
        { name: 'recordPayment', isPublic: true, parameters: [] },
      ],
      [
        'recognizeRevenue',
        { name: 'recognizeRevenue', isPublic: true, parameters: [] },
      ],
    ]);

  describe('exhaustive cli.include for custom commands', () => {
    it('include: [list, get] emits NO custom commands', async () => {
      vi.spyOn(ObjectRegistry, 'getClass').mockReturnValue({
        constructor: class MockClass {},
        packageName: 'test',
      } as any);
      vi.spyOn(ObjectRegistry, 'getConfig').mockReturnValue({
        cli: { include: ['list', 'get'] },
        api: false,
        mcp: false,
      } as any);
      vi.spyOn(ObjectRegistry, 'getFields').mockReturnValue(new Map());
      vi.spyOn(ObjectRegistry, 'getAllMethods').mockResolvedValue(
        customMethods(),
      );

      const commands = await (cli as any).generateObjectCommands('Invoice', {});
      const names = commands.map((c: any) => c.name);

      expect(names).toContain('invoice:list');
      expect(names).toContain('invoice:get');
      expect(names).not.toContain('invoice:recordPayment');
      expect(names).not.toContain('invoice:recognizeRevenue');
    });

    it('include naming a custom method emits ONLY that custom command', async () => {
      vi.spyOn(ObjectRegistry, 'getClass').mockReturnValue({
        constructor: class MockClass {},
        packageName: 'test',
      } as any);
      vi.spyOn(ObjectRegistry, 'getConfig').mockReturnValue({
        cli: { include: ['list', 'get', 'recordPayment'] },
        api: false,
        mcp: false,
      } as any);
      vi.spyOn(ObjectRegistry, 'getFields').mockReturnValue(new Map());
      vi.spyOn(ObjectRegistry, 'getAllMethods').mockResolvedValue(
        customMethods(),
      );

      const commands = await (cli as any).generateObjectCommands('Invoice', {});
      const names = commands.map((c: any) => c.name);

      expect(names).toContain('invoice:recordPayment');
      expect(names).not.toContain('invoice:recognizeRevenue');
    });

    it('no include list auto-exposes custom commands (default)', async () => {
      vi.spyOn(ObjectRegistry, 'getClass').mockReturnValue({
        constructor: class MockClass {},
        packageName: 'test',
      } as any);
      vi.spyOn(ObjectRegistry, 'getConfig').mockReturnValue({
        cli: true,
        api: false,
        mcp: false,
      } as any);
      vi.spyOn(ObjectRegistry, 'getFields').mockReturnValue(new Map());
      vi.spyOn(ObjectRegistry, 'getAllMethods').mockResolvedValue(
        customMethods(),
      );

      const commands = await (cli as any).generateObjectCommands('Invoice', {});
      const names = commands.map((c: any) => c.name);

      expect(names).toContain('invoice:recordPayment');
      expect(names).toContain('invoice:recognizeRevenue');
    });
  });

  describe('applyWritablePolicy', () => {
    it('strips framework/server-managed and underscore-prefixed fields', () => {
      vi.spyOn(ObjectRegistry, 'getConfig').mockReturnValue({} as any);
      vi.spyOn(ObjectRegistry, 'getFields').mockReturnValue(new Map());

      const result = (cli as any).applyWritablePolicy('Payment', {
        id: 'x',
        tenantId: 't',
        createdAt: 'now',
        updatedAt: 'now',
        _meta_type: 'leak',
        amount: 100,
        status: 'pending',
      });

      expect(result).toEqual({ amount: 100, status: 'pending' });
    });

    it('intersects with api.writable allowlist', () => {
      vi.spyOn(ObjectRegistry, 'getConfig').mockReturnValue({
        api: { writable: ['amount'] },
      } as any);
      vi.spyOn(ObjectRegistry, 'getFields').mockReturnValue(new Map());

      const result = (cli as any).applyWritablePolicy('Payment', {
        amount: 100,
        status: 'pending', // not in writable → stripped
      });

      expect(result).toEqual({ amount: 100 });
    });

    it('strips @field({ readonly: true }) fields', () => {
      vi.spyOn(ObjectRegistry, 'getConfig').mockReturnValue({} as any);
      vi.spyOn(ObjectRegistry, 'getFields').mockReturnValue(
        new Map<string, any>([
          ['amount', { readonly: false }],
          ['computedTotal', { readonly: true }],
        ]),
      );

      const result = (cli as any).applyWritablePolicy('Payment', {
        amount: 100,
        computedTotal: 999,
      });

      expect(result).toEqual({ amount: 100 });
    });
  });

  describe('handleCreate enforces the writable policy incl --from-file', () => {
    it('strips non-writable fields loaded from --from-file', async () => {
      // api.writable restricts writes to `amount`; everything else (incl
      // `status` and framework fields) must be stripped before create().
      vi.spyOn(ObjectRegistry, 'getConfig').mockReturnValue({
        api: { writable: ['amount'] },
      } as any);
      vi.spyOn(ObjectRegistry, 'getFields').mockReturnValue(new Map());

      const fileContent = JSON.stringify({
        id: 'attacker-supplied',
        amount: 100,
        status: 'paid',
      });

      readFileMock.mockResolvedValue(fileContent);

      // Capture what create() actually receives.
      let createdWith: any = null;
      const fakeSaved = { id: 'generated-id', save: vi.fn() };
      const fakeCollection = {
        create: vi.fn(async (data: any) => {
          createdWith = data;
          return fakeSaved;
        }),
      };
      vi.spyOn(cli as any, 'getCollection').mockResolvedValue(fakeCollection);
      vi.spyOn(cli as any, 'createSpinner').mockReturnValue({
        succeed: vi.fn(),
        fail: vi.fn(),
      });
      vi.spyOn(console, 'log').mockImplementation(() => {});

      await (cli as any).handleCreate('Payment', {
        'from-file': '/tmp/payment.json',
        quiet: true,
      });

      expect(fakeCollection.create).toHaveBeenCalledTimes(1);
      expect(createdWith).toEqual({ amount: 100 });
      // The attacker-supplied id and non-writable status must NOT survive.
      expect(createdWith.id).toBeUndefined();
      expect(createdWith.status).toBeUndefined();
    });
  });
});

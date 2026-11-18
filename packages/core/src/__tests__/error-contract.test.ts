/**
 * The public error contract (#5158): `./error-contract` publishes one table of
 * error codes on a module with no imports.
 *
 * The table is not consulted by any transport yet. These tests keep it
 * complete (a code that exists in the sources without an entry fails here, so
 * adding a code forces a decision about what a caller is told) and keep the
 * behaviour other code already relies on unchanged.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import ts from 'typescript';
import { afterEach, describe, expect, it } from 'vitest';
import * as browserEntry from '../browser';
import { isUniqueViolationError } from '../db-errors';
import {
  ERROR_CONTRACT,
  type ErrorContractEntry,
  getErrorContract,
  isPublicError,
  listErrorCodes,
  OPAQUE_ERROR,
  publicError,
  registerErrorCodes,
  TRANSPORT_ERROR_CODES,
} from '../error-contract';
import { RuntimeError, SmrtError, ValidationError } from '../errors';
import { normalizeTypedHttpError } from '../generators/typed-http-error';
import * as nodeEntry from '../index';

const SRC = new URL('..', import.meta.url).pathname;
const read = (path: string) => readFileSync(join(SRC, path), 'utf8');

/** Quoted UPPER_SNAKE literals with at least two segments. */
const LITERAL = /(['"])([A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+)\1/g;

function literals(source: string): Set<string> {
  // Comments quote codes in prose; only code can raise one.
  const code = source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:\\])\/\/[^\n]*/gm, '$1');
  return new Set([...code.matchAll(LITERAL)].map((match) => match[2]));
}

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      if (name === '__tests__' || name === 'templates') continue;
      sourceFiles(path, out);
    } else if (
      name.endsWith('.ts') &&
      !name.endsWith('.d.ts') &&
      !/\.(test|spec)\.ts$/.test(name)
    ) {
      out.push(path);
    }
  }
  return out;
}

describe('smrt-core/error-contract', () => {
  it('imports nothing', () => {
    const source = ts.createSourceFile(
      'error-contract.ts',
      read('error-contract.ts'),
      ts.ScriptTarget.Latest,
      true,
    );
    const specifiers: string[] = [];
    const visit = (node: ts.Node) => {
      if (
        (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
        node.moduleSpecifier
      ) {
        specifiers.push(node.moduleSpecifier.getText());
      } else if (
        ts.isCallExpression(node) &&
        (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
          node.expression.getText() === 'require')
      ) {
        specifiers.push(node.getText());
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
    expect(specifiers).toEqual([]);
  });

  it('is the same module on the root and browser entries', () => {
    for (const entry of [nodeEntry, browserEntry]) {
      expect(entry.ERROR_CONTRACT).toBe(ERROR_CONTRACT);
      expect(entry.publicError).toBe(publicError);
      expect(entry.registerErrorCodes).toBe(registerErrorCodes);
      expect(entry.getErrorContract).toBe(getErrorContract);
    }
  });

  describe('table', () => {
    it('is frozen and every entry is well formed', () => {
      expect(Object.isFrozen(ERROR_CONTRACT)).toBe(true);
      for (const [code, entry] of Object.entries(ERROR_CONTRACT)) {
        expect(code, code).toMatch(/^[A-Z][A-Z0-9_]+$/);
        expect(entry.status, code).toBeGreaterThanOrEqual(400);
        expect(entry.status, code).toBeLessThanOrEqual(599);
        expect(entry.text.length, code).toBeGreaterThan(0);
        // A server fault never explains itself; a client error always does.
        expect(entry.message === 'opaque', code).toBe(entry.status >= 500);
      }
    });

    it('never puts a stored value or a template in a public text', () => {
      for (const [code, entry] of Object.entries(ERROR_CONTRACT)) {
        expect(entry.text, code).not.toMatch(/[${}%]/);
      }
    });

    it('keeps the decisions other packages depend on', () => {
      // A provider credential failure is the server's, never the caller's.
      expect(ERROR_CONTRACT.AI_AUTH_FAILED.status).toBe(500);
      expect(ERROR_CONTRACT.VALIDATION_UNIQUE_CONSTRAINT).toMatchObject({
        status: 409,
        message: 'fixed',
      });
      expect(ERROR_CONTRACT.RUNTIME_REVISION_CONFLICT.status).toBe(409);
      expect(ERROR_CONTRACT.TENANT_CONTEXT_REQUIRED).toMatchObject({
        status: 403,
        anonymousStatus: 401,
      });
      expect(ERROR_CONTRACT.TENANT_ISOLATION_VIOLATION.status).toBe(403);
      expect(OPAQUE_ERROR).toMatchObject({ status: 500, message: 'opaque' });
    });

    it('has an entry for every code the kernel raises', () => {
      for (const code of Object.values(TRANSPORT_ERROR_CODES)) {
        expect(getErrorContract(code), code).toBeDefined();
      }
    });
  });

  describe('completeness', () => {
    /**
     * Literals in the three error modules that are not SMRT error codes.
     * A new literal there must be added to the table or listed here.
     */
    const DRIVER_CODES = /^(SQLITE_[A-Z_]+|EAI_AGAIN)$/;

    it('covers every code in errors.ts, smrt-error.ts and db-errors.ts', () => {
      const missing: string[] = [];
      for (const file of ['errors.ts', 'smrt-error.ts', 'db-errors.ts']) {
        // Doc-comment examples in these files quote real codes, so comments
        // are scanned too: a code named in an example must exist.
        for (const code of [...read(file).matchAll(LITERAL)].map((m) => m[2])) {
          if (DRIVER_CODES.test(code)) continue;
          if (!Object.hasOwn(ERROR_CONTRACT, code))
            missing.push(`${file}: ${code}`);
        }
      }
      expect(missing).toEqual([]);
    });

    /** Prefixes SMRT error codes use anywhere in this package. */
    const CODE_PREFIX =
      /^(VALIDATION|DB|AI|FS|CONFIG|RUNTIME|NETWORK|TENANT|RUN_ONCE|INVALID|DATA_QUERY|QUERY|REQUEST|AUTH|PERMISSION|OPERATION|INFERENCE|MIGRATION|NOT)_/;

    /** Prefixed literals that are not error codes a transport can meet. */
    const NOT_ERROR_CODES: Record<string, string> = {
      INVALID_CHECKPOINT:
        'a DeploymentStepError code, one of an operator-only family (UNSUPPORTED, NEEDS_REPAIR, ...) that never reaches a transport',
    };

    it('covers every prefixed code literal in the package sources', () => {
      const missing = new Map<string, string>();
      const seen = new Set<string>();
      for (const file of sourceFiles(SRC)) {
        const path = relative(SRC, file);
        if (path === 'error-contract.ts') continue;
        for (const code of literals(readFileSync(file, 'utf8'))) {
          if (!CODE_PREFIX.test(code)) continue;
          seen.add(code);
          if (Object.hasOwn(NOT_ERROR_CODES, code)) continue;
          if (!Object.hasOwn(ERROR_CONTRACT, code)) missing.set(code, path);
        }
      }
      expect(Object.fromEntries(missing)).toEqual({});
      // The exclusion list carries no stale entries.
      for (const code of Object.keys(NOT_ERROR_CODES)) {
        expect(seen.has(code), `${code} is no longer in the sources`).toBe(
          true,
        );
      }
    });

    it('lists no code that nothing raises', () => {
      const raised = new Set<string>(Object.values(TRANSPORT_ERROR_CODES));
      for (const file of sourceFiles(SRC)) {
        if (relative(SRC, file) === 'error-contract.ts') continue;
        for (const code of literals(readFileSync(file, 'utf8')))
          raised.add(code);
      }
      const unused = Object.keys(ERROR_CONTRACT).filter(
        (code) => !raised.has(code),
      );
      expect(unused).toEqual([]);
    });
  });

  describe('publicError', () => {
    it('builds an error every existing transport already renders', () => {
      const error = publicError(423, 'RECORD_LOCKED', 'The record is locked.');
      expect(error).toBeInstanceOf(Error);
      expect(error.name).toBe('SmrtPublicError');
      expect(error).toMatchObject({
        status: 423,
        code: 'RECORD_LOCKED',
        message: 'The record is locked.',
        publicMessage: 'The record is locked.',
      });
      expect(isPublicError(error)).toBe(true);
      // Runtime REST and generated SvelteKit routes.
      expect(normalizeTypedHttpError(error)).toEqual({
        code: 'RECORD_LOCKED',
        message: 'The record is locked.',
        ok: false,
        status: 423,
      });
    });

    it('is recognised by its brand, not by look-alike properties', () => {
      const lookAlike = Object.assign(new Error('x'), {
        status: 403,
        code: 'X_Y',
        publicMessage: 'x',
      });
      expect(isPublicError(lookAlike)).toBe(false);
      expect(isPublicError(null)).toBe(false);
      expect(isPublicError('RECORD_LOCKED')).toBe(false);
      // The brand is not enumerable, so spreading an error does not copy it.
      const error = publicError(400, 'A_B', 'm');
      expect(isPublicError({ ...error })).toBe(false);
    });

    it('refuses a status, code or message that could not be shown', () => {
      expect(() => publicError(200, 'A_B', 'm')).toThrow(TypeError);
      expect(() => publicError(600, 'A_B', 'm')).toThrow(TypeError);
      expect(() => publicError(400.5, 'A_B', 'm')).toThrow(TypeError);
      expect(() => publicError(400, '', 'm')).toThrow(TypeError);
      expect(() => publicError(400, '9lives', 'm')).toThrow(TypeError);
      expect(() => publicError(400, 'has space', 'm')).toThrow(TypeError);
      expect(() => publicError(400, 'A_B', '')).toThrow(TypeError);
    });
  });

  describe('registerErrorCodes', () => {
    const slot = Symbol.for('smrt.errorContract');
    const store = () =>
      (
        globalThis as unknown as Record<symbol, Map<string, ErrorContractEntry>>
      )[slot];
    const entry: ErrorContractEntry = {
      status: 409,
      message: 'fixed',
      text: 'The booking overlaps another one.',
    };

    afterEach(() => {
      for (const code of [...(store()?.keys() ?? [])]) {
        if (code.startsWith('TEST_CONTRACT_')) store().delete(code);
      }
    });

    it('adds a code to one registry shared through globalThis', () => {
      expect(getErrorContract('TEST_CONTRACT_OVERLAP')).toBeUndefined();
      registerErrorCodes({ TEST_CONTRACT_OVERLAP: entry });
      expect(getErrorContract('TEST_CONTRACT_OVERLAP')).toEqual(entry);
      expect(store().get('TEST_CONTRACT_OVERLAP')).toEqual(entry);
      expect(listErrorCodes()).toContain('TEST_CONTRACT_OVERLAP');
      expect(Object.hasOwn(ERROR_CONTRACT, 'TEST_CONTRACT_OVERLAP')).toBe(
        false,
      );
    });

    it('accepts the same entry twice and refuses a different one', () => {
      registerErrorCodes({ TEST_CONTRACT_OVERLAP: entry });
      expect(() =>
        registerErrorCodes({ TEST_CONTRACT_OVERLAP: { ...entry } }),
      ).not.toThrow();
      expect(() =>
        registerErrorCodes({
          TEST_CONTRACT_OVERLAP: { ...entry, status: 400 },
        }),
      ).toThrow(/already defined/);
      expect(getErrorContract('TEST_CONTRACT_OVERLAP')?.status).toBe(409);
    });

    it('never redefines a code this package owns', () => {
      expect(() =>
        registerErrorCodes({ AI_AUTH_FAILED: { ...entry, status: 401 } }),
      ).toThrow(/already defined/);
      expect(ERROR_CONTRACT.AI_AUTH_FAILED.status).toBe(500);
      // Restating the existing decision is harmless and stores nothing.
      registerErrorCodes({ AI_AUTH_FAILED: ERROR_CONTRACT.AI_AUTH_FAILED });
      expect(store()?.has('AI_AUTH_FAILED') ?? false).toBe(false);
    });

    it('registers nothing when any entry of a call is refused', () => {
      expect(() =>
        registerErrorCodes({
          TEST_CONTRACT_FIRST: entry,
          TEST_CONTRACT_SECOND: { ...entry, status: 200 },
        }),
      ).toThrow(TypeError);
      expect(getErrorContract('TEST_CONTRACT_FIRST')).toBeUndefined();
    });

    it('refuses malformed codes and entries', () => {
      expect(() => registerErrorCodes({ 'bad code': entry })).toThrow(
        TypeError,
      );
      expect(() =>
        registerErrorCodes({ TEST_CONTRACT_X: { ...entry, text: '' } }),
      ).toThrow(TypeError);
      expect(() =>
        registerErrorCodes({
          TEST_CONTRACT_X: { ...entry, message: 'loud' as never },
        }),
      ).toThrow(TypeError);
      expect(() =>
        registerErrorCodes({
          TEST_CONTRACT_X: { ...entry, anonymousStatus: 500 },
        }),
      ).toThrow(TypeError);
    });

    it('does not resolve inherited object properties as codes', () => {
      expect(getErrorContract('toString')).toBeUndefined();
      expect(getErrorContract('constructor')).toBeUndefined();
      expect(getErrorContract(undefined)).toBeUndefined();
      expect(getErrorContract(409)).toBeUndefined();
    });
  });

  describe('existing error behaviour is unchanged', () => {
    it('a revision conflict is still a RuntimeError with its code', () => {
      const error = new RuntimeError('stale', 'RUNTIME_REVISION_CONFLICT');
      expect(error).toBeInstanceOf(RuntimeError);
      expect(error).toBeInstanceOf(SmrtError);
      expect(error.code).toBe('RUNTIME_REVISION_CONFLICT');
      expect(getErrorContract(error.code)?.status).toBe(409);
      // The contract adds no status to the error itself.
      expect(error).not.toHaveProperty('status');
    });

    it('a unique violation is still found through the cause chain', () => {
      const cause = ValidationError.uniqueConstraint('slug', 'a');
      const wrapped = new Error('save failed', { cause });
      expect(isUniqueViolationError(cause)).toBe(true);
      expect(isUniqueViolationError(wrapped)).toBe(true);
      expect(isUniqueViolationError(new Error('other'))).toBe(false);
    });
  });
});

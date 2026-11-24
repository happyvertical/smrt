/**
 * Regression tests for the setter-reads-hidden-field lint (#5603).
 */

import { describe, expect, it } from 'vitest';
import {
  lintSetterHiddenReads,
  sourceMayContainSetterHiddenRead,
} from '../setter-hidden-read-lint.js';

const model = (setter: string, extra = '') => `
import { field, smrt, SmrtObject } from '@happyvertical/smrt-core';

@smrt()
export class Account extends SmrtObject {
  @field({ sensitive: true }) secretHash = '';
  @field({ readPermission: 'accounts:audit' }) auditNote = '';
  name = '';
  ${extra}
  ${setter}
}
`;

const lint = (setter: string, extra?: string) =>
  lintSetterHiddenReads(model(setter, extra), 'account.ts');

describe('lintSetterHiddenReads', () => {
  it('flags a setter that reads a sensitive field before assigning it', () => {
    const findings = lint(
      'set label(v: string) { if (this.secretHash !== v) this.secretHash = v; }',
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      className: 'Account',
      setterName: 'label',
      fieldName: 'secretHash',
      hiddenBy: 'sensitive',
    });
    expect(findings[0].line).toBeGreaterThan(0);
  });

  it('flags a read of a readPermission field', () => {
    const findings = lint('set note(v: string) { if (this.auditNote) {} }');
    expect(findings.map((f) => f.fieldName)).toEqual(['auditNote']);
    expect(findings[0].hiddenBy).toBe('readPermission');
  });

  it('does not flag a setter that only assigns the protected field', () => {
    expect(lint('set label(v: string) { this.secretHash = v; }')).toEqual([]);
    expect(lint("set label(v: string) { this['secretHash'] = v; }")).toEqual(
      [],
    );
    expect(lint('set label(v: string) { [this.secretHash] = [v]; }')).toEqual(
      [],
    );
  });

  it('does not flag a setter that reads an ordinary field', () => {
    expect(
      lint('set label(v: string) { if (this.name !== v) this.name = v; }'),
    ).toEqual([]);
  });

  it('flags the other syntactic reads', () => {
    for (const body of [
      'this.secretHash += v;',
      'this.secretHash ??= v;',
      'this.secretHash.length;',
      "if (this['secretHash'] === v) return;",
      'if (this?.secretHash === v) return;',
      'const { secretHash } = this;',
      'const x = () => this.secretHash;',
      'this.name = this.secretHash;',
    ]) {
      expect(
        lint(`set label(v: string) { ${body} }`).map((f) => f.fieldName),
        body,
      ).toEqual(['secretHash']);
    }
  });

  it('ignores getters, methods, and non-hidden option values', () => {
    expect(lint('get label() { return this.secretHash; }')).toEqual([]);
    expect(lint('rotate() { return this.secretHash; }')).toEqual([]);
    expect(
      lintSetterHiddenReads(
        `class A { @field({ sensitive: false }) s = ''; set x(v) { this.s; } }`,
      ),
    ).toEqual([]);
  });

  it('does not enter nested functions, which rebind this', () => {
    expect(
      lint('set label(v: string) { function f() { return this.secretHash; } }'),
    ).toEqual([]);
  });

  it('reports each field once per setter', () => {
    const findings = lint(
      'set label(v: string) { if (this.secretHash && this.secretHash !== v) {} }',
    );
    expect(findings).toHaveLength(1);
  });

  it('pre-filter admits flagged sources', () => {
    expect(
      sourceMayContainSetterHiddenRead(
        model('set label(v: string) { this.secretHash; }'),
      ),
    ).toBe(true);
    expect(sourceMayContainSetterHiddenRead('class A { x = 1 }')).toBe(false);
  });
});

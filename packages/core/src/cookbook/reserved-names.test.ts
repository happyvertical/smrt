import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseSource } from '@happyvertical/smrt-scanner';
import {
  SMRT_FRAMEWORK_FIELD_NAMES,
  SMRT_PROTOTYPE_MEMBERS,
} from '@happyvertical/smrt-scanner/types';
import { describe, expect, it } from 'vitest';
import { SmrtClass } from '../class.js';
import { SmrtObject } from '../object.js';
import {
  isReservedFieldName,
  SMRT_INSTANCE_MEMBERS,
  SMRT_OPTION_KEYS,
} from './reserved-names.js';

describe('reserved field names', () => {
  it('lists exactly the instance members SmrtObject and SmrtClass declare or construct', () => {
    // Own properties of constructed instances, plus the instance fields both
    // classes declare (a declared field without an initializer is not an own
    // property until it is first assigned). Equality in both directions keeps
    // a removed member from staying reserved.
    const actual = new Set<string>();
    for (const instance of [new SmrtObject({}), new SmrtClass({})])
      for (const name of Object.getOwnPropertyNames(instance)) actual.add(name);
    for (const file of ['../object.ts', '../class.ts']) {
      const path = fileURLToPath(new URL(file, import.meta.url));
      const parsed = parseSource(readFileSync(path, 'utf-8'), path);
      for (const cls of parsed.classes)
        if (cls.className === 'SmrtObject' || cls.className === 'SmrtClass')
          for (const field of cls.fields)
            if (!field.isStatic && !field.declare) actual.add(field.name);
    }
    for (const name of SMRT_FRAMEWORK_FIELD_NAMES) actual.delete(name);
    const listed = SMRT_INSTANCE_MEMBERS.filter(
      (name) => !SMRT_FRAMEWORK_FIELD_NAMES.includes(name),
    );
    expect([...listed].sort()).toEqual([...actual].sort());
  });

  it('lists exactly the SmrtObject and SmrtClass prototype members', () => {
    const actual = new Set<string>();
    for (const proto of [SmrtObject.prototype, SmrtClass.prototype])
      for (const name of Object.getOwnPropertyNames(proto)) actual.add(name);
    for (const name of SMRT_FRAMEWORK_FIELD_NAMES) actual.delete(name);
    actual.delete('constructor');
    expect([...SMRT_PROTOTYPE_MEMBERS].sort()).toEqual([...actual].sort());
  });

  it('reserves constructor options, instance members and framework columns', () => {
    for (const name of [
      'options',
      'db',
      'ai',
      'fs',
      'persistence',
      'decisions',
      'inference',
      'usage',
      'logging',
      'metrics',
      'pubsub',
      'sanitization',
      'signals',
      'id',
      'slug',
      'context',
      'tenantId',
      'createdAt',
    ])
      expect(isReservedFieldName(name), name).toBe(true);
    expect(SMRT_OPTION_KEYS).toContain('db');
    // Ordinary business names stay available.
    for (const name of ['size', 'notes', 'optionsList', 'dueOn'])
      expect(isReservedFieldName(name), name).toBe(false);
  });
});

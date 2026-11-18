import { describe, expect, it } from 'vitest';
import { SmrtClass } from '../class.js';
import { SmrtObject } from '../object.js';
import {
  isReservedFieldName,
  SMRT_INSTANCE_MEMBERS,
  SMRT_OPTION_KEYS,
} from './reserved-names.js';

describe('reserved field names', () => {
  it('lists every own property a constructed SmrtObject or SmrtClass carries', () => {
    for (const instance of [new SmrtObject({}), new SmrtClass({})])
      for (const name of Object.getOwnPropertyNames(instance))
        expect(SMRT_INSTANCE_MEMBERS, name).toContain(name);
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

/**
 * A singleton STI base emitted with a manifest scope excludes a subtype
 * registered only at run time (#5375).
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { servedFamilyTypes } from '../create-target';
import { SmrtObject } from '../object';
import { ObjectRegistry, smrt } from '../registry';

describe('servedFamilyTypes with a singleton manifest scope', () => {
  beforeEach(() => {
    ObjectRegistry.clear();
  });
  afterEach(() => {
    ObjectRegistry.clear();
  });

  it('excludes a subtype registered after the base was generated', () => {
    @smrt({ tableStrategy: 'sti' })
    class Doc extends SmrtObject {
      title = '';
    }
    const scope = new Set(['@happyvertical/smrt-core:Doc']);
    // No descendants yet: nothing to narrow.
    expect(servedFamilyTypes('Doc', 'api', 'get', scope)).toBeUndefined();

    @smrt()
    class LateDoc extends Doc {
      extra = '';
    }
    expect(ObjectRegistry.getDescendants('Doc')).toHaveLength(1);
    expect(servedFamilyTypes('Doc', 'api', 'get', scope)).toEqual(['Doc']);
    // Without a manifest scope the late subtype is admitted (the old gap).
    expect(servedFamilyTypes('Doc', 'api', 'get')).toBeUndefined();
    void LateDoc;
  });
});

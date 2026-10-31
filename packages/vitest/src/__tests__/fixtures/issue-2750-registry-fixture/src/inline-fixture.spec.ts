/**
 * #2760 Finding 2: an inline test-file fixture. `InlineProbeGadget` is
 * described by the test manifest (its file is scanned) but must never reach
 * another spec's registry through manifest bulk registration
 * (`registerManifestObjects` skips `.test.`/`.spec.` entries). See
 * `registry-probe.spec.ts`.
 */
import {
  field,
  ObjectRegistry,
  SmrtObject,
  smrt,
} from '@happyvertical/smrt-core';
import { describe, expect, it } from 'vitest';

@smrt({ api: { include: ['list', 'get', 'create', 'update', 'delete'] } })
export class InlineProbeGadget extends SmrtObject {
  @field({ required: true })
  label = '';
}

describe('issue #2760 inline fixture', () => {
  it('registers in its own file through its decorator', () => {
    expect(
      ObjectRegistry.getQualifiedClassNames().some((name) =>
        name.endsWith(':InlineProbeGadget'),
      ),
    ).toBe(true);
  });
});

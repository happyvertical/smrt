/**
 * The public `./generators` entry publishes `cachePolicy`, the read
 * Cache-Control of a request's resolved tenancy, as it did before the
 * helper moved out of the conditional-get module.
 */
import { cachePolicy } from '@happyvertical/smrt-core/generators';
import { describe, expect, it } from 'vitest';

describe('smrt-core/generators', () => {
  it('publishes cachePolicy', () => {
    expect(typeof cachePolicy).toBe('function');
    expect(cachePolicy.name).toBe('cachePolicy');
  });
});

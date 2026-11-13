// An app subclass named Profile must not break the real package's STI family
// (Person, Organization extend the real Profile). Fixed in core (#4871).
import { describe, expect, it } from 'vitest';

describe('a run-time subclass named Profile', () => {
  it('registers @local/app:Profile without breaking Person/Organization STI', async () => {
    const { ObjectRegistry, registerRuntimeModel } = await import(
      '@happyvertical/smrt-core'
    );
    await import('@happyvertical/smrt-profiles');
    registerRuntimeModel({
      name: 'Profile',
      packageName: '@local/app',
      extends: '@happyvertical/smrt-profiles:Profile',
      fields: { nickname: { type: 'text' } },
    });
    expect(
      ObjectRegistry.getSTIBase('@happyvertical/smrt-profiles:Person'),
    ).toBe('@happyvertical/smrt-profiles:Profile');
    expect(() => ObjectRegistry.getAllSchemasAsDefinitions()).not.toThrow();
  });
});

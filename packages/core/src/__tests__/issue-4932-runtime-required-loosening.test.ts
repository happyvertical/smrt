/**
 * #4932: an app may tighten or loosen any field, with one limit: it may not
 * loosen a field smrt needs (a required field that carries `requiredFor`).
 * The build refuses it; these tests cover the paths with no build in the way:
 * a run-time model that extends a registered class, and a subclass registered
 * by its decorator. Both use the same decision as the build
 * (`schema/field-inheritance.ts`) and the same error code.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { field } from '../decorators/index.js';
import { SmrtObject } from '../object.js';
import { ObjectRegistry, smrt } from '../registry.js';
import { registerRuntimeModel, runtimeModelEntry } from '../runtime-model.js';
import { snapshotObjectRegistryState } from '../test-utils.js';

// `tenant-scope` is what a required `@tenantId()` carries; core has no tenant
// decorator, so the fixtures state it directly.
@smrt({ tableName: 'rt4932_own_parents' })
class OwnParent4932 extends SmrtObject {
  @field({ required: true, requiredFor: 'identity' }) code = '';
  @field({ required: true, requiredFor: 'tenant-scope' }) tenantId = '';
  @field() note = '';
  @field({ required: true }) title = '';
  @field({ default: 'a' }) kind = 'a';
}

@smrt({ tableStrategy: 'sti', tableName: 'rt4932_shared_parents' })
class SharedParent4932 extends SmrtObject {
  @field({ required: true, requiredFor: 'identity' }) code = '';
  @field() note = '';
}

const qn = (ctor: typeof SmrtObject) =>
  ObjectRegistry.getClassByConstructor(ctor)!.qualifiedName!;

describe('#4932 run-time models keep the limit on loosening', () => {
  let restore: () => void;
  beforeEach(() => {
    restore = snapshotObjectRegistryState();
  });
  afterEach(() => restore());

  const sub = (parent: string, fields: Record<string, any>, name = 'Sub') => ({
    name,
    packageName: '@test4932/app',
    extends: parent,
    fields,
  });

  describe.each([
    ['own-table parent', () => qn(OwnParent4932)],
    ['shared-table parent', () => qn(SharedParent4932)],
  ])('%s', (_label, parent) => {
    it('refuses a run-time subclass that makes a field smrt needs optional', () => {
      const attempt = () =>
        runtimeModelEntry(
          sub(parent(), { code: { type: 'text', required: false } }),
        );
      expect(attempt).toThrow(/Sub\.code cannot be made optional/);
      expect(attempt).toThrow(/identity/);
      try {
        attempt();
      } catch (e) {
        expect((e as { code?: string }).code).toBe(
          'CONFIG_REQUIRED_FIELD_LOOSENED',
        );
      }
      expect(() =>
        registerRuntimeModel(
          sub(parent(), { code: { type: 'text', required: false } }),
        ),
      ).toThrow(/CONFIG_REQUIRED_FIELD_LOOSENED|cannot be made optional/);
    });

    it('allows a subclass that tightens a field', () => {
      const name = registerRuntimeModel(
        sub(parent(), { note: { type: 'text', required: true } }),
      );
      expect(ObjectRegistry.getClass(name)).toBeDefined();
    });

    it('allows a subclass that restates a field smrt needs as required', () => {
      expect(() =>
        registerRuntimeModel(
          sub(parent(), { code: { type: 'text', required: true } }),
        ),
      ).not.toThrow();
    });
  });

  it('allows loosening a required field that states no reason', () => {
    const name = registerRuntimeModel(
      sub(qn(OwnParent4932), { title: { type: 'text', required: false } }),
    );
    expect(ObjectRegistry.getClass(name)).toBeDefined();
  });

  it('refuses loosening a tenant-scope field', () => {
    expect(() =>
      runtimeModelEntry(
        sub(qn(OwnParent4932), { tenantId: { type: 'text', required: false } }),
      ),
    ).toThrow(/Sub\.tenantId cannot be made optional.*tenant-scope/);
  });

  it('lists inherited fields that smrt needs as required, with their reason', () => {
    const entry = runtimeModelEntry(sub(qn(OwnParent4932), {}));
    expect(entry.fields.code.required).toBe(true);
    expect(entry.fields.code._meta?.requiredFor).toBe('identity');
    expect(entry.fields.tenantId.required).toBe(true);
    expect(entry.fields.tenantId._meta?.requiredFor).toBe('tenant-scope');
    // A required field with no reason is still listed as optional (it is the
    // app's to loosen, and the column list of a new table is authoritative).
    expect(entry.fields.title.required).toBe(false);
  });

  describe('options the redeclaration does not state are inherited (#4942)', () => {
    it('keeps required and requiredFor when required is not stated', async () => {
      const name = registerRuntimeModel(
        sub(qn(OwnParent4932), {
          code: { type: 'text', description: 'Our code' },
        }),
      );
      const fields = await ObjectRegistry.getAllFields(name);
      expect(fields.get('code')?.required).toBe(true);
      expect(fields.get('code')?._meta?.requiredFor).toBe('identity');
      const entry = runtimeModelEntry(
        sub(qn(OwnParent4932), { code: { type: 'text' } }),
      );
      expect(entry.fields.code.required).toBe(true);
    });

    it('does the same for a shared-table parent', () => {
      expect(() =>
        registerRuntimeModel(
          sub(qn(SharedParent4932), { code: { type: 'text' } }),
        ),
      ).not.toThrow();
    });

    it('keeps required on an ordinary required field', () => {
      const entry = runtimeModelEntry(
        sub(qn(OwnParent4932), { title: { type: 'text' } }),
      );
      expect(entry.fields.title.required).toBe(true);
    });

    it('keeps a default it does not state, and drops them on a type change', () => {
      const same = runtimeModelEntry(
        sub(qn(OwnParent4932), { kind: { type: 'text', description: 'Kind' } }),
      );
      expect(same.fields.kind.default).toBe('a');
      const changed = runtimeModelEntry(
        sub(qn(OwnParent4932), { kind: { type: 'integer' } }),
      );
      expect(changed.fields.kind.default).toBeUndefined();
    });
  });

  it('registers an empty subclass of an own-table parent and resolves its fields', async () => {
    const name = registerRuntimeModel(sub(qn(OwnParent4932), {}));
    const fields = await ObjectRegistry.getAllFields(name);
    expect(fields.get('code')?.required).toBe(true);
    expect(fields.get('tenantId')?.required).toBe(true);
  });
});

describe('#4932 decorator registration with no build', () => {
  let restore: () => void;
  beforeEach(() => {
    restore = snapshotObjectRegistryState();
  });
  afterEach(() => restore());

  it('registers, then refuses where the effective fields are resolved', async () => {
    @smrt({ tableName: 'rt4932_dec_parents' })
    class DecParent extends SmrtObject {
      @field({ required: true, requiredFor: 'workflow-state' }) status = '';
    }
    // Registration itself cannot refuse: a parent may register after its
    // child, so the parent's fields are not always known yet.
    @smrt({ tableName: 'rt4932_dec_loose' })
    class DecLoose extends DecParent {
      @field({ required: false }) override status = '';
    }
    expect(ObjectRegistry.getClassByConstructor(DecLoose)).toBeDefined();
    await expect(ObjectRegistry.getAllFields(qn(DecLoose))).rejects.toThrow(
      /DecLoose\.status cannot be made optional.*workflow-state/,
    );
  });

  it('allows a decorated subclass that tightens, or loosens a field with no reason', async () => {
    @smrt({ tableName: 'rt4932_dec_parents2' })
    class DecParent2 extends SmrtObject {
      @field({ required: true, requiredFor: 'workflow-state' }) status = '';
      @field({ required: true }) title = '';
      @field() note = '';
    }
    @smrt({ tableName: 'rt4932_dec_ok' })
    class DecOk extends DecParent2 {
      @field({ required: false }) override title = '';
      @field({ required: true }) override note = '';
    }
    const fields = await ObjectRegistry.getAllFields(qn(DecOk));
    expect(fields.get('title')?.required).toBe(false);
    expect(fields.get('note')?.required).toBe(true);
    expect(fields.get('status')?.required).toBe(true);
  });
});

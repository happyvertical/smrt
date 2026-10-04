// @vitest-environment jsdom
/**
 * The package's UI slots, and that importing the `./svelte` entry registers
 * the module and a component for every slot with `ModuleUIRegistry`.
 */
import { ModuleUIRegistry } from '@happyvertical/smrt-ui/registry';
import { describe, expect, it } from 'vitest';
import { MANUFACTURING_MODULE_META, MANUFACTURING_UI_SLOTS } from '../../ui.js';

const MODULE = '@happyvertical/smrt-manufacturing';
const SLOTS = [
  'operation-list',
  'operation-form',
  'assembly-list',
  'assembly-form',
  'bom-editor',
];

describe('manufacturing UI slots', () => {
  it('declares the slots, each keyed by its own id', () => {
    expect(Object.keys(MANUFACTURING_UI_SLOTS)).toEqual(SLOTS);
    for (const [key, slot] of Object.entries(MANUFACTURING_UI_SLOTS)) {
      expect(slot.id).toBe(key);
      expect(slot.propsInterface).toMatch(/Props$/);
    }
    expect(MANUFACTURING_MODULE_META.name).toBe(MODULE);
  });

  it('registers the module and a component per slot when the svelte entry is imported', async () => {
    ModuleUIRegistry.clear();
    const entry = await import('../index.js');
    expect(ModuleUIRegistry.getModules()).toContain(MODULE);
    expect([...ModuleUIRegistry.getSlots(MODULE)].sort()).toEqual(
      [...SLOTS].sort(),
    );
    expect(ModuleUIRegistry.get(MODULE, 'operation-list')).toBe(
      entry.OperationList,
    );
    expect(ModuleUIRegistry.get(MODULE, 'operation-form')).toBe(
      entry.OperationForm,
    );
    expect(ModuleUIRegistry.get(MODULE, 'assembly-list')).toBe(
      entry.AssemblyList,
    );
    expect(ModuleUIRegistry.get(MODULE, 'assembly-form')).toBe(
      entry.AssemblyForm,
    );
    expect(ModuleUIRegistry.get(MODULE, 'bom-editor')).toBe(entry.BomEditor);
  });
});

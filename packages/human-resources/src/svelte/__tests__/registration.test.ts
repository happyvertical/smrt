// @vitest-environment jsdom
/**
 * The package's UI slots, and that importing the `./svelte` entry registers
 * the module and a component for every slot with `ModuleUIRegistry`.
 */
import { ModuleUIRegistry } from '@happyvertical/smrt-ui/registry';
import { describe, expect, it } from 'vitest';
import {
  HUMAN_RESOURCES_MODULE_META,
  HUMAN_RESOURCES_UI_SLOTS,
} from '../../ui.js';

const MODULE = '@happyvertical/smrt-human-resources';
const SLOTS = [
  'employee-list',
  'employee-form',
  'person-qualifications',
  'expiring-qualifications-list',
];

describe('HR UI slots', () => {
  it('declares the four slots, each keyed by its own id', () => {
    expect(Object.keys(HUMAN_RESOURCES_UI_SLOTS)).toEqual(SLOTS);
    for (const [key, slot] of Object.entries(HUMAN_RESOURCES_UI_SLOTS)) {
      expect(slot.id).toBe(key);
      expect(slot.label).toBeTruthy();
      expect(slot.propsInterface).toMatch(/Props$/);
    }
    expect(HUMAN_RESOURCES_MODULE_META.name).toBe(MODULE);
    expect(HUMAN_RESOURCES_MODULE_META.uiSlots).toBe(HUMAN_RESOURCES_UI_SLOTS);
  });

  it('registers the module and a component for every slot when the svelte entry is imported', async () => {
    ModuleUIRegistry.clear();
    expect(ModuleUIRegistry.getSlots(MODULE)).toEqual([]);
    const entry = await import('../index.js');
    expect(ModuleUIRegistry.getModules()).toContain(MODULE);
    expect(ModuleUIRegistry.getModuleMeta(MODULE)).toBe(
      HUMAN_RESOURCES_MODULE_META,
    );
    expect([...ModuleUIRegistry.getSlots(MODULE)].sort()).toEqual(
      [...SLOTS].sort(),
    );
    expect(ModuleUIRegistry.get(MODULE, 'employee-list')).toBe(
      entry.EmployeeList,
    );
    expect(ModuleUIRegistry.get(MODULE, 'employee-form')).toBe(
      entry.EmployeeForm,
    );
    expect(ModuleUIRegistry.get(MODULE, 'person-qualifications')).toBe(
      entry.PersonQualifications,
    );
    expect(ModuleUIRegistry.get(MODULE, 'expiring-qualifications-list')).toBe(
      entry.ExpiringQualificationsList,
    );
  });
});

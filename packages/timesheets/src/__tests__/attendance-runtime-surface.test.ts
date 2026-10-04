import {
  isApiActionEnabledForObject,
  MCPGenerator,
  ObjectRegistry,
} from '@happyvertical/smrt-core';
import { afterEach, expect, it } from 'vitest';
import '../attendance.js';

afterEach(() => ObjectRegistry.clear());

it('lets a consumer close attendance routes without replacement models or schema drift', async () => {
  const schemas = ObjectRegistry.getAllSchemasAsDefinitions();
  const count = ObjectRegistry.getAllClasses().size;
  for (const name of ['AttendancePunch', 'AttendanceBreak']) {
    const key = `@happyvertical/smrt-timesheets:${name}`;
    const registered = ObjectRegistry.getClass(key);
    expect(isApiActionEnabledForObject(key, 'list')).toBe(true);
    ObjectRegistry.registerOverride(key, {
      api: false,
      cli: false,
      mcp: false,
    });
    expect(ObjectRegistry.getClass(key)).toBe(registered);
    for (const action of [
      'list',
      'get',
      'create',
      'update',
      'delete',
    ] as const) {
      expect(isApiActionEnabledForObject(key, action)).toBe(false);
    }
    expect(ObjectRegistry.getConfig(key)).toMatchObject({
      api: false,
      cli: false,
      mcp: false,
    });
    expect(ObjectRegistry.getTenantScopedConfig(key)?.mode).toBe('required');
  }
  expect(ObjectRegistry.getAllClasses().size).toBe(count);
  expect(ObjectRegistry.getAllSchemasAsDefinitions()).toEqual(schemas);
  const tools = await new MCPGenerator().generateTools();
  expect(
    tools.filter((tool) =>
      /^(attendancepunch|attendancebreak)_/.test(tool.name),
    ),
  ).toEqual([]);
});

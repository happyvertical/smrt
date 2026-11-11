import { ObjectRegistry, registerRuntimeModel } from '@happyvertical/smrt-core';
import { setRuntimeModelReadiness } from '@happyvertical/smrt-core/runtime-exposure';
import { afterEach, expect, it } from 'vitest';
import { CLIGenerator } from '../cli-generator.js';

afterEach(() => {
  ObjectRegistry.clear();
  globalThis.__smrtModelReadiness?.clear();
});
it('refreshes cached field options and discovers a list added to a running CLI', async () => {
  ObjectRegistry.clear();
  const def = {
    name: 'CustomRecord',
    packageName: '@fixture/runtime-cli',
    fields: { title: { type: 'text' as const } },
  };
  registerRuntimeModel(def);
  const cli = new CLIGenerator() as unknown as {
    getObjectCommandsLazy(
      name: string,
    ): Promise<Array<{ name: string; options: Record<string, unknown> }>>;
    findObjectCommand(name: string): Promise<{ name: string } | undefined>;
    manifestLoaded: boolean;
  };
  cli.manifestLoaded = true;
  expect(
    (await cli.getObjectCommandsLazy('customrecord')).find(
      (cmd) => cmd.name === 'customrecord:create',
    )?.options,
  ).not.toHaveProperty('extra');
  registerRuntimeModel(
    { ...def, fields: { ...def.fields, extra: { type: 'text' } } },
    { refresh: true },
  );
  expect(
    (await cli.getObjectCommandsLazy('customrecord')).find(
      (cmd) => cmd.name === 'customrecord:create',
    )?.options,
  ).toHaveProperty('extra');
  registerRuntimeModel({
    name: 'NewList',
    packageName: def.packageName,
    fields: { title: { type: 'text' } },
  });
  expect((await cli.findObjectCommand('newlist:list'))?.name).toBe(
    'newlist:list',
  );
  setRuntimeModelReadiness(['@fixture/runtime-cli:NewList'], false);
  expect(await cli.findObjectCommand('newlist:list')).toBeUndefined();
  setRuntimeModelReadiness(['@fixture/runtime-cli:NewList'], true);
  expect((await cli.findObjectCommand('newlist:list'))?.name).toBe(
    'newlist:list',
  );
});

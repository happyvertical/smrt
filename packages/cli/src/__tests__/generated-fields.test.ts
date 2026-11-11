import { ObjectRegistry, registerRuntimeModel } from '@happyvertical/smrt-core';
import { afterEach, expect, it } from 'vitest';
import { CLIGenerator } from '../cli-generator.js';

afterEach(() => ObjectRegistry.clear());

it('omits generated CLI inputs and refuses supplied values before readonly filtering', async () => {
  ObjectRegistry.clear();
  const name = registerRuntimeModel({
    name: 'GeneratedCliLine',
    packageName: '@test/generated-cli',
    fields: {
      qty: { type: 'integer' },
      price: { type: 'integer' },
      total: {
        type: 'integer',
        generated: { op: 'mul', left: { col: 'qty' }, right: { col: 'price' } },
      },
    },
  });
  const cli = new CLIGenerator() as unknown as {
    getObjectCommandsLazy(
      name: string,
    ): Promise<Array<{ name: string; options: Record<string, unknown> }>>;
    applyWritablePolicy(name: string, data: object): object;
    manifestLoaded: boolean;
  };
  cli.manifestLoaded = true;
  const commands = await cli.getObjectCommandsLazy('generatedcliline');
  for (const action of ['create', 'update']) {
    const command = commands.find(
      (command) => command.name === `generatedcliline:${action}`,
    );
    expect(command?.options).toHaveProperty('qty');
    expect(command?.options).not.toHaveProperty('total');
  }
  expect(() =>
    cli.applyWritablePolicy(name, { qty: 2, total: 10 }),
  ).toThrowError(
    expect.objectContaining({ code: 'VALIDATION_GENERATED_FIELD_WRITE' }),
  );
  expect(cli.applyWritablePolicy(name, { qty: 2 })).toEqual({ qty: 2 });
});

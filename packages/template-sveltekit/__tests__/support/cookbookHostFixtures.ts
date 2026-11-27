import { randomUUID } from 'node:crypto';
import { Customer } from '@happyvertical/smrt-commerce';
import { field, ObjectRegistry, SmrtCollection, SmrtObject, smrt } from '@happyvertical/smrt-core';
import { Profile as ProfileBase } from '@happyvertical/smrt-profiles';
import type { Cookbook } from '@happyvertical/smrt-types';

@smrt({
  packageName: '@fixture/host',
  tableName: 'host_memos',
  collection: 'host_memos',
  api: { public: true },
  mcp: { include: ['list', 'get', 'create', 'delete'] },
})
export class HostMemo extends SmrtObject {
  @field() title = '';
}
// Same empty replacement the public generator emits; retain provider STI ancestry.
@smrt({ packageName: '@fixture/host', name: 'Profile', replaceParent: true })
export class Profile extends ProfileBase {}
void HostMemo;
void Customer;
void Profile;
export const CUSTOMER = '@happyvertical/smrt-commerce:Customer';
export const PROFILE = '@happyvertical/smrt-profiles:Profile';
export const MEMO = '@fixture/host:HostMemo';
export const COLLISIONS = [
  '@fixture/collision-one:CatalogCollision',
  '@fixture/collision-two:CatalogCollision',
];
for (const [index, id] of COLLISIONS.entries()) {
  ObjectRegistry.register(class CatalogCollision extends SmrtObject {}, {
    packageName: id.split(':')[0],
    tableName: `host_collision_${index}`,
    collection: `host_collision_${index}`,
    api: { include: ['list', 'get'] },
    mcp: { include: ['list'] },
  });
}
class HostMemos extends SmrtCollection<HostMemo> {
  static readonly _itemClass = HostMemo;
}
ObjectRegistry.registerCollection(MEMO, HostMemos);
export const catalog = {
  recipes: [
    {
      id: 'host.customers',
      label: 'Customers',
      models: [CUSTOMER, PROFILE],
      nav: [{ model: CUSTOMER, label: 'Customers' }],
      requires: [],
    },
    {
      id: 'host.memos',
      label: 'Memos',
      models: [MEMO, ...COLLISIONS],
      nav: [{ model: MEMO, label: 'Memos' }],
      requires: [],
    },
  ],
  models: [
    { id: CUSTOMER, name: 'Customer', packageId: 'commerce' },
    { id: PROFILE, name: 'Profile', packageId: 'profiles', exposed: true },
    { id: MEMO, name: 'HostMemo', packageId: 'host' },
    ...COLLISIONS.map((id) => ({
      id,
      name: 'CatalogCollision',
      packageId: id.split(':')[0],
    })),
  ],
};
export const cookbook: Cookbook = {
  $schema: 'https://smrt.happyvertical.com/schemas/cookbook/v1.json',
  version: 1,
  recipes: ['host.customers'],
  features: [],
  policies: [],
};
export const tool = (name: string, args: unknown) => ({
  content: '',
  finishReason: 'tool_calls',
  toolCalls: [
    {
      id: randomUUID(),
      type: 'function',
      function: { name, arguments: JSON.stringify(args) },
    },
  ],
});
export const text = () => ({ content: 'Done.', finishReason: 'stop' });
export function json(value: unknown) {
  return Response.json(value);
}

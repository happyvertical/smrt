import { ObjectRegistry } from '@happyvertical/smrt-core';
import {
  Fact,
  FactCollection,
  FactContent,
  FactContentCollection,
  FactSource,
  FactSourceCollection,
  FactSubject,
  FactSubjectCollection,
  FactTag,
  FactTagCollection,
} from '../../facts/src/index';

ObjectRegistry.register(Fact, { packageName: '@happyvertical/smrt-facts' });
ObjectRegistry.register(FactCollection as any, {
  packageName: '@happyvertical/smrt-facts',
});
ObjectRegistry.register(FactContent, {
  packageName: '@happyvertical/smrt-facts',
});
ObjectRegistry.register(FactContentCollection as any, {
  packageName: '@happyvertical/smrt-facts',
});
ObjectRegistry.register(FactSource, {
  packageName: '@happyvertical/smrt-facts',
});
ObjectRegistry.register(FactSourceCollection as any, {
  packageName: '@happyvertical/smrt-facts',
});
ObjectRegistry.register(FactSubject, {
  packageName: '@happyvertical/smrt-facts',
});
ObjectRegistry.register(FactSubjectCollection as any, {
  packageName: '@happyvertical/smrt-facts',
});
ObjectRegistry.register(FactTag, { packageName: '@happyvertical/smrt-facts' });
ObjectRegistry.register(FactTagCollection as any, {
  packageName: '@happyvertical/smrt-facts',
});

export * from '../../facts/src/index';

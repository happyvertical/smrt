import { smrt } from '@happyvertical/smrt-core';
import { Person as SmrtPerson } from '@happyvertical/smrt-profiles';

// Register only after the framework models and a registry snapshot are loaded.
export function registerAppModels(): { Person: typeof SmrtPerson } {
  class Person extends SmrtPerson {}
  smrt({ packageName: '@local/issue-4931-app-runtime' })(Person);
  return { Person };
}

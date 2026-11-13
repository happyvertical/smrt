import { getPreferencePrincipal } from '@happyvertical/smrt-preferences';
import { loadCookbookApp } from '@happyvertical/smrt-svelte/cookbook/server';
import { createCookbookPreferences } from '@happyvertical/smrt-template-sveltekit/host/preferences';
import { host, runtime } from '$lib/server/smrt';

export type {
  CookbookSaveResult,
  CookbookScope,
  CookbookSource,
} from '@happyvertical/smrt-template-sveltekit/host/preferences';
export { SHELL_SURFACE } from '@happyvertical/smrt-template-sveltekit/host/preferences';
export const { loadCookbook, saveCookbookEdits, homePath } =
  createCookbookPreferences({
    runtime,
    app: async () => {
      const principal = getPreferencePrincipal();
      return principal
        ? host.cookbookApp(principal.tenantId)
        : loadCookbookApp();
    },
  });

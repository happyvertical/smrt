import { fail } from '@sveltejs/kit';
import {
  PROMPTS_CUSTOMIZE_PERMISSION,
  promptSettingsService,
  requireSettingsSession,
  settingsFailure,
} from '$lib/server/settings';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals, depends }) => {
  depends('smrt:prompt-settings');
  const session = requireSettingsSession(locals);
  const settings = await promptSettingsService(session);
  return {
    tenantId: session.tenantId,
    // The owner edits both the app-wide text and this workspace's override.
    canEdit: session.can(PROMPTS_CUSTOMIZE_PERMISSION),
    prompts: await settings.listPromptSettings({ tenantId: session.tenantId }),
  };
};

export const actions: Actions = {
  savePrompt: async ({ request, locals }) => {
    const session = requireSettingsSession(locals);
    const form = await request.formData();
    const key = String(form.get('key') ?? '');
    const settings = await promptSettingsService(session);
    // A checked box overrides with the text; an unchecked one reverts.
    const value = (override: string, template: string) =>
      form.has(override) ? String(form.get(template) ?? '') : null;
    try {
      await settings.setTenantPromptOverride(
        key,
        session.tenantId,
        value('tenantOverride', 'tenantTemplate'),
      );
      // The app column is posted only when the panel rendered it editable.
      if (form.has('appTemplate') || form.has('appOverride')) {
        await settings.setAppPromptOverride(
          key,
          value('appOverride', 'appTemplate'),
        );
      }
    } catch (cause) {
      const failure = settingsFailure(cause);
      return fail(failure.status, { error: failure.error });
    }
    return { message: 'Prompt overrides saved.' };
  },
};

// The cloud owner's inference page (#5191): what the redacted projection leaves
// the real panel to render. The tenant's allow-list stays (it says what THIS
// tenant may choose); without it the panel disables every choice.

import { InferenceSettingsPanel } from '@happyvertical/smrt-inference/svelte';
import { mount, tick, unmount } from 'svelte';
import { afterEach, expect, it } from 'vitest';
import { hideDeploymentRows } from '../../../lib/server/inference-hosted-view.ts';

let component: ReturnType<typeof mount> | undefined;
afterEach(async () => {
  if (component) await unmount(component);
  component = undefined;
  document.body.innerHTML = '';
});

const row = (tier: string, tenantAllowList: string[] | null) => ({
  tier,
  effectiveLabel: 'operator-model-x',
  effectiveTarget: { provider: 'openai', model: 'operator-model-x' },
  supplyingLevel: 'app',
  appTarget: { provider: 'openai', model: 'operator-model-x' },
  tenantTarget: null,
  tenantAllowList,
});

function pageFor(allow: string[] | null) {
  const data = hideDeploymentRows({
    tenantId: 't',
    canEdit: true,
    canPersonalize: false,
    defaults: { keySet: false },
    providers: [],
    tiers: [row('good', allow)],
    defaultTier: {
      effectiveTier: 'good',
      appTier: 'best',
      tenantTier: null,
      tenantAllowList: allow,
    },
    aliases: [{ name: 'operatorchain', candidates: [] }],
    fusions: [],
    transcripts: null,
    usage: null,
  } as never);
  return { ...data, hosted: true };
}

/** The props `+page.svelte` gives the panel in the hosted app. */
function panelProps(allow: string[] | null) {
  const data = pageFor(allow);
  return {
    defaults: data.defaults,
    providers: data.providers,
    tiers: data.tiers,
    defaultTier: data.defaultTier,
    aliases: data.aliases,
    fusions: data.fusions,
    transcripts: data.transcripts,
    appEditable: false,
    scope: 'tenant',
    advancedOpen: true,
  } as never;
}

const modelOption = () =>
  document.querySelector<HTMLOptionElement>('option[value="model"]');

it('an allowed override is selectable and the operator’s value is not on the page', async () => {
  component = mount(InferenceSettingsPanel, {
    target: document.body,
    props: panelProps(['model:openai/gpt-4.1']),
  });
  await tick();
  expect(modelOption()).not.toBeNull();
  expect(modelOption()?.disabled).toBe(false);
  expect(document.body.textContent).not.toContain('operator-model-x');
  expect(document.body.textContent).not.toContain('operatorchain');
});

it('with nothing allowed the Model choice stays disabled', async () => {
  component = mount(InferenceSettingsPanel, {
    target: document.body,
    props: panelProps(null),
  });
  await tick();
  expect(modelOption()?.disabled).toBe(true);
});

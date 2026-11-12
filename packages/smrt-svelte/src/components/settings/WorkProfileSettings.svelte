<script lang="ts">
import type {
  WorkProfileSettings as OwnerWorkProfileSettings,
  ResolvedWorkProfile,
  WorkProfileBudgets,
  WorkProfileName,
} from '@happyvertical/smrt-inference';
import { FormGroup, Input, Select, Toggle } from '@happyvertical/smrt-ui/forms';
import { defineMessages, useI18n } from '@happyvertical/smrt-ui/i18n';
import { Button, Card } from '@happyvertical/smrt-ui/ui';

const M = defineMessages({
  'ui.work_profiles.title': 'Assistant quality',
  'ui.work_profiles.note':
    'AI work uses your connected plan or saved API key. Best intelligence is recommended.',
  'ui.work_profiles.design': 'System design',
  'ui.work_profiles.assist': 'Everyday assistance',
  'ui.work_profiles.background': 'Background work',
  'ui.work_profiles.engine': 'Engine',
  'ui.work_profiles.model': 'Model',
  'ui.work_profiles.effort': 'Reasoning effort',
  'ui.work_profiles.recommended': 'Recommended',
  'ui.work_profiles.resolved':
    'Currently resolves to {engine} · {model} · {effort}',
  'ui.work_profiles.unavailable':
    'This connection is unavailable. You can change its settings or reset to recommended.',
  'ui.work_profiles.provider': 'Best available from your provider',
  'ui.work_profiles.escalate':
    'Automatically use system design for structure changes',
  'ui.work_profiles.preview': 'Preview before applying design changes',
  'ui.work_profiles.save': 'Save assistant quality',
  'ui.work_profiles.reset': 'Reset to recommended',
  'ui.work_profiles.failed':
    'The change could not be saved. Refresh and try again.',
  'ui.work_profiles.cli_limits':
    'CLI connections enforce app tool steps and pass time limits. Token budgets depend on usage reported by the CLI; a per-call token ceiling cannot be guaranteed.',
  'ui.work_profiles.safety':
    'Destructive actions still require owner approval. CLI security protections always apply.',
  'ui.work_profiles.maxSteps': 'Tool steps per pass',
  'ui.work_profiles.maxTokens': 'Output tokens per call',
  'ui.work_profiles.maxTurnTokens': 'Tokens per pass',
  'ui.work_profiles.requestTimeoutMs': 'Call time limit (milliseconds)',
  'ui.work_profiles.turnTimeoutMs': 'Pass time limit (milliseconds)',
  'ui.work_profiles.maxRunTokens': 'Tokens per run',
  'ui.work_profiles.runTimeoutMs': 'Run time limit (milliseconds)',
  'ui.work_profiles.passes': 'Passes per run',
  'ui.work_profiles.repairRetries': 'Structured output repair attempts',
  'ui.work_profiles.toolResultChars': 'Tool result characters',
});
const { t } = useI18n();
let {
  settings,
  resolved,
  onsave,
  onreset,
  editable = true,
}: {
  settings: Partial<Record<WorkProfileName, OwnerWorkProfileSettings>>;
  resolved: (ResolvedWorkProfile & { unavailable?: boolean })[];
  onsave(
    settings: Partial<Record<WorkProfileName, OwnerWorkProfileSettings>>,
  ): Promise<void>;
  onreset(): Promise<void>;
  editable?: boolean;
} = $props();
let drafts = $state<Partial<Record<WorkProfileName, OwnerWorkProfileSettings>>>(
  {},
);
let busy = $state(false);
let failed = $state(false);
$effect(() => {
  drafts = structuredClone(settings);
});
const budgetKeys: (keyof WorkProfileBudgets)[] = [
  'maxSteps',
  'maxTokens',
  'maxTurnTokens',
  'requestTimeoutMs',
  'turnTimeoutMs',
  'maxRunTokens',
  'runTimeoutMs',
  'passes',
  'repairRetries',
  'toolResultChars',
];
function change(
  name: WorkProfileName,
  field: keyof OwnerWorkProfileSettings,
  value: unknown,
) {
  const next = { ...drafts[name], [field]: value };
  if (value === undefined) delete next[field];
  drafts = { ...drafts, [name]: next };
}
async function save(reset = false) {
  busy = true;
  failed = false;
  try {
    if (reset) await onreset();
    else await onsave(drafts);
  } catch {
    failed = true;
  } finally {
    busy = false;
  }
}
</script>
<section data-smrt-component="WorkProfileSettings" aria-label={t(M['ui.work_profiles.title'])}>
  <h2>{t(M['ui.work_profiles.title'])}</h2>
  <p>{t(M['ui.work_profiles.note'])}</p>
  {#each resolved as profile (profile.name)}
    <Card>
      <h3>{t(M[`ui.work_profiles.${profile.name}`])}</h3>
      {#if profile.unavailable}<p role="status">{t(M['ui.work_profiles.unavailable'])}</p>{:else}<p>{t(M['ui.work_profiles.resolved'], { engine: profile.engine, model: profile.model ?? t(M['ui.work_profiles.provider']), effort: profile.effort })}</p>{/if}
      <FormGroup label={t(M['ui.work_profiles.engine'])}>
        <Select value={drafts[profile.name]?.engine ?? ''} disabled={!editable || busy} onchange={event => change(profile.name, 'engine', event.currentTarget.value || undefined)}>
          <option value="">{t(M['ui.work_profiles.recommended'])}</option>
          <option value="claude-code">Claude Code</option><option value="codex">Codex</option><option value="chatgpt">ChatGPT</option><option value="api">API key</option>
        </Select>
      </FormGroup>
      <FormGroup label={t(M['ui.work_profiles.model'])}>
        <Input value={drafts[profile.name]?.model ?? ''} placeholder={profile.model ?? t(M['ui.work_profiles.provider'])} disabled={!editable || busy} onchange={event => change(profile.name, 'model', event.currentTarget.value.trim() || undefined)} />
      </FormGroup>
      <FormGroup label={t(M['ui.work_profiles.effort'])}>
        <Select value={drafts[profile.name]?.effort ?? ''} disabled={!editable || busy} onchange={event => change(profile.name, 'effort', event.currentTarget.value || undefined)}>
          <option value="">{t(M['ui.work_profiles.recommended'])}</option>
          {#each ['low','medium','high','xhigh','max'] as effort}<option value={effort}>{effort}</option>{/each}
        </Select>
      </FormGroup>
      {#each budgetKeys as key}
        <FormGroup label={t(M[`ui.work_profiles.${key}`])}>
          <Input type="number" min={key === 'repairRetries' ? 0 : 1} step="1" value={drafts[profile.name]?.budgets?.[key] ?? profile.budgets[key]} disabled={!editable || busy} onchange={event => change(profile.name, 'budgets', { ...drafts[profile.name]?.budgets, [key]: Number(event.currentTarget.value) })} />
        </FormGroup>
      {/each}
      {#if profile.name === 'assist'}<Toggle label={t(M['ui.work_profiles.escalate'])} checked={drafts.assist?.autoEscalate ?? profile.autoEscalate} disabled={!editable || busy} onchange={checked => change('assist', 'autoEscalate', checked)} />{/if}
      <Toggle label={t(M['ui.work_profiles.preview'])} checked={drafts[profile.name]?.previewBeforeApply ?? profile.previewBeforeApply} disabled={!editable || busy} onchange={checked => change(profile.name, 'previewBeforeApply', checked)} />
    </Card>
  {/each}
  <p>{t(M['ui.work_profiles.safety'])}</p>
  {#if resolved.some(profile => profile.engine === 'claude-code' || profile.engine === 'codex')}<p>{t(M['ui.work_profiles.cli_limits'])}</p>{/if}
  {#if failed}<p role="alert">{t(M['ui.work_profiles.failed'])}</p>{/if}
  <Button disabled={!editable || busy} onclick={() => save()}>{t(M['ui.work_profiles.save'])}</Button>
  <Button disabled={!editable || busy} onclick={() => save(true)}>{t(M['ui.work_profiles.reset'])}</Button>
</section>

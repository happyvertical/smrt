<script lang="ts">
import type {
  AssistantSafetySettings,
  WorkProfileSettings as OwnerWorkProfileSettings,
  ResolvedWorkProfile,
  WorkProfileBudgets,
  WorkProfileName,
} from '@happyvertical/smrt-inference';
import { engineLabel } from '@happyvertical/smrt-inference';
import { ConfirmDialog } from '@happyvertical/smrt-ui/feedback';
import { FormGroup, Input, Select, Toggle } from '@happyvertical/smrt-ui/forms';
import { defineMessages, useI18n } from '@happyvertical/smrt-ui/i18n';
import { Button, Card, Disclosure } from '@happyvertical/smrt-ui/ui';
import { tick } from 'svelte';
import { safeHref } from '../overview/markdown.js';

const M = defineMessages({
  'ui.work_profiles.title': 'Assistant',
  'ui.work_profiles.note':
    'AI work uses your connected plan or saved API key. Best intelligence is recommended.',
  'ui.work_profiles.design': 'System design',
  'ui.work_profiles.assist': 'Everyday assistance',
  'ui.work_profiles.background': 'Background work',
  'ui.work_profiles.engine': 'Engine',
  'ui.work_profiles.model': 'Model',
  'ui.work_profiles.effort': 'Reasoning effort',
  'ui.work_profiles.recommended': 'Recommended',
  'ui.work_profiles.resolved': '{engine} · {model} · {effort}',
  'ui.work_profiles.strongest': 'strongest model',
  'ui.work_profiles.custom': 'custom model',
  'ui.work_profiles.configured': 'configured model',
  'ui.work_profiles.fallback': 'fallback model',
  'ui.work_profiles.default_model': 'provider default',
  'ui.work_profiles.advanced': 'Advanced',
  'ui.work_profiles.requested_model': 'Requested model',
  'ui.work_profiles.current_model': 'Current model',
  'ui.work_profiles.effort_low': 'low effort',
  'ui.work_profiles.effort_medium': 'medium effort',
  'ui.work_profiles.effort_high': 'high effort',
  'ui.work_profiles.effort_xhigh': 'very high effort',
  'ui.work_profiles.effort_max': 'maximum effort',
  'ui.work_profiles.unavailable':
    'This connection is unavailable. You can change its settings or reset to recommended.',
  'ui.work_profiles.provider': 'Best available from your provider',
  'ui.work_profiles.escalate':
    'Automatically use system design for structure changes',
  'ui.work_profiles.preview': 'Preview before applying design changes',
  'ui.work_profiles.save': 'Save assistant settings',
  'ui.work_profiles.reset': 'Reset to recommended',
  'ui.work_profiles.failed':
    'The change could not be saved. Refresh and try again.',
  'ui.work_profiles.cli_limits':
    'CLI connections enforce app tool steps and pass time limits. Token budgets depend on usage reported by the CLI; a per-call token ceiling cannot be guaranteed.',
  'ui.work_profiles.safety': 'Safety',
  'ui.work_profiles.removals': 'Ask before deleting or removing',
  'ui.work_profiles.removals_help':
    'Applies to chat in this app. Deleted records cannot be restored. Requests from outside this app and permanent purges always need owner approval. Design previews still apply.',
  'ui.work_profiles.protection': 'Protect this computer from local AI tools',
  'ui.work_profiles.protection_help':
    'When on, Claude Code and Codex use the app’s protected tool setup. When off, they can use their own tools, settings and plugins in the app’s data folder.',
  'ui.work_profiles.protection_confirm': 'Turn off local AI protection?',
  'ui.work_profiles.protection_risk':
    "A chat message in this app can run commands and change files on this computer. That includes this app's own data, so records can be changed or deleted without asking you first.",
  'ui.work_profiles.protection_off': 'Turn off protection',
  'ui.work_profiles.cancel': 'Cancel',
  'ui.work_profiles.connect_chatgpt': 'Sign in with ChatGPT in Connect AI',
  'ui.work_profiles.maxSteps': 'Tool steps per pass',
  'ui.work_profiles.maxTokens': 'Output tokens per call',
  'ui.work_profiles.maxTurnTokens': 'Tokens per pass',
  'ui.work_profiles.requestTimeoutMs': 'Reply time limit (seconds)',
  'ui.work_profiles.turnTimeoutMs': 'Pass time limit (seconds)',
  'ui.work_profiles.maxRunTokens': 'Tokens per run',
  'ui.work_profiles.runTimeoutMs': 'Whole request time limit (seconds)',
  'ui.work_profiles.passes': 'Passes per run',
  'ui.work_profiles.repairRetries': 'Attempts to fix an incomplete reply',
  'ui.work_profiles.toolResultChars': 'Maximum action detail (characters)',
  'ui.work_profiles.time_precision':
    'Enter a positive time in seconds with at most three decimal places.',
});
const { t } = useI18n();
let {
  settings,
  resolved,
  onsave,
  onreset,
  editable = true,
  chatgptSignedIn = false,
  connectAiHref = '/settings#chatgpt',
}: {
  settings: Partial<Record<WorkProfileName, OwnerWorkProfileSettings>> & {
    safety?: AssistantSafetySettings;
  };
  resolved: (ResolvedWorkProfile & { unavailable?: boolean })[];
  onsave(
    settings: Partial<Record<WorkProfileName, OwnerWorkProfileSettings>> & {
      safety?: AssistantSafetySettings;
    },
    confirmation?: { confirmUnprotectedCli?: boolean },
  ): Promise<void>;
  onreset(): Promise<void>;
  editable?: boolean;
  chatgptSignedIn?: boolean;
  connectAiHref?: string;
} = $props();
let protectionChecked = $state(true);
let confirmingProtection = $state(false);
let confirmedProtection = $state(false);
let drafts = $state<
  Partial<Record<WorkProfileName, OwnerWorkProfileSettings>> & {
    safety?: AssistantSafetySettings;
  }
>({});
let busy = $state(false);
let failed = $state(false);
let durationEdits = $state<Record<string, { value: string; invalid: boolean }>>(
  {},
);
const invalidDuration = $derived(
  Object.values(durationEdits).some((edit) => edit.invalid),
);
$effect(() => {
  drafts = structuredClone(settings);
  confirmedProtection = false;
  protectionChecked = settings.safety?.protectLocalCli !== false;
  durationEdits = {};
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
const effortChoices = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
function change(
  name: WorkProfileName,
  field: keyof OwnerWorkProfileSettings,
  value: unknown,
) {
  const next = { ...drafts[name], [field]: value };
  if (value === undefined) delete next[field];
  drafts = { ...drafts, [name]: next };
}
// Keep the integer-millisecond contract exact, including floating boundaries.
function formatBudgetSeconds(milliseconds: number): string {
  if (!Number.isSafeInteger(milliseconds) || milliseconds < 1) return '';
  const value = BigInt(milliseconds);
  const fraction = String(value % 1000n)
    .padStart(3, '0')
    .replace(/0+$/, '');
  return `${value / 1000n}${fraction ? `.${fraction}` : ''}`;
}
function changeBudgetSeconds(
  name: WorkProfileName,
  key: keyof WorkProfileBudgets,
  value: string,
) {
  const match = /^(\d*)(?:\.(\d*))?$/.exec(value);
  const fraction = (match?.[2] ?? '').replace(/0+$/, '');
  const milliseconds =
    match && (match[1] || match[2]) && fraction.length <= 3
      ? BigInt(match[1] || '0') * 1000n + BigInt(fraction.padEnd(3, '0') || '0')
      : 0n;
  const invalid =
    milliseconds < 1n || milliseconds > BigInt(Number.MAX_SAFE_INTEGER);
  durationEdits = {
    ...durationEdits,
    [`${name}:${key}`]: { value, invalid },
  };
  if (!invalid)
    change(name, 'budgets', {
      ...drafts[name]?.budgets,
      [key]: Number(milliseconds),
    });
}
async function save(reset = false) {
  if (!reset && invalidDuration) return;
  busy = true;
  failed = false;
  try {
    if (reset) await onreset();
    else if (confirmedProtection)
      await onsave(drafts, { confirmUnprotectedCli: true });
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
      {#if profile.unavailable}<p role="status">{t(M['ui.work_profiles.unavailable'])}</p>{:else}<p>{t(M['ui.work_profiles.resolved'], { engine: engineLabel(profile.engine), model: t(M[profile.modelSelection?.kind === 'strongest' ? 'ui.work_profiles.strongest' : profile.modelSelection?.kind === 'custom' ? 'ui.work_profiles.custom' : profile.modelSelection?.kind === 'fallback' ? 'ui.work_profiles.fallback' : profile.model ? 'ui.work_profiles.configured' : 'ui.work_profiles.default_model']), effort: t(M[`ui.work_profiles.effort_${profile.effort}`]) })}</p>{/if}
      <FormGroup label={t(M['ui.work_profiles.engine'])}>
        <Select value={drafts[profile.name]?.engine ?? ''} disabled={!editable || busy} onchange={event => change(profile.name, 'engine', event.currentTarget.value || undefined)}>
          <option value="">{t(M['ui.work_profiles.recommended'])}</option>
          <option value="claude-code">Claude Code</option><option value="codex">Codex</option><option value="chatgpt">ChatGPT</option><option value="api">API key</option>
        </Select>
      </FormGroup>
      {#if !chatgptSignedIn && (drafts[profile.name]?.engine ?? profile.engine) === 'chatgpt'}
        <Button variant="secondary" href={safeHref(connectAiHref) ?? undefined}>{t(M['ui.work_profiles.connect_chatgpt'])}</Button>
      {/if}
      <Disclosure title={t(M['ui.work_profiles.advanced'])}>
      <p>{t(M['ui.work_profiles.requested_model'])}: <code>{profile.modelSelection?.requestedModel ?? profile.model ?? t(M['ui.work_profiles.default_model'])}</code></p>
      <p>{t(M['ui.work_profiles.current_model'])}: <code>{profile.modelSelection?.resolvedModel ?? profile.model ?? t(M['ui.work_profiles.default_model'])}</code></p>
      <FormGroup label={t(M['ui.work_profiles.model'])}>
        <Input value={drafts[profile.name]?.model ?? ''} placeholder={profile.model ?? t(M['ui.work_profiles.provider'])} disabled={!editable || busy} onchange={event => change(profile.name, 'model', event.currentTarget.value.trim() || undefined)} />
      </FormGroup>
      <FormGroup label={t(M['ui.work_profiles.effort'])}>
        <Select value={drafts[profile.name]?.effort ?? ''} disabled={!editable || busy} onchange={event => change(profile.name, 'effort', event.currentTarget.value || undefined)}>
          <option value="">{t(M['ui.work_profiles.recommended'])}</option>
          {#each effortChoices as effort}<option value={effort}>{t(M[`ui.work_profiles.effort_${effort}`])}</option>{/each}
        </Select>
      </FormGroup>
      {#each budgetKeys as key}
        <FormGroup label={t(M[`ui.work_profiles.${key}`])}>
          <Input type={key.endsWith('TimeoutMs') ? 'text' : 'number'} inputmode={key.endsWith('TimeoutMs') ? 'decimal' : undefined} min={key.endsWith('TimeoutMs') ? undefined : key === 'repairRetries' ? 0 : 1} step={key.endsWith('TimeoutMs') ? undefined : '1'} value={key.endsWith('TimeoutMs') ? durationEdits[`${profile.name}:${key}`]?.value ?? formatBudgetSeconds(drafts[profile.name]?.budgets?.[key] ?? profile.budgets[key]) : drafts[profile.name]?.budgets?.[key] ?? profile.budgets[key]} disabled={!editable || busy} onchange={event => key.endsWith('TimeoutMs') ? changeBudgetSeconds(profile.name, key, event.currentTarget.value) : change(profile.name, 'budgets', { ...drafts[profile.name]?.budgets, [key]: Number(event.currentTarget.value) })} />
        </FormGroup>
      {/each}
      </Disclosure>
      {#if profile.name === 'assist'}<Toggle label={t(M['ui.work_profiles.escalate'])} checked={drafts.assist?.autoEscalate ?? profile.autoEscalate} disabled={!editable || busy} onchange={checked => change('assist', 'autoEscalate', checked)} />{/if}
      <Toggle label={t(M['ui.work_profiles.preview'])} checked={drafts[profile.name]?.previewBeforeApply ?? profile.previewBeforeApply} disabled={!editable || busy} onchange={checked => change(profile.name, 'previewBeforeApply', checked)} />
    </Card>
  {/each}
  <Card>
    <h3>{t(M['ui.work_profiles.safety'])}</h3>
    <Toggle label={t(M['ui.work_profiles.removals'])} checked={drafts.safety?.requireRemovalApproval !== false} disabled={!editable || busy} onchange={checked => { drafts = { ...drafts, safety: { ...drafts.safety, requireRemovalApproval: checked } }; }} />
    <p>{t(M['ui.work_profiles.removals_help'])}</p>
    <Toggle label={t(M['ui.work_profiles.protection'])} bind:checked={protectionChecked} disabled={!editable || busy} onchange={async checked => { if (!checked) { confirmingProtection = true; await tick(); protectionChecked = true; } else { confirmedProtection = false; drafts = { ...drafts, safety: { ...drafts.safety, protectLocalCli: true } }; } }} />
    <p>{t(M['ui.work_profiles.protection_help'])}</p>
  </Card>
  {#if resolved.some(profile => profile.engine === 'claude-code' || profile.engine === 'codex')}<p>{t(M['ui.work_profiles.cli_limits'])}</p>{/if}
  {#if failed}<p role="alert">{t(M['ui.work_profiles.failed'])}</p>{/if}
  {#if invalidDuration}<p role="alert">{t(M['ui.work_profiles.time_precision'])}</p>{/if}
  <Button disabled={!editable || busy || invalidDuration} onclick={() => save()}>{t(M['ui.work_profiles.save'])}</Button>
  <Button disabled={!editable || busy} onclick={() => save(true)}>{t(M['ui.work_profiles.reset'])}</Button>
</section>

<ConfirmDialog open={confirmingProtection} title={t(M['ui.work_profiles.protection_confirm'])} message={t(M['ui.work_profiles.protection_risk'])} confirmLabel={t(M['ui.work_profiles.protection_off'])} cancelLabel={t(M['ui.work_profiles.cancel'])} destructive oncancel={() => { confirmingProtection = false; }} onconfirm={() => { confirmingProtection = false; confirmedProtection = true; protectionChecked = false; drafts = { ...drafts, safety: { ...drafts.safety, protectLocalCli: false } }; }} />

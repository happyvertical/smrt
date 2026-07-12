<script lang="ts">
import { useI18n } from '@happyvertical/smrt-ui/i18n';
import { M } from '../i18n.js';

export interface DevelopmentRequestSubmission {
  type: string;
  description: string;
  evidence: Array<{ url: string; label?: string }>;
  visibility: 'requester' | 'workspace' | 'public';
  origin: string;
  discussion: string;
}
export interface Props {
  onsubmit: (request: DevelopmentRequestSubmission) => void | Promise<void>;
  disabled?: boolean;
}
let { onsubmit, disabled = false }: Props = $props();
const { t } = useI18n();
let type = $state('feature');
let description = $state('');
let discussion = $state('');
let evidenceUrl = $state('');

function submit(event: SubmitEvent) {
  event.preventDefault();
  if (!description.trim()) return;
  void onsubmit({
    type,
    description: description.trim(),
    evidence: evidenceUrl.trim() ? [{ url: evidenceUrl.trim() }] : [],
    visibility: 'requester',
    origin: 'managed-app',
    discussion: discussion.trim(),
  });
}
</script>

<!-- raw-primitive-allow: provider-free embeddable request form boundary -->
<form onsubmit={submit} class="request-form">
  <label>{t(M['projects.development_request.type'])}
    <!-- raw-primitive-allow: package has no provider-free select primitive -->
    <select bind:value={type} disabled={disabled}>
      <option value="feature">{t(M['projects.development_request.feature'])}</option>
      <option value="bug">{t(M['projects.development_request.bug'])}</option>
      <option value="support">{t(M['projects.development_request.support'])}</option>
    </select>
  </label>
  <label>{t(M['projects.development_request.description'])}
    <!-- raw-primitive-allow: reusable embeddable form keeps native controls -->
    <textarea bind:value={description} required disabled={disabled}></textarea>
  </label>
  <label>{t(M['projects.development_request.evidence_url'])}
    <!-- raw-primitive-allow: URL input has no provider-free primitive -->
    <input type="url" bind:value={evidenceUrl} disabled={disabled} />
  </label>
  <label>{t(M['projects.development_request.discussion'])}
    <!-- raw-primitive-allow: reusable embeddable form keeps native controls -->
    <textarea bind:value={discussion} disabled={disabled}></textarea>
  </label>
  <!-- raw-primitive-allow: submit button is required in provider-free package surface -->
  <button type="submit" disabled={disabled || !description.trim()}>{t(M['projects.development_request.submit'])}</button>
</form>

<style>
  .request-form { display: grid; gap: var(--smrt-spacing-4); }
  label { display: grid; gap: var(--smrt-spacing-1); color: var(--smrt-color-on-surface); }
  input, select, textarea { padding: var(--smrt-spacing-2); border: 1px solid var(--smrt-color-outline); border-radius: var(--smrt-radius-medium); background: var(--smrt-color-surface); color: var(--smrt-color-on-surface); }
  textarea { min-height: 6rem; }
  button { padding: var(--smrt-spacing-2) var(--smrt-spacing-4); border: 0; border-radius: var(--smrt-radius-medium); background: var(--smrt-color-primary); color: var(--smrt-color-on-primary); }
</style>

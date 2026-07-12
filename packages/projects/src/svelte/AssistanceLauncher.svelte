<script lang="ts">
import { Form, Input, Textarea } from '@happyvertical/smrt-ui/forms';
import { useI18n } from '@happyvertical/smrt-ui/i18n';
import { Button } from '@happyvertical/smrt-ui/ui';
import type {
  DevelopmentRequestEvidence,
  ManagedAssistanceRequestInput,
} from '../types.js';
import { M } from './i18n.js';

export interface Props {
  requesterId: string;
  applicationContext?: Record<string, unknown>;
  evidence?: DevelopmentRequestEvidence[];
  disabled?: boolean;
  onsubmit?: (value: ManagedAssistanceRequestInput) => void | Promise<void>;
}

let {
  requesterId,
  applicationContext = {},
  evidence = [],
  disabled = false,
  onsubmit,
}: Props = $props();
const { t } = useI18n();
let subject = $state('');
let message = $state('');

async function submit(event: SubmitEvent) {
  event.preventDefault();
  if (!onsubmit || !subject.trim() || !message.trim()) return;
  await onsubmit({
    requesterId,
    subject: subject.trim(),
    applicationContext,
    conversation: [{ body: message.trim() }],
    evidence,
  });
  subject = '';
  message = '';
}
</script>

<section class="assistance">
  <Form onsubmit={submit}>
    <header>
      <h2>{t(M['projects.assistance.title'])}</h2>
      <p>{t(M['projects.assistance.description'])}</p>
    </header>
    <label>
      {t(M['projects.assistance.subject'])}
      <Input bind:value={subject} required />
    </label>
    <label>
      {t(M['projects.assistance.need'])}
      <Textarea bind:value={message} rows={4} required></Textarea>
    </label>
    <footer>
      <Button type="submit" {disabled}>
        {t(M['projects.assistance.submit'])}
      </Button>
    </footer>
  </Form>
</section>

<style>
  .assistance {
    max-width: 42rem;
  }
  .assistance :global(form) {
    display: grid;
    gap: var(--smrt-spacing-4);
  }
  .assistance header {
    border-bottom: 1px solid var(--smrt-color-outline-variant);
    padding-bottom: var(--smrt-spacing-3);
  }
  .assistance h2,
  .assistance p {
    margin: 0;
  }
  .assistance p {
    color: var(--smrt-color-on-surface-variant);
    margin-top: var(--smrt-spacing-1);
  }
  .assistance label {
    display: grid;
    font-weight: 600;
    gap: var(--smrt-spacing-1);
  }
  .assistance footer {
    display: flex;
    justify-content: flex-end;
  }
</style>

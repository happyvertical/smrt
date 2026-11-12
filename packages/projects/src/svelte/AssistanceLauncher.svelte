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
  /** Identifier of the user submitting the assistance request. */
  requesterId: string;
  /** Additional context data about the application. */
  applicationContext?: Record<string, unknown>;
  /** Evidence supporting the assistance request. */
  evidence?: DevelopmentRequestEvidence[];
  /** Blocks interaction with the form controls. */
  disabled?: boolean;
  /** Invoked when the user submits the form. */
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
  if (disabled || !onsubmit || !subject.trim() || !message.trim()) return;
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

<section class="smrt-assistance-launcher__root" data-smrt-component="AssistanceLauncher">
  <Form onsubmit={submit}>
    <header>
      <h2>{t(M['projects.assistance.title'])}</h2>
      <p>{t(M['projects.assistance.description'])}</p>
    </header>
    <label>
      {t(M['projects.assistance.subject'])}
      <Input bind:value={subject} required {disabled} />
    </label>
    <label>
      {t(M['projects.assistance.need'])}
      <Textarea bind:value={message} rows={4} required {disabled}></Textarea>
    </label>
    <footer>
      <Button type="submit" {disabled}>
        {t(M['projects.assistance.submit'])}
      </Button>
    </footer>
  </Form>
</section>

<style>
@layer smrt.reset, smrt.structure, smrt.theme;
@layer smrt.structure {
  .smrt-assistance-launcher__root {
    max-width: 42rem;
  }
  .smrt-assistance-launcher__root :global(form) {
    display: grid;
    gap: var(--smrt-spacing-4);
  }
  .smrt-assistance-launcher__root header {
    padding-bottom: var(--smrt-spacing-3);
  }
  .smrt-assistance-launcher__root h2,
  .smrt-assistance-launcher__root p {
    margin: 0;
  }
  .smrt-assistance-launcher__root p {
    margin-top: var(--smrt-spacing-1);
  }
  .smrt-assistance-launcher__root label {
    display: grid;
    gap: var(--smrt-spacing-1);
  }
  .smrt-assistance-launcher__root footer {
    display: flex;
    justify-content: flex-end;
  }
}

@layer smrt.theme {
  .smrt-assistance-launcher__root header {
    border-bottom: var(--smrt-hairline);
  }
  .smrt-assistance-launcher__root p {
    color: var(--smrt-color-on-surface-variant);
  }
  .smrt-assistance-launcher__root label {
    font-weight: 600;
  }
}

</style>

<script lang="ts">
/**
 * RoomCreateDialog - Modal dialog for creating a new chat room
 * Provides name, type selector, and description fields.
 *
 * Built on the shared smrt-ui `Modal` (T2 #1391) so it inherits a focus trap,
 * Escape handling, scrim, and focus-restore-to-trigger on close — the
 * hand-rolled backdrop it replaced had none of those.
 */
import { Modal } from '@happyvertical/smrt-ui/feedback';
import { Form, Input, Textarea } from '@happyvertical/smrt-ui/forms';
import { useI18n } from '@happyvertical/smrt-ui/i18n';
import { Button } from '@happyvertical/smrt-ui/ui';
import { M } from '../../i18n.js';

const { t } = useI18n();

export interface Props {
  /** Whether the dialog is open */
  isOpen: boolean;
  /** Callback to close the dialog */
  onclose: () => void;
  /** Callback when room is created */
  oncreate: (params: {
    name: string;
    roomType: string;
    description: string;
  }) => void;
}

let { isOpen, onclose, oncreate }: Props = $props();

let name = $state('');
let roomType = $state('public');
let description = $state('');

const canCreate = $derived(name.trim().length > 0);

const roomTypes = [
  {
    value: 'public',
    label: 'Public Channel',
    description: 'Anyone can join and view messages',
  },
  {
    value: 'private',
    label: 'Private Channel',
    description: 'Invite-only, hidden from non-members',
  },
  {
    value: 'dm',
    label: 'Direct Message',
    description: 'Private conversation between users',
  },
  {
    value: 'agent',
    label: 'Agent',
    description: 'Conversation with an AI agent',
  },
];

function handleSubmit() {
  if (!canCreate) return;
  oncreate({
    name: name.trim(),
    roomType,
    description: description.trim(),
  });
  resetForm();
}

function handleClose() {
  resetForm();
  onclose();
}

function resetForm() {
  name = '';
  roomType = 'public';
  description = '';
}

// Modal traps focus and moves it to the dialog itself; nudge initial focus to
// the name field once the dialog is open and the input is mounted. The Input
// primitive doesn't expose its inner element, so resolve it by id.
$effect(() => {
  if (isOpen && typeof document !== 'undefined') {
    // Defer a frame so the Modal body (and the name input) is mounted first.
    const raf = requestAnimationFrame(() => {
      document.getElementById('room-name')?.focus();
    });
    return () => cancelAnimationFrame(raf);
  }
});
</script>

<Modal
  open={isOpen}
  onClose={handleClose}
  title={t(M['chat.room_create_dialog.title'])}
  size="md"
  ariaLabel={t(M['chat.room_create_dialog.title'])}
>
  <Form
    class="smrt-room-create-dialog__form"
    onsubmit={(e) => { e.preventDefault(); handleSubmit(); }}
  >
    <div class="smrt-room-create-dialog__field" data-smrt-part="field">
      <label class="smrt-room-create-dialog__label" data-smrt-part="label" for="room-name">
        {t(M['chat.room_create_dialog.room_name'])} <span class="smrt-room-create-dialog__required" data-smrt-part="marker" aria-label={t(M['chat.room_create_dialog.required'])}>*</span>
      </label>
      <Input
        bind:value={name}
        id="room-name"
        type="text"
        placeholder={t(M['chat.room_create_dialog.name_placeholder'])}
        maxlength={100}
        autocomplete="off"
      />
    </div>

    <fieldset class="smrt-room-create-dialog__field" data-smrt-part="field">
      <legend class="smrt-room-create-dialog__label" data-smrt-part="label">{t(M['chat.room_create_dialog.room_type'])}</legend>
      <div class="smrt-room-create-dialog__type-options" data-smrt-part="list">
        {#each roomTypes as option (option.value)}
          <label
            class="smrt-room-create-dialog__type-option"
            data-smrt-part="option"
          
  class:smrt-room-create-dialog__type-option--selected={roomType === option.value}
>
            <!-- raw-primitive-allow: native radio for single-choice room-type selection; no Provider-free radio primitive (Toggle is a switch with different semantics, CheckboxInput requires a Provider) -->
            <input
              type="radio"
              name="roomType"
              value={option.value}
              bind:group={roomType}
              class="smrt-room-create-dialog__radio"
              data-smrt-part="input"
            />
            <span class="smrt-room-create-dialog__option-body" data-smrt-part="body">
              <span class="smrt-room-create-dialog__option-label" data-smrt-part="label">{option.label}</span>
              <span class="smrt-room-create-dialog__option-description" data-smrt-part="description">{option.description}</span>
            </span>
          </label>
        {/each}
      </div>
    </fieldset>

    <div class="smrt-room-create-dialog__field" data-smrt-part="field">
      <label class="smrt-room-create-dialog__label" data-smrt-part="label" for="room-description">Description</label>
      <Textarea
        bind:value={description}
        id="room-description"
        placeholder={t(M['chat.room_create_dialog.description_placeholder'])}
        rows={3}
        maxlength={500}
      />
      <span class="smrt-room-create-dialog__hint" data-smrt-part="description">{description.length}/500</span>
    </div>

    <!-- Hidden submit keeps Enter-to-submit working inside the Modal body. -->
    <!-- raw-primitive-allow: off-screen aria-hidden type=submit element with tabindex=-1 used only to enable native Enter-to-submit inside the Modal body; intentionally non-interactive and not a visible action button -->
    <button type="submit" class="smrt-room-create-dialog__visually-hidden" data-smrt-part="submit" tabindex="-1" disabled={!canCreate} aria-hidden="true"></button>
  </Form>

  {#snippet footer()}
    <Button
      variant="secondary"
      type="button"
      onclick={handleClose}
    >
      Cancel
    </Button>
    <Button
      variant="primary"
      type="button"
      disabled={!canCreate}
      onclick={handleSubmit}
    >
      {t(M['chat.room_create_dialog.create_room'])}
    </Button>
  {/snippet}
</Modal>

<style>
@layer smrt.reset, smrt.structure, smrt.theme;
@layer smrt.structure {
  /* :global() targets the Form primitive's rendered <form> (see #1589 scoping trap). */
  :global(.smrt-room-create-dialog__form) {
    display: flex;
    flex-direction: column;
    gap: 1.25rem;
  }
  .smrt-room-create-dialog__visually-hidden {
    position: absolute;
    width: 1px;
    height: 1px;
    padding: 0;
    margin: -1px;
    overflow: hidden;
    clip: rect(0, 0, 0, 0);
    white-space: nowrap;
  }
  .smrt-room-create-dialog__field {
    display: flex;
    flex-direction: column;
    gap: 0.375rem;
    margin: 0;
    padding: 0;
  }
  .smrt-room-create-dialog__type-options {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }
  .smrt-room-create-dialog__type-option {
    display: flex;
    align-items: flex-start;
    gap: 0.75rem;
    padding: 0.75rem;
    cursor: pointer;
  }
  .smrt-room-create-dialog__radio {
    margin-top: 0.125rem;
  }
  .smrt-room-create-dialog__option-body {
    display: flex;
    flex-direction: column;
    gap: 0.125rem;
  }
}

@layer smrt.theme {
  .smrt-room-create-dialog__visually-hidden {
    border: 0;
  }
  .smrt-room-create-dialog__field {
    border: none;
  }
  .smrt-room-create-dialog__label {
    font: var(--smrt-typography-label-large-font, 500 0.875rem / 1.25 sans-serif);
    color: var(--smrt-color-on-surface);
  }
  .smrt-room-create-dialog__required {
    color: var(--smrt-color-error);
  }
  .smrt-room-create-dialog__hint {
    font: var(--smrt-typography-body-small-font, 0.75rem / 1.25 sans-serif);
    color: var(--smrt-color-on-surface-variant);
    text-align: right;
  }
  .smrt-room-create-dialog__type-option {
    border: var(--smrt-hairline);
    border-radius: var(--smrt-radius-medium, 0.5rem);
    transition: border-color var(--smrt-duration-short2, 150ms),
      background var(--smrt-duration-short2, 150ms);
  }
  .smrt-room-create-dialog__type-option:hover {
    background: var(--smrt-color-surface-container);
  }
  .smrt-room-create-dialog__type-option--selected {
    border-color: var(--smrt-color-primary);
    background: var(--smrt-color-primary-container);
  }
  .smrt-room-create-dialog__radio {
    accent-color: var(--smrt-color-primary);
  }
  .smrt-room-create-dialog__option-label {
    font: var(--smrt-typography-body-medium-font, 0.875rem / 1.25 sans-serif);
    color: var(--smrt-color-on-surface);
    font-weight: var(--smrt-typography-weight-medium, 500);
  }
  .smrt-room-create-dialog__option-description {
    font: var(--smrt-typography-body-small-font, 0.75rem / 1.25 sans-serif);
    color: var(--smrt-color-on-surface-variant);
  }
  @media (prefers-reduced-motion: reduce) {
    .smrt-room-create-dialog__type-option {
      transition: none;
    }
  }
}

</style>

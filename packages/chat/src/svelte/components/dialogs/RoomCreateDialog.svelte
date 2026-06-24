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
let nameInput = $state<HTMLInputElement | null>(null);

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
// the name field once the dialog is open and the input is mounted.
$effect(() => {
  if (isOpen && nameInput) {
    nameInput.focus();
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
  <form
    class="dialog__form"
    onsubmit={(e) => { e.preventDefault(); handleSubmit(); }}
  >
    <div class="field">
      <label class="field__label" for="room-name">
        {t(M['chat.room_create_dialog.room_name'])} <span class="field__required" aria-label={t(M['chat.room_create_dialog.required'])}>*</span>
      </label>
      <input
        bind:this={nameInput}
        bind:value={name}
        id="room-name"
        type="text"
        class="field__input"
        placeholder={t(M['chat.room_create_dialog.name_placeholder'])}
        maxlength="100"
        autocomplete="off"
      />
    </div>

    <fieldset class="field">
      <legend class="field__label">{t(M['chat.room_create_dialog.room_type'])}</legend>
      <div class="type-options">
        {#each roomTypes as option (option.value)}
          <label
            class="type-option"
            class:type-option--selected={roomType === option.value}
          >
            <input
              type="radio"
              name="roomType"
              value={option.value}
              bind:group={roomType}
              class="type-option__radio"
            />
            <span class="type-option__content">
              <span class="type-option__label">{option.label}</span>
              <span class="type-option__description">{option.description}</span>
            </span>
          </label>
        {/each}
      </div>
    </fieldset>

    <div class="field">
      <label class="field__label" for="room-description">Description</label>
      <textarea
        bind:value={description}
        id="room-description"
        class="field__textarea"
        placeholder={t(M['chat.room_create_dialog.description_placeholder'])}
        rows="3"
        maxlength="500"
      ></textarea>
      <span class="field__hint">{description.length}/500</span>
    </div>

    <!-- Hidden submit keeps Enter-to-submit working inside the Modal body. -->
    <!-- raw-primitive-allow: off-screen aria-hidden type=submit element with tabindex=-1 used only to enable native Enter-to-submit inside the Modal body; intentionally non-interactive and not a visible action button -->
    <button type="submit" class="visually-hidden" tabindex="-1" disabled={!canCreate} aria-hidden="true"></button>
  </form>

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
  .dialog__form {
    display: flex;
    flex-direction: column;
    gap: 1.25rem;
  }

  .visually-hidden {
    position: absolute;
    width: 1px;
    height: 1px;
    padding: 0;
    margin: -1px;
    overflow: hidden;
    clip: rect(0, 0, 0, 0);
    white-space: nowrap;
    border: 0;
  }

  .field {
    display: flex;
    flex-direction: column;
    gap: 0.375rem;
    border: none;
    margin: 0;
    padding: 0;
  }

  .field__label {
    font: var(--smrt-typography-label-large-font, 500 0.875rem / 1.25 sans-serif);
    color: var(--smrt-color-on-surface, #1a1c1e);
  }

  .field__required {
    color: var(--smrt-color-error, #b3261e);
  }

  .field__input {
    padding: 0.75rem;
    font: var(--smrt-typography-body-large-font, 1rem / 1.5 sans-serif);
    font-family: inherit;
    border: 1px solid var(--smrt-color-outline, #74777f);
    border-radius: var(--smrt-radius-medium, 0.5rem);
    background: var(--smrt-color-surface, #fefbff);
    color: var(--smrt-color-on-surface, #1a1c1e);
  }

  .field__input:focus {
    outline: none;
    border-color: var(--smrt-color-primary, #005ac1);
    box-shadow: 0 0 0 1px var(--smrt-color-primary, #005ac1);
  }

  .field__textarea {
    padding: 0.75rem;
    font: var(--smrt-typography-body-large-font, 1rem / 1.5 sans-serif);
    font-family: inherit;
    border: 1px solid var(--smrt-color-outline, #74777f);
    border-radius: var(--smrt-radius-medium, 0.5rem);
    background: var(--smrt-color-surface, #fefbff);
    color: var(--smrt-color-on-surface, #1a1c1e);
    resize: vertical;
    min-height: 80px;
  }

  .field__textarea:focus {
    outline: none;
    border-color: var(--smrt-color-primary, #005ac1);
    box-shadow: 0 0 0 1px var(--smrt-color-primary, #005ac1);
  }

  .field__hint {
    font: var(--smrt-typography-body-small-font, 0.75rem / 1.25 sans-serif);
    color: var(--smrt-color-on-surface-variant, #43474e);
    text-align: right;
  }

  .type-options {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }

  .type-option {
    display: flex;
    align-items: flex-start;
    gap: 0.75rem;
    padding: 0.75rem;
    border: 1px solid var(--smrt-color-outline-variant, #c4c6d0);
    border-radius: var(--smrt-radius-medium, 0.5rem);
    cursor: pointer;
    transition: border-color var(--smrt-duration-short2, 150ms),
      background var(--smrt-duration-short2, 150ms);
  }

  .type-option:hover {
    background: var(--smrt-color-surface-container, #f0f0f4);
  }

  .type-option--selected {
    border-color: var(--smrt-color-primary, #005ac1);
    background: var(--smrt-color-primary-container, #d6e3ff);
  }

  .type-option__radio {
    margin-top: 0.125rem;
    accent-color: var(--smrt-color-primary, #005ac1);
  }

  .type-option__content {
    display: flex;
    flex-direction: column;
    gap: 0.125rem;
  }

  .type-option__label {
    font: var(--smrt-typography-body-medium-font, 0.875rem / 1.25 sans-serif);
    color: var(--smrt-color-on-surface, #1a1c1e);
    font-weight: var(--smrt-typography-weight-medium, 500);
  }

  .type-option__description {
    font: var(--smrt-typography-body-small-font, 0.75rem / 1.25 sans-serif);
    color: var(--smrt-color-on-surface-variant, #43474e);
  }

  @media (prefers-reduced-motion: reduce) {
    .type-option {
      transition: none;
    }
  }
</style>

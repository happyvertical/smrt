<script lang="ts">
/**
 * RoomCreateDialog - Modal dialog for creating a new chat room
 * Provides name, type selector, and description fields
 */

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

function handleKeydown(event: KeyboardEvent) {
  if (event.key === 'Escape') {
    handleClose();
  }
}

$effect(() => {
  if (!isOpen || typeof window === 'undefined') {
    return;
  }

  const onWindowKeydown = (event: KeyboardEvent) => {
    handleKeydown(event);
  };

  window.addEventListener('keydown', onWindowKeydown);
  return () => {
    window.removeEventListener('keydown', onWindowKeydown);
  };
});

$effect(() => {
  if (isOpen && nameInput) {
    nameInput.focus();
  }
});
</script>

{#if isOpen}
  <div class="dialog-backdrop">
    <button
      type="button"
      class="dialog-backdrop__dismiss"
      tabindex="-1"
      aria-label="Close room creation dialog"
      onclick={handleClose}
    ></button>
    <div
      class="dialog"
      role="dialog"
      aria-modal="true"
      aria-labelledby="create-room-title"
      tabindex="-1"
    >
      <h2 id="create-room-title" class="dialog__title">Create a Room</h2>

      <form
        class="dialog__form"
        onsubmit={(e) => { e.preventDefault(); handleSubmit(); }}
      >
        <div class="field">
          <label class="field__label" for="room-name">
            Room Name <span class="field__required" aria-label="required">*</span>
          </label>
          <input
            bind:this={nameInput}
            bind:value={name}
            id="room-name"
            type="text"
            class="field__input"
            placeholder="e.g. general, project-updates"
            maxlength="100"
            autocomplete="off"
          />
        </div>

        <fieldset class="field">
          <legend class="field__label">Room Type</legend>
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
            placeholder="What is this room about?"
            rows="3"
            maxlength="500"
          ></textarea>
          <span class="field__hint">{description.length}/500</span>
        </div>

        <div class="dialog__actions">
          <button
            type="button"
            class="btn btn--secondary"
            onclick={handleClose}
          >
            Cancel
          </button>
          <button
            type="submit"
            class="btn btn--primary"
            disabled={!canCreate}
          >
            Create Room
          </button>
        </div>
      </form>
    </div>
  </div>
{/if}

<style>
  .dialog-backdrop {
    position: fixed;
    inset: 0;
    background: color-mix(in srgb, var(--smrt-color-scrim) 32%, transparent);
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 1rem;
    z-index: 1000;
    position: relative;
  }

  .dialog-backdrop__dismiss {
    position: absolute;
    inset: 0;
    padding: 0;
    border: 0;
    background: transparent;
  }

  .dialog {
    background: var(--smrt-color-surface, #fefbff);
    border-radius: var(--smrt-radius-extra-large, 28px);
    box-shadow: var(--smrt-elevation-level3, 0 4px 8px 3px rgba(0, 0, 0, 0.15), 0 1px 3px rgba(0, 0, 0, 0.3));
    width: 100%;
    max-width: 32rem;
    padding: 1.5rem;
    max-height: calc(100vh - 2rem);
    overflow-y: auto;
    position: relative;
    z-index: 1;
  }

  .dialog__title {
    margin: 0 0 1.25rem;
    font: var(--smrt-typography-headline-small-font, 400 1.5rem / 2rem sans-serif);
    color: var(--smrt-color-on-surface, #1a1c1e);
  }

  .dialog__form {
    display: flex;
    flex-direction: column;
    gap: 1.25rem;
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
    color: var(--smrt-color-error, #ba1a1a);
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
    font-weight: 500;
  }

  .type-option__description {
    font: var(--smrt-typography-body-small-font, 0.75rem / 1.25 sans-serif);
    color: var(--smrt-color-on-surface-variant, #43474e);
  }

  .dialog__actions {
    display: flex;
    justify-content: flex-end;
    gap: 0.5rem;
    margin-top: 0.25rem;
  }

  .btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    padding: 0.625rem 1.5rem;
    font: var(--smrt-typography-label-large-font, 500 0.875rem / 1.25 sans-serif);
    letter-spacing: 0.1px;
    border-radius: var(--smrt-radius-full, 9999px);
    border: none;
    cursor: pointer;
    transition: all var(--smrt-duration-short2, 150ms) var(--smrt-easing-standard, ease);
  }

  .btn:disabled {
    opacity: 0.38;
    cursor: not-allowed;
  }

  .btn--primary {
    background: var(--smrt-color-primary, #005ac1);
    color: var(--smrt-color-on-primary, #fff);
  }

  .btn--primary:hover:not(:disabled) {
    box-shadow: var(--smrt-elevation-level1, 0 1px 2px rgba(0, 0, 0, 0.3), 0 1px 3px 1px rgba(0, 0, 0, 0.15));
  }

  .btn--secondary {
    background: transparent;
    color: var(--smrt-color-primary, #005ac1);
  }

  .btn--secondary:hover:not(:disabled) {
    background: color-mix(in srgb, var(--smrt-color-primary, #005ac1) 8%, transparent);
  }

  @media (prefers-reduced-motion: reduce) {
    .type-option,
    .btn {
      transition: none;
    }
  }
</style>

<script lang="ts">
/**
 * ReferralLinkManager — referrer-portal share link manager (#1931).
 *
 * Lists a referrer's share links (label, code, share URL, clicks, status) and
 * offers a create form plus per-link enable/disable. The share URL is built
 * from the host-provided `shareBaseUrl`; creation and status changes are
 * delegated to callbacks.
 */
import { Form, FormGroup, Input } from '@happyvertical/smrt-ui/forms';
import { Badge, Button } from '@happyvertical/smrt-ui/ui';
import type { CreateReferralLinkDraft, ReferralLinkView } from '../types.js';
import {
  buildShareUrl,
  isHttpUrl,
  referralLinkStatusBadgeVariant,
} from '../types.js';

export interface Props {
  /** The referrer's links. */
  links?: ReferralLinkView[];
  /** Base URL share links are served from (e.g. `https://example.com/r`). */
  shareBaseUrl?: string;
  /** Disable actions while a mutation is in flight. */
  busy?: boolean;
  /** Create a new share link. */
  onCreate?: (draft: CreateReferralLinkDraft) => void;
  /** Enable or disable an existing link. */
  onSetEnabled?: (linkId: string, enabled: boolean) => void;
}

let {
  links = [],
  shareBaseUrl = '',
  busy = false,
  onCreate,
  onSetEnabled,
}: Props = $props();

let draftTargetUrl = $state('');
let draftLabel = $state('');

const canCreate = $derived(isHttpUrl(draftTargetUrl));

function submitCreate() {
  if (!canCreate) return;
  const label = draftLabel.trim();
  onCreate?.({
    targetUrl: draftTargetUrl.trim(),
    label: label === '' ? undefined : label,
  });
  draftTargetUrl = '';
  draftLabel = '';
}
</script>

<div class="sales-referral-links">
  {#if onCreate}
    <Form class="sales-referral-links-create" onsubmit={submitCreate}>
      <FormGroup
        label="Destination URL"
        required
        hint="Where the share link should send visitors (must be http/https)."
      >
        <Input
          type="url"
          value={draftTargetUrl}
          disabled={busy}
          required
          oninput={(event) => {
            draftTargetUrl = (event.currentTarget as HTMLInputElement).value;
          }}
        />
      </FormGroup>
      <FormGroup label="Label" hint="Optional name for this link.">
        <Input
          value={draftLabel}
          disabled={busy}
          oninput={(event) => {
            draftLabel = (event.currentTarget as HTMLInputElement).value;
          }}
        />
      </FormGroup>
      <Button type="submit" variant="primary" size="sm" disabled={busy || !canCreate}>
        Create link
      </Button>
    </Form>
  {/if}

  {#if links.length === 0}
    <p class="empty">No share links yet.</p>
  {:else}
    <table>
      <thead>
        <tr>
          <th scope="col">Label</th>
          <th scope="col">Code</th>
          <th scope="col">Share URL</th>
          <th scope="col">Clicks</th>
          <th scope="col">Status</th>
          <th scope="col"><span class="visually-hidden">Actions</span></th>
        </tr>
      </thead>
      <tbody>
        {#each links as link (link.id)}
          <tr>
            <td>{link.label ?? '—'}</td>
            <td><code>{link.code}</code></td>
            <td class="share-url">
              {#if shareBaseUrl}
                <code>{buildShareUrl(shareBaseUrl, link.code)}</code>
              {:else}
                —
              {/if}
            </td>
            <td class="clicks">{link.clickCount}</td>
            <td>
              <Badge variant={referralLinkStatusBadgeVariant(link.status)} size="sm">
                {link.status}
              </Badge>
            </td>
            <td class="actions">
              {#if onSetEnabled}
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={busy}
                  onclick={() => onSetEnabled?.(link.id, link.status !== 'active')}
                >
                  {link.status === 'active' ? 'Disable' : 'Enable'}
                </Button>
              {/if}
            </td>
          </tr>
        {/each}
      </tbody>
    </table>
  {/if}
</div>

<style>
  .sales-referral-links {
    display: flex;
    flex-direction: column;
    gap: var(--smrt-spacing-4, 1rem);
    width: 100%;
    overflow-x: auto;
  }

  .sales-referral-links :global(.sales-referral-links-create) {
    display: flex;
    flex-wrap: wrap;
    align-items: flex-end;
    gap: var(--smrt-spacing-2, 0.5rem);
  }

  .sales-referral-links :global(.sales-referral-links-create .form-group) {
    margin-bottom: 0;
    flex: 1 1 14rem;
  }

  .empty {
    margin: 0;
    color: var(--smrt-color-on-surface-variant, #64748b);
    font-style: italic;
  }

  table {
    width: 100%;
    border-collapse: collapse;
    font-size: var(--smrt-typography-body-medium-size, 0.875rem);
  }

  th {
    padding: var(--smrt-spacing-2, 0.5rem) var(--smrt-spacing-3, 0.75rem);
    text-align: left;
    font-weight: var(--smrt-typography-weight-semibold, 600);
    background: var(--smrt-color-surface-container, #f3f4f6);
    border-bottom: 1px solid var(--smrt-color-outline-variant, #d8dde6);
    white-space: nowrap;
  }

  td {
    padding: var(--smrt-spacing-2, 0.5rem) var(--smrt-spacing-3, 0.75rem);
    border-bottom: 1px solid var(--smrt-color-outline-variant, #d8dde6);
    vertical-align: middle;
  }

  code {
    font-family: var(--smrt-font-family-mono, ui-monospace, monospace);
    font-size: var(--smrt-typography-body-small-size, 0.8125rem);
  }

  .share-url {
    word-break: break-all;
  }

  .clicks {
    text-align: right;
    font-family: var(--smrt-font-family-mono, ui-monospace, monospace);
  }

  .actions {
    white-space: nowrap;
    text-align: right;
  }

  .visually-hidden {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip: rect(0 0 0 0);
    white-space: nowrap;
  }
</style>

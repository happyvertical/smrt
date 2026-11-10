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

<div class="smrt-referral-link-manager__root" data-smrt-component="ReferralLinkManager">
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
    <p class="smrt-referral-link-manager__empty" data-smrt-part="empty">No share links yet.</p>
  {:else}
    <table>
      <thead data-smrt-part="header">
        <tr>
          <th scope="col">Label</th>
          <th scope="col">Code</th>
          <th scope="col">Share URL</th>
          <th scope="col">Clicks</th>
          <th scope="col">Status</th>
          <th scope="col"><span class="smrt-referral-link-manager__visually-hidden" data-smrt-part="label">Actions</span></th>
        </tr>
      </thead>
      <tbody data-smrt-part="body">
        {#each links as link (link.id)}
          <tr data-smrt-part="row">
            <td>{link.label ?? '—'}</td>
            <td><code>{link.code}</code></td>
            <td class="smrt-referral-link-manager__share-url" data-smrt-part="share-url">
              {#if shareBaseUrl}
                <code>{buildShareUrl(shareBaseUrl, link.code)}</code>
              {:else}
                —
              {/if}
            </td>
            <td class="smrt-referral-link-manager__clicks">{link.clickCount}</td>
            <td>
              <Badge variant={referralLinkStatusBadgeVariant(link.status)} size="sm">
                {link.status}
              </Badge>
            </td>
            <td class="smrt-referral-link-manager__actions" data-smrt-part="actions">
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
@layer smrt.reset, smrt.structure, smrt.theme;
@layer smrt.structure {
  .smrt-referral-link-manager__root {
    display: flex;
    flex-direction: column;
    gap: var(--smrt-spacing-4, 1rem);
    width: 100%;
    overflow-x: auto;
  }
  .smrt-referral-link-manager__root :global(.sales-referral-links-create) {
    display: flex;
    flex-wrap: wrap;
    align-items: flex-end;
    gap: var(--smrt-spacing-2, 0.5rem);
  }
  .smrt-referral-link-manager__root :global(.sales-referral-links-create .form-group) {
    margin-bottom: 0;
    flex: 1 1 14rem;
  }
  .smrt-referral-link-manager__empty {
    margin: 0;
  }
  table {
    width: 100%;
  }
  th {
    padding: var(--smrt-spacing-2, 0.5rem) var(--smrt-spacing-3, 0.75rem);
    white-space: nowrap;
  }
  td {
    padding: var(--smrt-spacing-2, 0.5rem) var(--smrt-spacing-3, 0.75rem);
  }
  .smrt-referral-link-manager__share-url {
    word-break: break-all;
  }
  .smrt-referral-link-manager__actions {
    white-space: nowrap;
  }
  .smrt-referral-link-manager__visually-hidden {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip: rect(0 0 0 0);
    white-space: nowrap;
  }
}

@layer smrt.theme {
  .smrt-referral-link-manager__empty {
    color: var(--smrt-color-on-surface-variant);
    font-style: italic;
  }
  table {
    border-collapse: collapse;
    font-size: var(--smrt-typography-body-medium-size, 0.875rem);
  }
  th {
    text-align: left;
    font-weight: var(--smrt-typography-weight-semibold, 600);
    background: var(--smrt-color-surface-container);
    border-bottom: var(--smrt-hairline);
  }
  td {
    border-bottom: var(--smrt-hairline);
    vertical-align: middle;
  }
  code {
    font-family: var(--smrt-font-family-mono, ui-monospace, monospace);
    font-size: var(--smrt-typography-body-small-size, 0.8125rem);
  }
  .smrt-referral-link-manager__clicks {
    text-align: right;
    font-family: var(--smrt-font-family-mono, ui-monospace, monospace);
  }
  .smrt-referral-link-manager__actions {
    text-align: right;
  }
}

</style>

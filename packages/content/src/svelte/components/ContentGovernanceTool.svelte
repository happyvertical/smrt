<script lang="ts">
import type {
  ContentGovernanceStateData,
  FactAuditStateData,
} from '../../mock-smrt-client';
import ContentClaimAuditTool from './ContentClaimAuditTool.svelte';
import ContentCorrectionsTool from './ContentCorrectionsTool.svelte';
import ContentTransparencyTool from './ContentTransparencyTool.svelte';
import ContentVersionsTool from './ContentVersionsTool.svelte';

export type ContentGovernanceToolSection =
  | 'claimAudit'
  | 'corrections'
  | 'versions'
  | 'transparency';

export interface Props {
  /** The governance tool section to display (claimAudit, corrections, versions, or transparency). */
  section: ContentGovernanceToolSection;
  /** Base URL for API requests to fetch governance data. */
  apiBaseUrl?: string;
  /** Identifier of the content being governed. */
  contentId: string;
  /** Fired when governance state changes (e.g., from transparency tool). */
  onGovernanceStateChange?: (state: ContentGovernanceStateData | null) => void;
  /** Fired when fact audit state changes (e.g., from claim audit tool). */
  onFactAuditChange?: (state: FactAuditStateData | null) => void;
}

let {
  section,
  apiBaseUrl = '/api/v1',
  contentId,
  onGovernanceStateChange = undefined,
  onFactAuditChange = undefined,
}: Props = $props();
</script>

{#if section === 'claimAudit'}
  <ContentClaimAuditTool
    {apiBaseUrl}
    {contentId}
    {onFactAuditChange}
  />
{:else if section === 'corrections'}
  <ContentCorrectionsTool
    {apiBaseUrl}
    {contentId}
  />
{:else if section === 'versions'}
  <ContentVersionsTool
    {apiBaseUrl}
    {contentId}
  />
{:else if section === 'transparency'}
  <ContentTransparencyTool
    {apiBaseUrl}
    {contentId}
    {onGovernanceStateChange}
  />
{/if}

<script lang="ts">
let {
  session = null,
  messages = [],
  currentProfileId = '',
  loading = false,
  onsend = undefined,
  onclose = undefined,
} = $props<{
  session?: unknown;
  messages?: unknown[];
  currentProfileId?: string;
  loading?: boolean;
  onsend?: (content: string) => void;
  onclose?: () => void;
}>();
</script>

<div
  data-testid="agent-chat-stub"
  data-message-count={messages.length}
  data-loading={loading}
  data-profile-id={currentProfileId}
></div>

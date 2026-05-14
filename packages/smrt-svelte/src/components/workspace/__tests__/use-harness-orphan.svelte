<script lang="ts">
/**
 * Orphan consumer — calls useToolsDock with no provider in the ancestor
 * chain. Expected to throw at construction time.
 */
import { useToolsDock } from '../tools-dock/use-tools-dock.js';

useToolsDock();
</script>

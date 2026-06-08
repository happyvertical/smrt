<script lang="ts">
interface Props {
  message?: string;
}

const { message = 'Hello Federation!' }: Props = $props();
</script>

<div class="test-component">
  <h3>Test Component</h3>
  <p>{message}</p>
</div>

<style>
  .test-component {
    padding: 1rem;
    border: 1px solid var(--smrt-color-outline-variant, #ccc);
    border-radius: 4px;
    background: var(--smrt-color-surface-container-low, #f9f9f9);
  }
</style>
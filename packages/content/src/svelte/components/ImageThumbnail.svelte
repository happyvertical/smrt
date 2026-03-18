<script lang="ts">
let { assetId }: { assetId: string } = $props();

let imageUrl: string | null = $state(null);

$effect(() => {
  if (assetId) {
    fetch(`/api/v1/images/${assetId}`)
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (data) {
          imageUrl = data.sourceUri || data.url;
        }
      })
      .catch(() => {});
  }
});
</script>

{#if imageUrl}
  <img src={imageUrl} alt="Thumbnail preview" class="smrt-thumbnail-img" />
{:else}
  <div class="smrt-thumbnail-skeleton"></div>
{/if}

<style>
  .smrt-thumbnail-img {
    width: 100%;
    height: 100%;
    object-fit: cover;
  }
  .smrt-thumbnail-skeleton {
    width: 100%;
    height: 100%;
    background: var(--smrt-color-surface-container-high, #242424);
  }
</style>

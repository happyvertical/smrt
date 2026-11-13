<script lang="ts">
import { CookbookSectionPage } from '@happyvertical/smrt-svelte/cookbook';
import { page } from '$app/state';
</script>

<CookbookSectionPage slug={page.params.slug} />

<script lang="ts">
import Provider from '../../Provider.svelte';
</script>

<Provider webmcp={{ definitions: [], basePath: '/api', effects: ['read'] }}>
  <span data-testid="webmcp-ssr-fixture"></span>
</Provider>

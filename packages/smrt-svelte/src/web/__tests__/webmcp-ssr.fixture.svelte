<script lang="ts">
import { createDataSurfaceRegistry } from '@happyvertical/smrt-ui/data';
import Provider from '../../Provider.svelte';
import Child from './webmcp-composed.child.fixture.svelte';

const dataSurfaceRegistry = createDataSurfaceRegistry();
</script>

<Provider webmcp={{ definitions: [], basePath: '/api', effects: ['read'] }}>
  <div data-testid="webmcp-ssr-fixture">
    <Child {dataSurfaceRegistry} />
  </div>
</Provider>

import { sveltekit } from '@sveltejs/kit/vite';
import { smrt } from '@happyvertical/smrt-core/vite';
import { defineConfig } from 'vite';

// `smrt()` applies the legacy-decorator transform, consumes the manifests of
// the packages listed in `smrt.config.ts` (`consumer.packages`), and generates
// this app's object registration, types, and API routes.
export default defineConfig({
  plugins: [sveltekit(), smrt()],
});

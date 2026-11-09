import { smrt } from '@happyvertical/smrt-core/vite';
import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';

// `smrt()` registers the shell's own models (App, AppVersion, Approval) and
// the packages in smrt.config.ts. The user app's models are not here: they
// live in the app worker (src/engine).
export default defineConfig({
  plugins: [
    sveltekit(),
    smrt({ objectsDir: 'src/lib/models' }),
  ],
  ssr: { external: ['@happyvertical/smrt-app-shell'] },
});

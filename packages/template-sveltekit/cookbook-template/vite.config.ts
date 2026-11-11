import { sveltekit } from '@sveltejs/kit/vite';
import { cookbookHostVite } from '@happyvertical/smrt-template-sveltekit/host/generate';
import { defineConfig, type UserConfig } from 'vite';
export default defineConfig(async (): Promise<UserConfig> => ({ plugins: [...await sveltekit(), ...await cookbookHostVite()] }));

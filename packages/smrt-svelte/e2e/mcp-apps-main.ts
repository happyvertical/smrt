import { mount, unmount } from 'svelte';
import Fixture from './McpAppsFixture.svelte';

const instance = mount(Fixture, { target: document.body });
Object.assign(window, { unmountFixture: () => unmount(instance) });

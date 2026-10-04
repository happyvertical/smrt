import { mount, unmount } from 'svelte';
import Fixture from './McpAppsBridgeFixture.svelte';

const instance = mount(Fixture, { target: document.body });
Object.assign(window, { unmountFixture: () => unmount(instance) });

import { mount } from 'svelte';
import Table from '../src/components/data/__tests__/responsive-table.fixture.svelte';
import Segments from '../src/components/forms/__tests__/segmented-posting.fixture.svelte';
import Density from '../src/components/forms/__tests__/touch-density.fixture.svelte';

const target = document.getElementById('app')!;
const params = new URLSearchParams(location.search);
switch (params.get('surface')) {
  case 'table':
    mount(Table, {
      target,
      props: {
        mode: params.get('mode') === 'scroll' ? 'scroll' : 'hide-columns',
      },
    });
    break;
  case 'segments':
    mount(Segments, {
      target,
      props: {
        required: true,
        initial: params.get('initial') ?? 'one',
        named: !params.has('nameless'),
        outerDisabled: params.has('outerDisabled'),
      },
    });
    break;
  default:
    mount(Density, {
      target,
      props: {
        density:
          params.get('density') === 'comfortable' ? 'comfortable' : 'touch',
        target: params.get('target') ?? '48px',
      },
    });
}

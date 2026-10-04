import { mount } from 'svelte';

const target = document.getElementById('app')!;
const params = new URLSearchParams(location.search);
switch (params.get('surface')) {
  case 'table': {
    const { default: Table } = await import(
      '../src/components/data/__tests__/responsive-table.fixture.svelte',
    );
    mount(Table, {
      target,
      props: {
        mode: params.get('mode') === 'scroll' ? 'scroll' : 'hide-columns',
      },
    });
    break;
  }
  case 'segments': {
    const { default: Segments } = await import(
      '../src/components/forms/__tests__/segmented-posting.fixture.svelte',
    );
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
  }
  case 'capture': {
    // No camera API, so CameraCapture renders its opt-in file-input picker,
    // which shares the `.action` sizing rule with the live-camera buttons.
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: undefined,
    });
    const { default: Capture } = await import(
      '../src/components/forms/__tests__/capture-touch.fixture.svelte'
    );
    mount(Capture, {
      target,
      props: {
        density: params.get('density') === 'touch' ? 'touch' : 'comfortable',
        target: params.get('target') ?? '48px',
      },
    });
    break;
  }
  case 'choices': {
    const { default: Choices } = await import('./choice-posting.svelte');
    mount(Choices, { target });
    break;
  }
  default: {
    const { default: Density } = await import(
      '../src/components/forms/__tests__/touch-density.fixture.svelte',
    );
    mount(Density, {
      target,
      props: {
        density:
          params.get('density') === 'comfortable' ? 'comfortable' : 'touch',
        target: params.get('target') ?? '48px',
      },
    });
  }
}

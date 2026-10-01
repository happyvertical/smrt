<script lang="ts">
import { useControlRegistration } from '../index.js';

type Place = { name: string; latitude: number; longitude: number };
interface Props {
  value: Place | null;
}
let { value = $bindable(null) }: Props = $props();

// A composite: search text, a result list, and hidden coordinates — one value.
useControlRegistration(() => ({
  controlId: 'place',
  metadata: {
    kind: 'custom',
    label: 'Town location',
    valueSchema: {
      type: 'object',
      required: ['name', 'latitude', 'longitude'],
      properties: {
        name: { type: 'string' },
        latitude: { type: 'number' },
        longitude: { type: 'number' },
      },
    },
  },
  getValue: () => value,
  setValue: (next) => {
    value = next as Place;
  },
}));
</script>

<div class="place-picker"><span>{value?.name ?? 'Pick a town'}</span></div>

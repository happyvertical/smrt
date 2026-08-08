<script lang="ts">
import { Input } from '@happyvertical/smrt-ui/forms';
import type { FieldInputProps } from '../../types.js';

let { id, name, value, disabled, onvaluechange }: FieldInputProps = $props();
</script>

<Input
  {id}
  {name}
  value={String(value ?? '')}
  {disabled}
  aria-label="Registry name"
  oninput={(event) => onvaluechange((event.currentTarget as HTMLInputElement).value)}
/>

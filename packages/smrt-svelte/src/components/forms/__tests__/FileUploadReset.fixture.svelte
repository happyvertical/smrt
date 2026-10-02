<script lang="ts">
import FileUpload from '../FileUpload.svelte';

let {
  disabled = false,
  required = false,
  maxSize,
  onchange,
}: {
  disabled?: boolean;
  required?: boolean;
  maxSize?: number;
  onchange?: (files: File[]) => void;
} = $props();

let files = $state<File[]>([]);
</script>

<!-- A plain form with a bound list and a native reset button (#3260). -->
<form>
  <FileUpload name="doc" multiple {disabled} {required} {maxSize} {onchange} bind:files />
  <output data-testid="bound" data-files={files.map((file) => file.name).join(',')}></output>
  <button type="reset">Reset form</button>
</form>

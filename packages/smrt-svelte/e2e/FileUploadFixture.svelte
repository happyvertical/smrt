<script lang="ts">
import FileUpload from '../src/components/forms/FileUpload.svelte';
import '@happyvertical/smrt-ui/styles/tokens.css';

let docs = $state<File[]>([]);
let submits = $state(0);

function onsubmit(event: SubmitEvent) {
  event.preventDefault();
  submits += 1;
}
</script>

<form id="multi" method="post" enctype="multipart/form-data" {onsubmit}>
  <FileUpload name="docs" multiple required maxSize={1000} bind:files={docs} label="Documents" />
  <button type="button" id="reset" onclick={() => (docs = [])}>Reset</button>
  <button type="reset" id="native-reset">Reset form</button>
  <output id="submits">{submits}</output>
</form>

<form id="single" method="post" enctype="multipart/form-data">
  <FileUpload name="photo" accept="image/*" capture="environment" label="Photo" />
</form>

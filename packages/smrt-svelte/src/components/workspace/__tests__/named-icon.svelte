<script lang="ts">
/** Test icon that exposes the requested icon name as `data-icon`. */
interface Props {
  name: string;
  size?: number;
}
let { name, size = 18 }: Props = $props();
</script>

<svg data-icon={name} width={size} height={size} aria-hidden="true"></svg>

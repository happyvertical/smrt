<script lang="ts">
import Accordion from '../Accordion.svelte';
import AccordionItem from '../AccordionItem.svelte';
import Disclosure from '../Disclosure.svelte';
import Popover from '../Popover.svelte';
</script>

<Popover label="Filters"><p>Filter controls</p></Popover>
<Disclosure title="Details"><p>Disclosure details</p></Disclosure>
<Accordion>
  <AccordionItem value="one" title="First section"><p>First content</p></AccordionItem>
  <AccordionItem value="two" title="Second section"><p>Second content</p></AccordionItem>
</Accordion>

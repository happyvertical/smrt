<script lang="ts">
import { Button } from '@happyvertical/smrt-ui/ui';
import PurchaseOrderEditor from '../src/svelte/components/PurchaseOrderEditor.svelte';
let fingerprint=$state('review-1');
</script>
<Button onclick={()=>{fingerprint='review-2';}}>Receive replacement review</Button>
<PurchaseOrderEditor source={{id:'source-1',label:'Quote',vendor:'Acme'}} currency="CAD" minorUnitDigits={2} values={{instrument:'purchase-order',tax:'0',scope:'Design',inclusions:'',exclusions:'',reason:'Reason',allocations:[{id:'a',label:'Design',amount:'0',retained:true}]}} instruments={[{value:'purchase-order',label:'Purchase order'}]} action="/unused" review={{fingerprint,sourceLabel:'Acme / Quote',total:{currency:'CAD',minorUnitDigits:2,amountMinor:0},taxMinor:0,scope:'Design'}} />

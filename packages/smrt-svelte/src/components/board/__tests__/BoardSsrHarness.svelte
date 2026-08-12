<script lang="ts">
import Board from '../Board.svelte';
import type { BoardColumn } from '../types.js';

interface SalesCard {
  id: string;
  company: string;
  stage: string;
}

const columns: BoardColumn[] = [
  { id: 'lead', label: 'Lead' },
  { id: 'won', label: 'Won' },
];
const cards: SalesCard[] = [{ id: 'sale-1', company: 'Acme', stage: 'lead' }];
</script>

{#snippet salesCard({ card }: { card: SalesCard; column: BoardColumn; index: number; isDragging: boolean })}
  <strong>{card.company}</strong>
{/snippet}

<Board
  {columns}
  defaultCards={cards}
  getCardColumnId={(card) => card.stage}
  setCardColumnId={(card, stage) => ({ ...card, stage })}
  getCardLabel={(card) => card.company}
  card={salesCard}
  label="Sales pipeline"
/>

import type { Meta, StoryObj } from '@storybook/svelte';
import Card from './Card.svelte';

const meta = {
  title: 'UI/Card',
  component: Card,
  tags: ['autodocs'],
  argTypes: {
    variant: {
      control: 'select',
      options: ['default', 'outlined', 'elevated'],
    },
    padding: {
      control: 'select',
      options: ['none', 'sm', 'md', 'lg'],
    },
    hoverable: {
      control: 'boolean',
    },
  },
} satisfies Meta<Card>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  args: {
    variant: 'default',
    children: 'This is a default card with some content.' as any,
  },
};

export const Outlined: Story = {
  args: {
    variant: 'outlined',
    children: 'This is an outlined card.' as any,
  },
};

export const Elevated: Story = {
  args: {
    variant: 'elevated',
    children: 'This is an elevated card with shadow.' as any,
  },
};

export const Hoverable: Story = {
  args: {
    variant: 'default',
    hoverable: true,
    children: 'Hover over this card to see the effect' as any,
  },
};

export const SmallPadding: Story = {
  args: {
    variant: 'default',
    padding: 'sm',
    children: 'Card with small padding' as any,
  },
};

export const MediumPadding: Story = {
  args: {
    variant: 'default',
    padding: 'md',
    children: 'Card with medium padding (default)' as any,
  },
};

export const LargePadding: Story = {
  args: {
    variant: 'default',
    padding: 'lg',
    children: 'Card with large padding' as any,
  },
};

export const NoPadding: Story = {
  args: {
    variant: 'default',
    padding: 'none',
    children: 'Card with no padding' as any,
  },
};

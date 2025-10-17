import type { SidebarsConfig } from '@docusaurus/plugin-content-docs';

const sidebars: SidebarsConfig = {
  docsSidebar: [
    {
      type: 'doc',
      id: 'index',
      label: 'Introduction',
    },
    {
      type: 'category',
      label: '@smrt/core',
      link: { type: 'doc', id: 'core' },
      collapsed: true,
      items: [
        { type: 'link', label: 'Overview', href: '/core#overview' },
        { type: 'link', label: 'Key Features', href: '/core#key-features' },
        { type: 'link', label: 'Installation', href: '/core#installation' },
        { type: 'link', label: 'Usage', href: '/core#usage' },
        { type: 'link', label: 'Code Generation', href: '/core#code-generation' },
        { type: 'link', label: 'SMRT Advisor for Claude Code', href: '/core#smrt-advisor-for-claude-code' },
        { type: 'link', label: '📚 API Reference', href: '/api/core/globals' },
      ],
    },
    {
      type: 'category',
      label: '@smrt/gnode',
      link: { type: 'doc', id: 'gnode' },
      collapsed: true,
      items: [
        { type: 'link', label: 'Overview', href: '/gnode#overview' },
        { type: 'link', label: 'Installation', href: '/gnode#installation' },
        { type: 'link', label: 'Usage', href: '/gnode#usage' },
        { type: 'link', label: 'Features', href: '/gnode#features' },
        { type: 'link', label: 'Documentation', href: '/gnode#documentation' },
        { type: 'link', label: 'Related Packages', href: '/gnode#related-packages' },
        { type: 'link', label: '📚 API Reference', href: '/api/gnode/globals' },
      ],
    },
    {
      type: 'category',
      label: '@smrt/products',
      link: { type: 'doc', id: 'products' },
      collapsed: true,
      items: [
        { type: 'link', label: 'Quick Start', href: '/products#quick-start' },
        { type: 'link', label: 'Three Ways to Use This Service', href: '/products#three-ways-to-use-this-service' },
        { type: 'link', label: 'What\'s Auto-Generated', href: '/products#whats-auto-generated' },
        { type: 'link', label: 'Project Structure', href: '/products#project-structure' },
        { type: 'link', label: 'Development Commands', href: '/products#development-commands' },
        { type: 'link', label: 'How It Works', href: '/products#how-it-works' },
        { type: 'link', label: '📚 API Reference', href: '/api/products/globals' },
      ],
    },
  ],
};

export default sidebars;

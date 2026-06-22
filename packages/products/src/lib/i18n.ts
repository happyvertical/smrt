import { defineMessages } from '@happyvertical/smrt-ui/i18n';

export const M = defineMessages({
  // App
  'products.app.categories_coming_soon': 'Category management coming soon...',
  'products.app.analytics_coming_soon': 'Analytics dashboard coming soon...',

  // AppLayout
  'products.app_layout.service_title': 'Product Service',
  'products.app_layout.footer_copyright':
    '2024 SMRT Product Service - Auto-generated with ❤️',
  'products.app_layout.api_docs': 'API Docs',
  'products.app_layout.mcp_tools': 'MCP Tools',

  // DemoPage
  'products.demo_page.title': 'SMRT Framework Demo',
  'products.demo_page.subtitle':
    'Define Once, Consume Everywhere - Progressive Customization',
  'products.demo_page.custom_components_tab': 'Custom Components',
  'products.demo_page.auto_generated_heading':
    'Auto-Generated UI from SMRT Object',
  'products.demo_page.auto_generated_description':
    'This form is automatically generated from the Product class definition.\n          The field types, labels, and validation rules are inferred from the TypeScript schema.',
  'products.demo_page.generated_form_heading': 'Generated Form',
  'products.demo_page.auto_form_title': 'Auto-Generated Product Form',
  'products.demo_page.generated_display_heading': 'Generated Display',
  'products.demo_page.custom_components_heading':
    'Custom Components with SMRT Integration',
  'products.demo_page.custom_components_description':
    'These are hand-crafted components that still leverage the SMRT data structure\n          but provide custom UI/UX for specific business requirements.',
  'products.demo_page.custom_form_heading': 'Custom Form',
  'products.demo_page.custom_display_heading': 'Custom Display',
  'products.demo_page.progressive_heading': 'Progressive Customization',
  'products.demo_page.progressive_description':
    'Start with auto-generated components, then progressively customize as needed.\n          Both approaches use the same underlying SMRT Product model.',
  'products.demo_page.feature_zero_config': '✅ Zero configuration',
  'products.demo_page.feature_instant_ui': '✅ Instant UI from schema',
  'products.demo_page.feature_type_safe': '✅ Type-safe by default',
  'products.demo_page.feature_prototyping': '⚡ Perfect for prototyping',
  'products.demo_page.custom_components_label': '🎨 Custom Components',
  'products.demo_page.feature_tailored_ux': '✅ Tailored UX',
  'products.demo_page.feature_business_workflows':
    '✅ Business-specific workflows',
  'products.demo_page.feature_advanced_interactions':
    '✅ Advanced interactions',
  'products.demo_page.simple_auto_form_title': 'Auto Form',
  'products.demo_page.benefits_heading': 'SMRT Framework Benefits',
  'products.demo_page.benefit_define_once_label': 'Define Once:',
  'products.demo_page.benefit_define_once_text':
    'Product class with @smrt decorator',
  'products.demo_page.benefit_auto_generate_label': 'Auto-Generate:',
  'products.demo_page.benefit_auto_generate_text':
    'REST APIs, MCP tools, TypeScript clients, default UI',
  'products.demo_page.benefit_progressive_label': 'Progressive Enhancement:',
  'products.demo_page.benefit_progressive_text':
    'Start with defaults, customize as needed',
  'products.demo_page.benefit_type_safety_label': 'Type Safety:',
  'products.demo_page.benefit_type_safety_text':
    'End-to-end TypeScript integration',
  'products.demo_page.benefit_multiple_consumption_label':
    'Multiple Consumption:',
  'products.demo_page.benefit_multiple_consumption_text':
    'Library, federation, standalone',

  // ProductsPage
  'products.products_page.description':
    'Manage your product catalog with auto-generated CRUD operations, \n          real-time updates, and AI-powered tools via MCP.',
  'products.products_page.auto_generated_text':
    'REST API endpoints automatically created from @smrt() decorated Product class',
  'products.products_page.ai_ready_heading': '🤖 AI Ready',
  'products.products_page.ai_ready_text':
    'MCP tools available for Claude and other AI models to interact with products',
  'products.products_page.federatable_text':
    'Components can be consumed by other applications via module federation',
  'products.products_page.library_text':
    'Install as NPM package: npm install @have/smrt-template',

  // ProductForm
  'products.product_form.name_label': 'Product Name *',
  'products.product_form.name_placeholder': 'Enter product name',
  'products.product_form.description_placeholder':
    'Product description (optional)',
  'products.product_form.category_placeholder': 'Product category',
  'products.product_form.tags_placeholder': 'tag1, tag2, tag3',
  'products.product_form.tags_hint': 'Separate tags with commas',
  'products.product_form.in_stock_label': 'In Stock',

  // TestComponent
  'products.test_component.title': 'Test Component',

  // AutoForm
  'products.auto_form.subtitle': 'Auto-generated from SMRT Product model',
  'products.auto_form.debug_summary': 'Form Data (Debug)',

  // FieldRenderer
  'products.field_renderer.array_hint': 'Enter values separated by commas',
  'products.field_renderer.object_hint': 'Enter valid JSON',

  // CategoryManager
  'products.category_manager.title': 'Category Manager',
  'products.category_manager.subtitle': 'Manage product categories',
  'products.category_manager.coming_soon':
    'Category management feature coming soon...',
  'products.category_manager.will_include': 'This will include:',
  'products.category_manager.create_edit': 'Create and edit categories',
  'products.category_manager.organize_hierarchy': 'Organize category hierarchy',
  'products.category_manager.manage_permissions': 'Manage category permissions',
  'products.category_manager.analytics': 'Category analytics',

  // ProductCatalog
  'products.product_catalog.title': 'Product Catalog',
  'products.product_catalog.in_stock': 'in stock',
  'products.product_catalog.total_value': 'Total value:',
  'products.product_catalog.search_placeholder': 'Search products...',
  'products.product_catalog.all_categories': 'All Categories',
  'products.product_catalog.add_product': 'Add Product',
  'products.product_catalog.loading': 'Loading products...',
  'products.product_catalog.empty':
    'No products yet. Create your first product to get started!',
  'products.product_catalog.create_first': 'Create First Product',
  'products.product_catalog.no_match':
    'No products match your search criteria.',
});

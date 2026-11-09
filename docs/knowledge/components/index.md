# Components

* [@happyvertical/smrt-ads](/components/smrt-ads.md) - Advertising delivery and tracking models for SMRT framework
* [@happyvertical/smrt-affiliates](/components/smrt-affiliates.md) - DEPRECATED compatibility shim over @happyvertical/smrt-sales — re-exports the legacy Partner/Commission/Payout names. See MIGRATION.md.
* [@happyvertical/smrt-agents](/components/smrt-agents.md) - Agent framework for building autonomous actors in the SMRT ecosystem
* [@happyvertical/smrt-analytics](/components/smrt-analytics.md) - Analytics integration models for SMRT framework
* [@happyvertical/smrt-android](/components/smrt-android.md) - Android Compose foundation for SMRT mobile apps: MobileTheme design tokens, the bottom-tab shell scaffold bound to smrt-mobile's MobileShellState, and the native platform adapters (ML Kit barcode, speech transcription, Gemini Nano on-device LLM, device capabilities, SQLDelight driver, Keystore auth storage, Custom Tabs auth launcher)
* [@happyvertical/smrt-app-cli](/components/smrt-app-cli.md) - Reusable CLI factory for SMRT apps — branded `<name> <resource> <command>` CLI + stdio MCP bridge with decorator-driven resource discovery
* [@happyvertical/smrt-app-mcp](/components/smrt-app-mcp.md) - App-runtime MCP server scaffolding for SMRT apps — `createMcpAppServer` plus transport adapters (SvelteKit today) for exposing a SMRT app's MCP surface over HTTP.
* [@happyvertical/smrt-app-runtime](/components/smrt-app-runtime.md) - Validated local, self-hosted, and cloud runtime composition for s-m-r-t applications
* [@happyvertical/smrt-approvals](/components/smrt-approvals.md) - Approval decision gate for the SMRT framework: revision-bound, single-use approvals with quorum, expiry, and an append-only event ledger
* [@happyvertical/smrt-assets-ergot](/components/smrt-assets-ergot.md) - Ergot-backed processing, search, and workflow adapter for SMRT assets
* [@happyvertical/smrt-assets-local](/components/smrt-assets-local.md) - Local image metadata and variant processor for SMRT assets
* [@happyvertical/smrt-assets](/components/smrt-assets.md) - Asset management system with versioning, metadata, and AI-powered operations for SMRT framework
* [@happyvertical/smrt-bookings](/components/smrt-bookings.md) - Operator-managed service reservations for SMRT
* [@happyvertical/smrt-bundle-gate](/components/smrt-bundle-gate.md) - Consumer bundle reachability and size regression gate for SMRT packages
* [@happyvertical/smrt-chat](/components/smrt-chat.md) - Chat rooms, DMs, threads, and agent conversations for the SMRT framework
* [@happyvertical/smrt-cli](/components/smrt-cli.md) - Developer CLI for SMRT framework - introspection, testing, and project management
* [@happyvertical/smrt-comments](/components/smrt-comments.md) - Record comments and mention hooks for SMRT applications
* [@happyvertical/smrt-commerce](/components/smrt-commerce.md) - Commerce models for the SMRT framework - contracts, fulfillments, payments
* [@happyvertical/smrt-config](/components/smrt-config.md) - Centralized configuration management for SMRT modules
* [@happyvertical/smrt-content](/components/smrt-content.md) - Content processing module for SMRT framework - handles documents, web content, and media
* [@happyvertical/smrt-core](/components/smrt-core.md) - Core SMRT framework for business objects, persistence, and generated REST, CLI, MCP, and AI interfaces
* [@happyvertical/smrt-desktop-launcher](/components/smrt-desktop-launcher.md) - Launcher core for SMRT desktop assistant plugins: injected provider, fixed diagnostics and stdio lifecycle
* [@happyvertical/smrt-desktop](/components/smrt-desktop.md) - Versioned sidecar manifest, installed-product contract and runtime bundler for SMRT desktop apps, plus the EXPERIMENTAL supervisor rendezvous (b) and native credential handoff (c) contracts, whose Rust shell half is not built
* [@happyvertical/smrt-dev-mcp](/components/smrt-dev-mcp.md) - Development MCP server for SMRT framework knowledge, review context, architecture context, and code generation
* [@happyvertical/smrt-education](/components/smrt-education.md) - Tenant-aware learning catalog models and authorized catalog access for SMRT
* [@happyvertical/smrt-events](/components/smrt-events.md) - Hierarchical event management with participant tracking and SMRT framework support
* [@happyvertical/smrt-expenses](/components/smrt-expenses.md) - Expense records for the SMRT framework - reviewed costs against a cost object, deduplicated receipts, and commitment drawdown
* [@happyvertical/smrt-facts](/components/smrt-facts.md) - Distributed memory and knowledge management with provenance tracking for SMRT framework
* [@happyvertical/smrt-features](/components/smrt-features.md) - Code-first feature flags and tenant-aware overrides for the SMRT framework
* [@happyvertical/smrt-fields](/components/smrt-fields.md) - Layered field policy store and resolver (defaults, visibility tiers, help text) for SMRT objects
* [@happyvertical/smrt-gnode](/components/smrt-gnode.md) - SMRT federation library for building federated local knowledge bases (gnodes)
* [@happyvertical/smrt-human-resources](/components/smrt-human-resources.md) - HR records for the SMRT framework: who works for an organization, as what, and with what standing — employment with dated terms, and qualifications with expiry
* [@happyvertical/smrt-images](/components/smrt-images.md) - Image asset management with AI-powered categorization, search, editing, and metadata extraction for SMRT framework
* [@happyvertical/smrt-inference](/components/smrt-inference.md) - Inference alias chains with classified failures, recorded fallback and ladder degradation, consumer-defined fusions, per-user and per-tenant bindings, the InferenceSettingsPanel, hosted provisioning and spend gate, and the smrt doctor --ai binding check, for SMRT inference tiers
* [@happyvertical/smrt-ingestion](/components/smrt-ingestion.md) - Durable tenant-scoped intake and evidence foundations
* [@happyvertical/smrt-inventory](/components/smrt-inventory.md) - Multi-location stock tracking for the SMRT framework — Sku, InventoryLocation, StockLevel, StockMovement, lot and serial tracking, and stock-mutation and lot services
* [@happyvertical/smrt-ios](/components/smrt-ios.md) - SwiftUI foundation for SMRT mobile apps: MobileTheme design tokens, the tab shell scaffold bound to smrt-mobile's MobileShellState, and the native platform adapters (VisionKit barcode, Speech transcription, Foundation Models on-device LLM, device capabilities, SQLDelight native driver, Keychain auth storage, ASWebAuthenticationSession auth launcher) — actually consuming the exported SmrtMobile KMP framework
* [@happyvertical/smrt-jobs](/components/smrt-jobs.md) - Background job processing for SMRT objects with persistence and scheduling
* [@happyvertical/smrt-languages](/components/smrt-languages.md) - Code-first language strings with config + tenant overrides and AI auto-translation for SMRT
* [@happyvertical/smrt-ledgers](/components/smrt-ledgers.md) - Double-entry accounting ledger for the SMRT framework
* [@happyvertical/smrt-manufacturing](/components/smrt-manufacturing.md) - Bills of materials, cost rollup, and production-order operations for the SMRT framework — strictly industry-neutral
* [@happyvertical/smrt-marketing](/components/smrt-marketing.md) - Cross-channel campaign coordination, immutable performance evidence, budget pacing, and reusable Svelte marketing surfaces for SMRT
* [@happyvertical/smrt-mcp-apps](/components/smrt-mcp-apps.md) - Framework-neutral browser bridge for portable MCP Apps
* [@happyvertical/smrt-mcp-conformance-fixture](/components/smrt-mcp-conformance-fixture.md) - Workspace package @happyvertical/smrt-mcp-conformance-fixture
* [@happyvertical/smrt-mcp-openai](/components/smrt-mcp-openai.md) - Optional OpenAI navigation and settings for authorized SMRT MCP Apps
* [@happyvertical/smrt-messages](/components/smrt-messages.md) - Unified multi-channel messaging with STI-based hierarchies
* [@happyvertical/smrt-mobile-contract](/components/smrt-mobile-contract.md) - SMRT mobile contract codegen: manifest + allowlist → mobile-contract.json → Kotlin/Swift DTOs, plus the generated framework contract for @happyvertical/smrt-mobile
* [@happyvertical/smrt-mobile](/components/smrt-mobile.md) - Kotlin Multiplatform shared mobile foundation for SMRT apps: durable SQLDelight offline write-queue, offline pack store + integrity, evidence capture model, pack i18n resolver, shell state, and platform adapter contracts (auth and networking land in later phases)
* [@happyvertical/smrt-personas](/components/smrt-personas.md) - Tenant-owned, context-scoped agent personas and resolution for the SMRT framework
* [@happyvertical/smrt-places](/components/smrt-places.md) - Hierarchical place management with geo integration and SMRT framework support
* [@happyvertical/smrt-planner](/components/smrt-planner.md) - The smrt planner as a mountable Svelte component with a typed command set and plan snapshot.
* [@happyvertical/smrt-playbooks](/components/smrt-playbooks.md) - Layered playbook registry, app/tenant overrides, and plan resolution for SMRT agents
* [@happyvertical/smrt-playground](/components/smrt-playground.md) - Shared playground discovery, runtime, and host components for SMRT UI packages
* [@happyvertical/smrt-preferences](/components/smrt-preferences.md) - Tenant defaults and per-user overrides for user-interface preferences (overview layouts, shell layout), validated per registered kind
* [@happyvertical/smrt-products](/components/smrt-products.md) - SMRT products module: triple-purpose microservice template for standalone apps, federated modules, and NPM libraries
* [@happyvertical/smrt-profiles](/components/smrt-profiles.md) - Profile management system with relationships, metadata, and reciprocal associations for SMRT framework
* [@happyvertical/smrt-projects](/components/smrt-projects.md) - Provider-agnostic project management models (Issues, PRs, Repositories, Projects) for SMRT framework
* [@happyvertical/smrt-prompts](/components/smrt-prompts.md) - Typed prompt registry, override resolution, and tenant-aware prompt settings for SMRT
* [@happyvertical/smrt-properties](/components/smrt-properties.md) - Digital property and zone management models for SMRT framework
* [@happyvertical/smrt-reactions](/components/smrt-reactions.md) - Tenant-scoped reactions and lightweight polls with shared participation enforcement
* [@happyvertical/smrt-reports](/components/smrt-reports.md) - Materialized aggregate report models for SMRT
* [@happyvertical/smrt-sales](/components/smrt-sales.md) - Modular sales for the SMRT framework: agreement execution, CRM, referral intake, neutral commissions, and reusable Svelte surfaces
* [@happyvertical/smrt-scanner](/components/smrt-scanner.md) - High-performance TypeScript scanner using OXC for SMRT manifest generation
* [@happyvertical/smrt-secrets](/components/smrt-secrets.md) - Per-tenant secret management with envelope encryption for SMRT
* [@happyvertical/smrt-sites](/components/smrt-sites.md) - Site lifecycle management for multi-tenant SMRT networks
* [@happyvertical/smrt-social](/components/smrt-social.md) - Social media account management for multi-platform publishing in the SMRT ecosystem
* [@happyvertical/smrt-subscriptions](/components/smrt-subscriptions.md) - Tenant subscriptions, entitlement resolution, usage thresholds, and subscription UI for SMRT
* [@happyvertical/smrt-support](/components/smrt-support.md) - AI-first Support Cases: channel-neutral intake, lifecycle, routing, service targets, and service time for the SMRT framework
* [@happyvertical/smrt-svelte](/components/smrt-svelte.md) - Svelte 5 components for SMRT user management - auth, users, tenants, roles, permissions, groups
* [@happyvertical/smrt-tags](/components/smrt-tags.md) - Reusable tagging system with hierarchies, contexts, and multi-language support for SMRT framework
* [@happyvertical/smrt-template-site-static-json](/components/smrt-template-site-static-json.md) - Static community site template with JSON data storage and SMRT framework
* [@happyvertical/smrt-template-sveltekit](/components/smrt-template-sveltekit.md) - Minimal SvelteKit project template with s-m-r-t framework integration
* [@happyvertical/smrt-tenancy](/components/smrt-tenancy.md) - Production-ready multi-tenancy framework for SMRT with automatic tenant isolation and enforcement
* [@happyvertical/smrt-timesheets](/components/smrt-timesheets.md) - Shared time entries for the SMRT framework: who worked how long on what, approval and correction, with immutable charge and compensation snapshots
* [@happyvertical/smrt-types](/components/smrt-types.md) - Shared type definitions for the HAVE SDK
* [@happyvertical/smrt-ui](/components/smrt-ui.md) - Domain-agnostic Svelte 5 UI runtime for SMRT: primitives, i18n client, theme system, and module UI registry
* [@happyvertical/smrt-users](/components/smrt-users.md) - Multi-tenant user management for the SMRT framework - users, tenants, roles, permissions, groups
* [@happyvertical/smrt-vault-relay](/components/smrt-vault-relay.md) - Blind snapshot relay: device-signed, per-account encrypted blob store gated by backup.vault
* [@happyvertical/smrt-video](/components/smrt-video.md) - Video content management for AI-powered video production in the SMRT ecosystem
* [@happyvertical/smrt-vitest](/components/smrt-vitest.md) - Vitest plugin for automatic cross-package manifest loading in SMRT tests
* [@happyvertical/smrt-voice](/components/smrt-voice.md) - Voice profile management for AI-powered voice synthesis and cloning in the SMRT ecosystem
* [@happyvertical/smrt-web](/components/smrt-web.md) - SMRT browser client data runtime: typed collection factory wrapping the client-data engine over generated REST clients
* [@happyvertical/smrt-webhooks](/components/smrt-webhooks.md) - Outbound webhook subscriptions, signed delivery, and durable retries
* [@happyvertical/smrt-workbench](/components/smrt-workbench.md) - Shared SMRT package and project workbench

# Initial Concept

SMRT is a TypeScript framework for building vertical AI agents with automatic code generation, database persistence, and AI-powered operations.

# Product Guide - SMRT Framework

## Project Overview
The SMRT Framework is a TypeScript-first platform designed to streamline the creation of vertical AI agents. It bridges the gap between domain logic, data persistence, and AI intelligence by providing a cohesive set of tools for automated infrastructure and intelligent operations.

## Target Users
- **AI Engineers & Developers**: Specialists building vertical agents who need a robust foundation for integrating LLM capabilities directly into their business logic.

## Core Features
- **Automatic ORM**: Seamlessly generates database schemas directly from TypeScript classes, using a "0 vs 0.0" heuristic for type inference.
- **Multi-Interface Code Generation**: Automatically produces CLI tools, REST APIs (with OpenAPI/Swagger), and MCP (Model Context Protocol) servers from domain models.
- **Module Business Logic**: A modular architecture that encapsulates domain-specific logic into reusable, self-contained packages.
- **AI-Powered Operations**: Built-in `do()` and `is()` methods that allow objects to perform intelligent tasks and evaluations autonomously.

## Design Philosophy
- **AI-First**: The framework is built on the premise that LLM capabilities should be a first-class citizen in every object. Intelligence is not an add-on but a fundamental part of the domain model.
- **Minimal Boilerplate**: By leveraging TypeScript's type system and decorators, the framework reduces the manual work required to set up persistence and communication layers.
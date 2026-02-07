# elysia-treaty-docs

A TypeScript documentation generator for Elysia.js APIs. It analyzes your route types and generates comprehensive API documentation with SDK usage examples.

## Installation

```bash
bun install elysia-treaty-docs
# or
yarn add elysia-treaty-docs
# or
pnpm add elysia-treaty-docs
```

## Usage

```typescript
import { generateDocs } from "elysia-treaty-docs";

generateDocs({
  apps: [
    {
      name: "my-app",
      sourceFilesGlob: "src/**/*.ts", // Optional
      entryFile: "src/index.ts", // Optional
      typeAliasName: "App", // Optional
    },
  ],
  projectRoot: "/path/to/your/project",
  tsConfigFilePath: "/path/to/tsconfig.json", // Optional
  outputPath: "API_DOCS.md", // Optional
  title: "My API Documentation", // Optional
  description: "Documentation for my awesome API.", // Optional
});
```

## Options

### GenerateDocsOptions

- `apps`: Array of `AppConfig` objects defining the apps to document.
- `projectRoot`: Path to the project root.
- `tsConfigFilePath`: Path to the TypeScript config file (default: `"{projectRoot}/tsconfig.json"`).
- `outputPath`: Output file path (default: `"DOCS.md"`).
- `title`: Document title (default: `"API Documentation"`).
- `description`: Document description (default: `"This document contains API documentation for the configured apps."`).

### AppConfig

- `name`: Display name for the app.
- `sourceFilesGlob`: Glob pattern for source files (optional).
- `entryFile`: Path to the entry file containing the type alias.
- `typeAliasName`: Name of the type alias defining the routes (default: `"App"`).

## Requirements

- Your Elysia app must export a type alias (e.g., `export type App = ...`) that defines the route structure.
- The project must have a `tsconfig.json` file.

## Example

For an Elysia app like:

```typescript
import { Elysia } from "elysia";

const app = new Elysia()
  .get("/hello", () => "Hello World")
  .post("/users", ({ body }) => createUser(body), {
    body: t.Object({ name: string }),
  });

export type App = typeof app;
```

The generator will create documentation with SDK usage examples, request/response types, etc.

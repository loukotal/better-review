---
description: Use Node.js 24+ and pnpm.
globs: "*.ts, *.tsx, *.html, *.css, *.js, *.jsx, package.json"
alwaysApply: false
---

Default to Node.js 24+ with pnpm.

- Use `pnpm install` for dependencies.
- Use `pnpm run <script>` or `pnpm <script>` for package scripts.
- Use `pnpm exec tsx <file>` for TypeScript entrypoints that should run directly.
- Use `node --import tsx --test` for TypeScript tests.
- Prefer Node built-ins such as `node:fs/promises`, `node:child_process`, `node:http`, and `node:crypto`.
- Use Vite for the web package.

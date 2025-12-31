# Better Review

Local webapp for better GitHub code reviews.

## Tech Stack

- **Runtime:** Bun
- **Server:** Elysia + Effect
- **CLI:** `gh` (GitHub CLI) for GitHub operations
- **Frontend:** SolidJS + Tailwind
- **Diff Rendering:** @pierre/diffs (vanilla JS API)
- **Search:** ripgrep (`rg`) - future

## Development

```bash
cd packages/better-review
bun run dev
```

Open <http://localhost:3001>

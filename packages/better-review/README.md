# Better Review

Local webapp for better GitHub code reviews.

## Tech Stack

- **Runtime:** Bun
- **Server:** Elysia + Effect
- **CLI:** `gh` (GitHub CLI) for GitHub operations
- **Frontend:** SolidJS + Tailwind
- **Diff Rendering:** @pierre/diffs (vanilla JS API)
- **Search:** ripgrep (`rg`) - future

## Features & Tasks

### Phase 1: Frontend Setup

- [ ] Add SolidJS + Tailwind to `packages/better-review`
- [ ] Configure Bun HTML imports to serve the frontend
- [ ] Basic app shell

### Phase 2: PR Input & Loading

- [ ] Input component for PR URL or number
- [ ] Parse PR URL to extract owner/repo/number (or use number directly in current repo)
- [ ] Backend: `GET /api/pr?url=:urlOrNumber` - returns PR metadata + diff
- [ ] Backend: Expand GhService with `getPrMetadata()`, `getPrFiles()`, `getPrComments()`

### Phase 3: Diff Rendering

- [ ] Integrate `@pierre/diffs` vanilla JS `FileDiff` component
- [ ] File tree sidebar (list of changed files)
- [ ] Navigate between files
- [ ] Syntax highlighting (via Shiki, built into @pierre/diffs)

### Phase 4: Comments

- [ ] Display existing PR comments inline
- [ ] Post line-level comment (click on line -> comment form)
- [ ] Post general PR comment
- [ ] Backend: `POST /api/pr/:owner/:repo/:number/comments`
- [ ] Backend: GhService methods for posting comments via `gh` CLI

### Phase 5: Search (Future)

- [ ] ripgrep integration
- [ ] Search UI
- [ ] **Open question:** Search scope - CWD only or configurable?

### Phase 6: Local Diff (Future)

- [ ] Compare two local branches
- [ ] **Open question:** Support uncommitted changes (`git diff HEAD`)?

### Phase 7: OpenCode Integration (Future)

- [ ] AI-assisted review suggestions

## Project Structure

```
src/
  index.ts          # Elysia server
  gh/gh.ts          # GhService (Effect)
  runtime.ts        # Effect runtime
web/
  index.html        # Entry point (served by Bun)
  app.tsx           # SolidJS app root
  components/
    PrInput.tsx     # URL/number input
    DiffView.tsx    # Wrapper for @pierre/diffs FileDiff
    FileTree.tsx    # Sidebar with file list
    CommentForm.tsx # Inline comment form
  index.css         # Tailwind styles
```

## API Endpoints

```
GET  /api/pr?url=:urlOrNumber     # PR metadata + diff + comments
POST /api/pr/comments             # Post a comment
```

## Development

```bash
cd packages/better-review
bun run dev
```

Open http://localhost:3001

## Open Questions

- [ ] Local diff: Support uncommitted changes (`git diff HEAD`)?
- [ ] Search: CWD-only or allow specifying repo path?

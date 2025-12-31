# better-review

To install dependencies:

```bash
bun install
```

To run:

```bash
bun run index.ts
```

This project was created using `bun init` in bun v1.2.23. [Bun](https://bun.com) is a fast all-in-one JavaScript runtime.

## TODOs

- [ ] virtualization for large files - ~7k line file takes long time to load
- [ ] better handle SSE connection
- [ ] load opencode sessions based on PR link - allow switching between sessions if multiple exist
- [ ] handle "project knowledge base"
- [ ] simpler marks for warning/info UI elements & files (just use filenames instead of \[\[\]\])
